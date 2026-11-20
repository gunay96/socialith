import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import multer from "multer";
import type { Request, RequestHandler } from "express";
import { prisma } from "@socialith/database";
import type { MediaAssetKind } from "@socialith/database";
import { ACCEPTED_EXTENSIONS, HEAD_BYTES, fileTypeFor, libraryKeys, readHead, sha256File, validateUpload } from "@socialith/media-pack";
import { ERROR_CODES } from "@socialith/types";
import { ApiHttpError } from "../middleware/error-handler.js";
import { enqueueMediaProcessing, QueueUnavailableError } from "../lib/queue.js";
import { createAuditLog } from "../repositories/audit-log.repository.js";
import type { SafeUser } from "../types/auth.js";
import { ASSET_INCLUDE, assetDto, conflict, emptyCounts, invalidMedia, libraryStorage, mediaLimits, notFound, packDto } from "./media-common.js";
import { createTask, taskDto } from "./operation-task.service.js";

/** Uploads are streamed to this directory (never into memory) under server-generated names, and removed after each request. */
export const UPLOAD_TMP_DIR = join(tmpdir(), "socialith-uploads");

/** Why a file was skipped by the filter; the handler turns it into a clear 400 (the body is still drained, so the client sees the answer). */
const rejectedByFilter = new WeakMap<Request, string>();

const limits = mediaLimits();
const uploader = multer({
  storage: multer.diskStorage({
    destination(_req, _file, cb) {
      mkdirSync(UPLOAD_TMP_DIR, { recursive: true });
      cb(null, UPLOAD_TMP_DIR);
    },
    filename: (_req, _file, cb) => cb(null, `${randomUUID()}.upload`),
  }),
  limits: { fileSize: Math.max(limits.maxFileBytes, limits.maxArchiveBytes), files: 1, fields: 10, fieldSize: 4096 },
  fileFilter(req, file, cb) {
    if (!fileTypeFor(file.originalname)) {
      rejectedByFilter.set(req, `"${file.originalname}" is not a supported file type. Accepted: ${ACCEPTED_EXTENSIONS.join(", ")}.`);
      cb(null, false);
      return;
    }
    cb(null, true);
  },
}).single("file");

/** multer with its errors translated to the API's own error shape (413 for too large, 400 otherwise). */
export const mediaUpload: RequestHandler = (req, res, next) => {
  uploader(req, res, (err: unknown) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return next(invalidMedia(`The file is larger than the upload limit (${Math.max(limits.maxFileBytes, limits.maxArchiveBytes)} bytes).`, { code: "FILE_TOO_LARGE" }, 413));
      }
      return next(invalidMedia(`The upload was not accepted (${err.code}).`, { code: err.code }));
    }
    next(err);
  });
};

export interface UploadResult {
  duplicate: boolean;
  pack?: ReturnType<typeof packDto>;
  asset?: ReturnType<typeof assetDto>;
  task?: ReturnType<typeof taskDto>;
}

const KIND: Record<string, MediaAssetKind> = { VIDEO: "VIDEO", IMAGE: "IMAGE", AUDIO: "AUDIO", TEXT: "TEXT", SPREADSHEET: "SPREADSHEET" };

/**
 * Handles one uploaded file (already on disk, never in memory):
 *   1. the extension must be on the allow-list and the declared MIME type, and the file's own first bytes, must agree
 *   2. size limits, per type
 *   3. SHA-256 of the file, streamed
 *   4. a ZIP becomes a pack + a background extraction task; any other file becomes an asset + an analysis task
 * The original is stored once, by stream, under a server-generated key, and is never overwritten.
 */
export async function handleUpload(actor: SafeUser, req: Request): Promise<UploadResult> {
  const file = req.file;
  try {
    if (!file) throw invalidMedia(rejectedByFilter.get(req) ?? 'No file was sent. Send the file in a multipart field named "file".');
    const type = fileTypeFor(file.originalname);
    if (!type) throw invalidMedia(`"${file.originalname}" is not a supported file type.`);
    const body = (req.body ?? {}) as Record<string, string | undefined>;

    const maxBytes = type.kind === "ARCHIVE" ? limits.maxArchiveBytes : limits.maxFileBytes;
    const { size } = await stat(file.path);
    if (size > maxBytes) throw invalidMedia(`"${file.originalname}" is ${size} bytes; the limit for this file type is ${maxBytes}.`, { code: "FILE_TOO_LARGE" }, 413);

    const head = await readHead(file.path, HEAD_BYTES);
    const check = validateUpload(file.originalname, file.mimetype, head);
    if (!check.ok) throw invalidMedia(check.message, { code: check.code });

    const sha256 = await sha256File(file.path);
    return type.kind === "ARCHIVE" ? await uploadArchive(actor, file, size, sha256, body) : await uploadAsset(actor, file, size, sha256, check.info.kind, check.info.mime, body);
  } finally {
    if (file) await rm(file.path, { force: true }).catch(() => undefined);
  }
}

async function enqueueOrFail(taskId: string, data: Parameters<typeof enqueueMediaProcessing>[0], onFail: () => Promise<void>): Promise<void> {
  try {
    await enqueueMediaProcessing(data);
  } catch (err) {
    await prisma.operationTask.update({
      where: { id: taskId },
      data: { status: "FAILED", finishedAt: new Date(), errorCode: err instanceof QueueUnavailableError ? "CONFIGURATION_ERROR" : "ENQUEUE_FAILED", errorMessage: err instanceof Error ? err.message : "The job could not be queued.", errorRemedy: "Check that Redis and the worker are running, then upload again." },
    });
    await onFail();
    throw new ApiHttpError(503, ERROR_CODES.CONFIGURATION_ERROR, "Background processing is not available right now, so the file was not accepted. Check that Redis and the worker are running, then upload again.");
  }
}

async function uploadArchive(actor: SafeUser, file: Express.Multer.File, size: number, sha256: string, body: Record<string, string | undefined>): Promise<UploadResult> {
  // the same archive again: point at the earlier pack instead of repeating hours of work (force=true overrides)
  if (body.force !== "true") {
    const same = await prisma.mediaPack.findFirst({ where: { organizationId: actor.organizationId, sourceArchiveSha256: sha256, status: { in: ["PROCESSING", "READY", "PARTIAL"] } }, select: { id: true, name: true } });
    if (same) throw conflict(`This exact archive was already uploaded as the pack "${same.name}".`, { packId: same.id, hint: "Send force=true to process it again." });
  }
  const name = (body.packName ?? "").trim().slice(0, 120) || file.originalname.replace(/\.zip$/i, "").slice(0, 120) || "Untitled pack";
  const pack = await prisma.mediaPack.create({
    data: { organizationId: actor.organizationId, name, sourceType: "ZIP", sourceFileName: file.originalname.slice(0, 255), sourceArchiveBytes: BigInt(size), sourceArchiveSha256: sha256, status: "PROCESSING", createdById: actor.id },
  });
  const key = libraryKeys.archive(actor.organizationId, pack.id);
  await libraryStorage().putFile(key, file.path, { contentType: "application/zip" });
  await prisma.mediaPack.update({ where: { id: pack.id }, data: { sourceArchiveKey: key } });
  const task = await createTask(prisma, { organizationId: actor.organizationId, type: "MEDIA_ZIP_EXTRACT", subjectType: "MediaPack", subjectId: pack.id, queueName: "media-processing", createdById: actor.id, stage: "Queued", unit: "files" });
  await enqueueOrFail(task.id, { kind: "EXTRACT_ZIP", taskId: task.id, packId: pack.id }, async () => {
    await prisma.mediaPack.update({ where: { id: pack.id }, data: { status: "FAILED", errorCode: "CONFIGURATION_ERROR", errorMessage: "Background processing was not available.", completedAt: new Date() } });
  });
  await createAuditLog({ organizationId: actor.organizationId, userId: actor.id, action: "MEDIA_PACK_UPLOADED", targetType: "MediaPack", targetId: pack.id, metadata: { name, bytes: size, fileName: file.originalname } });
  const fresh = await prisma.mediaPack.findUniqueOrThrow({ where: { id: pack.id } });
  return { duplicate: false, pack: packDto(fresh, emptyCounts()), task: taskDto(task) };
}

async function uploadAsset(actor: SafeUser, file: Express.Multer.File, size: number, sha256: string, kind: string, mime: string, body: Record<string, string | undefined>): Promise<UploadResult> {
  let packId: string | null = null;
  if (body.packId) {
    const pack = await prisma.mediaPack.findFirst({ where: { id: body.packId, organizationId: actor.organizationId }, select: { id: true, status: true } });
    if (!pack) throw notFound("Pack");
    if (pack.status === "ARCHIVED") throw conflict("That pack is archived. Restore it before adding files.");
    packId = pack.id;
  }
  const data = { organizationId: actor.organizationId, packId, folderPath: "", originalName: file.originalname.slice(0, 255), kind: KIND[kind]!, mimeType: mime, sizeBytes: BigInt(size), sha256, createdById: actor.id };

  // exact same bytes as an asset we already hold: record the fact, store nothing
  const original = await prisma.mediaAsset.findFirst({ where: { organizationId: actor.organizationId, sha256, duplicateOfId: null, status: { in: ["READY", "ANALYZING", "FAILED"] } }, orderBy: { createdAt: "asc" }, select: { id: true } });
  if (original) {
    const dup = await prisma.mediaAsset.create({ data: { ...data, status: "DUPLICATE", duplicateOfId: original.id }, include: ASSET_INCLUDE });
    await createAuditLog({ organizationId: actor.organizationId, userId: actor.id, action: "MEDIA_ASSET_UPLOADED", targetType: "MediaAsset", targetId: dup.id, metadata: { duplicateOf: original.id } });
    return { duplicate: true, asset: assetDto(dup) };
  }

  const asset = await prisma.mediaAsset.create({ data: { ...data, status: "ANALYZING" } });
  const key = libraryKeys.original(actor.organizationId, asset.id, file.originalname);
  await libraryStorage().putFile(key, file.path, { contentType: mime });
  await prisma.mediaAsset.update({ where: { id: asset.id }, data: { storageKey: key } });
  const task = await createTask(prisma, { organizationId: actor.organizationId, type: "MEDIA_ANALYZE", subjectType: "MediaAsset", subjectId: asset.id, queueName: "media-processing", createdById: actor.id, stage: "Queued" });
  await enqueueOrFail(task.id, { kind: "ANALYZE_ASSET", taskId: task.id, assetId: asset.id }, async () => {
    await prisma.mediaAsset.update({ where: { id: asset.id }, data: { status: "FAILED", rejectionCode: "CONFIGURATION_ERROR", rejectionReason: "Background processing was not available; use Re-analyze once it is." } });
  });
  await createAuditLog({ organizationId: actor.organizationId, userId: actor.id, action: "MEDIA_ASSET_UPLOADED", targetType: "MediaAsset", targetId: asset.id, metadata: { kind, bytes: size, packId } });
  const fresh = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: asset.id }, include: ASSET_INCLUDE });
  return { duplicate: false, asset: assetDto(fresh), task: taskDto(task) };
}
