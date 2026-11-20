import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Job } from "bullmq";
import { loadEnv, resolveFfprobePath, resolveLibraryStorageConfig, resolveMediaLimits, type Env } from "@socialith/config";
import { prisma } from "@socialith/database";
import type { MediaAssetKind } from "@socialith/database";
import { extractZip, libraryKeys, scanZip, validateUpload, ZipLimitError, type ExtractedFile, type MediaLimits, type ScanEntry, type ZipErrorCode } from "@socialith/media-pack";
import type { MediaProcessingJobData } from "@socialith/types";
import { assertFfmpegAvailable, assertFfprobeAvailable, ProbeError, resolveAssetStorage, StorageKeyExistsError, type AssetStorage } from "@socialith/video-engine";
import { logger } from "../logger.js";
import { TaskReporter, type ReporterOptions } from "../tasks/reporter.js";
import { analyzeLocalAsset, type AnalyzeContext } from "./analyze.js";

export interface MediaDeps {
  env: Pick<Env, "FFMPEG_PATH" | "FFPROBE_PATH"> & Partial<Env>;
  storage: AssetStorage;
  limits: MediaLimits;
  reporter?: ReporterOptions;
  tmpRoot?: string;
}

export function defaultMediaDeps(): MediaDeps {
  const env = loadEnv();
  return { env, storage: resolveAssetStorage(resolveLibraryStorageConfig(env)), limits: resolveMediaLimits(env) };
}

/** What a person can do about each archive-level refusal. */
const ZIP_REMEDIES: Record<ZipErrorCode, string> = {
  ZIP_INVALID: "The file is damaged or is not a ZIP archive. Create the archive again from the original folder and upload it again.",
  ZIP_ARCHIVE_TOO_LARGE: "Split the content into several smaller ZIP files, or ask an administrator to raise MEDIA_MAX_ARCHIVE_BYTES.",
  ZIP_TOO_MANY_ENTRIES: "Split the content into several ZIP files, or ask an administrator to raise MEDIA_ZIP_MAX_ENTRIES.",
  ZIP_TOTAL_TOO_LARGE: "The archive unpacks to more data than allowed. Split it into smaller packs, or ask an administrator to raise MEDIA_ZIP_MAX_TOTAL_BYTES.",
  ZIP_RATIO_EXCEEDED: "The archive unpacks to far more data than its size suggests, which is how a ZIP bomb works. Do not use this file; export the media again with normal compression.",
  ZIP_BOMB_DETECTED: "The archive's own size information does not match what it contains. Do not use this file; create it again from the original files.",
  ZIP_UNSAFE_PATH: "The archive contains file paths that try to leave their folder. Do not use this file; create the archive again from the original folder.",
  ZIP_ABORTED: "The extraction was cancelled. Upload the archive again to retry.",
};

const ASSET_KIND: Record<string, MediaAssetKind> = { VIDEO: "VIDEO", IMAGE: "IMAGE", AUDIO: "AUDIO", TEXT: "TEXT", SPREADSHEET: "SPREADSHEET" };

async function withWorkDir<T>(deps: MediaDeps, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(deps.tmpRoot ?? tmpdir(), `socialith-media-${randomUUID().slice(0, 8)}-`));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function analyzeContext(deps: MediaDeps, workDir: string): AnalyzeContext {
  return { ffmpegPath: deps.env.FFMPEG_PATH, ffprobePath: deps.env.FFPROBE_PATH ?? resolveFfprobePath(deps.env as Env), storage: deps.storage, workDir };
}

/** BullMQ entry point: dispatches on the job kind. */
export async function processMediaJob(job: Job<MediaProcessingJobData>, deps: MediaDeps = defaultMediaDeps()): Promise<void> {
  const data = job.data;
  if (data.kind === "EXTRACT_ZIP") return extractPack(data.taskId, data.packId, deps);
  if (data.kind === "ANALYZE_ASSET") return analyzeAsset(data.taskId, data.assetId, deps);
  throw new Error(`Unknown media job: ${JSON.stringify(data)}`);
}

// ------------------------------------------------------------------------------------------------ one asset

export async function analyzeAsset(taskId: string, assetId: string, deps: MediaDeps): Promise<void> {
  const reporter = new TaskReporter(taskId, deps.reporter);
  await reporter.start({ stage: "Preparing", stageDetail: null, totalUnits: null });

  const asset = await prisma.mediaAsset.findUnique({ where: { id: assetId } });
  if (!asset || !asset.storageKey) {
    await reporter.fail({ code: "ASSET_NOT_FOUND", message: "The asset no longer exists or has no stored file.", remedy: "Upload the file again." });
    return;
  }
  if (asset.status === "ARCHIVED" || asset.status === "REJECTED" || asset.status === "DUPLICATE") {
    await reporter.fail({ code: "ASSET_NOT_ANALYZABLE", message: `This asset is ${asset.status.toLowerCase()} and cannot be analyzed.` });
    return;
  }

  await withWorkDir(deps, async (dir) => {
    try {
      if (asset.kind === "VIDEO" || asset.kind === "IMAGE" || asset.kind === "AUDIO") {
        await assertFfmpegAvailable(deps.env.FFMPEG_PATH);
        await assertFfprobeAvailable(deps.env.FFPROBE_PATH ?? resolveFfprobePath(deps.env as Env));
      }
      await reporter.stage("Reading the stored file", asset.originalName);
      const local = join(dir, `source${asset.originalName.slice(asset.originalName.lastIndexOf(".")).toLowerCase()}`);
      await deps.storage.downloadToFile(asset.storageKey!, local);
      await reporter.stage("Probing and creating the thumbnail", asset.originalName);
      const outcome = await analyzeLocalAsset(analyzeContext(deps, dir), { id: asset.id, organizationId: asset.organizationId, kind: asset.kind, originalName: asset.originalName }, local);
      if (outcome.status === "FAILED") await reporter.fail({ code: outcome.code, message: outcome.reason, remedy: "Replace the file with a valid one and upload it again." });
      else await reporter.succeed();
    } catch (err) {
      if (err instanceof ProbeError && err.errorCode === "CONFIGURATION_ERROR") {
        await reporter.fail({ code: "CONFIGURATION_ERROR", message: err.message, remedy: "An administrator must install FFmpeg (it includes ffprobe) on the worker, then use Re-analyze on this asset." });
        return; // a configuration problem is not retried by itself
      }
      if (err instanceof Error && err.name === "FfmpegUnavailableError") {
        await reporter.fail({ code: "CONFIGURATION_ERROR", message: err.message, remedy: "An administrator must install FFmpeg on the worker, then use Re-analyze on this asset." });
        return;
      }
      throw err;
    }
  });
}

// ------------------------------------------------------------------------------------------------ a ZIP pack

export async function extractPack(taskId: string, packId: string, deps: MediaDeps): Promise<void> {
  const reporter = new TaskReporter(taskId, deps.reporter);
  await reporter.start({ stage: "Reading the archive", stageDetail: null, totalUnits: null, unit: "files" });

  const pack = await prisma.mediaPack.findUnique({ where: { id: packId } });
  if (!pack || !pack.sourceArchiveKey) {
    await reporter.fail({ code: "PACK_NOT_FOUND", message: "The pack or its archive no longer exists.", remedy: "Upload the archive again." });
    return;
  }
  const task = await prisma.operationTask.findUnique({ where: { id: taskId }, select: { createdById: true } });
  const organizationId = pack.organizationId;

  const failPack = async (code: string, message: string, remedy: string) => {
    await prisma.mediaPack.update({ where: { id: packId }, data: { status: "FAILED", errorCode: code.slice(0, 64), errorMessage: message, completedAt: new Date() } });
    await reporter.fail({ code, message, remedy });
  };

  try {
    await assertFfmpegAvailable(deps.env.FFMPEG_PATH);
    await assertFfprobeAvailable(deps.env.FFPROBE_PATH ?? resolveFfprobePath(deps.env as Env));
  } catch (err) {
    await failPack("CONFIGURATION_ERROR", err instanceof Error ? err.message : "FFmpeg is not available.", "An administrator must install FFmpeg (it includes ffprobe) on the worker, then upload the archive again.");
    return;
  }

  await withWorkDir(deps, async (dir) => {
    const zipPath = join(dir, "archive.zip");
    await reporter.stage("Reading the stored archive");
    await deps.storage.downloadToFile(pack.sourceArchiveKey!, zipPath);

    await reporter.stage("Checking the archive for unsafe content");
    let scan;
    try {
      scan = await scanZip(zipPath, deps.limits);
    } catch (err) {
      if (err instanceof ZipLimitError) {
        await failPack(err.code, err.message, ZIP_REMEDIES[err.code]);
        return;
      }
      throw err;
    }

    // Units = every file entry that ends up as a row (extracted or rejected). The total is a real count from the archive.
    const total = scan.extractable + scan.rejected;
    await prisma.mediaPack.update({ where: { id: packId }, data: { entryCount: scan.entryCount, ignoredCount: scan.ignored } });
    await reporter.setTotal(total, "files");
    await reporter.stage("Extracting and analyzing", null);

    let completed = 0;
    const done = async (detail: string | null, stage = "Extracting and analyzing") => {
      completed++;
      // A re-run counts the entries it skips again from zero while the ledger already holds how far the earlier attempt
      // got: report the larger, so the bar never moves backwards.
      await reporter.progress(Math.max(completed, reporter.completedUnits), stage, detail);
    };
    const ctx = analyzeContext(deps, dir);

    const recordRejected = async (entryPath: string, entry: { fileName: string; folder: string }, code: string, reason: string, size = 0, sha = "") => {
      await prisma.mediaAsset.upsert({
        where: { packId_entryPath: { packId, entryPath } },
        update: {},
        create: { organizationId, packId, folderPath: entry.folder, originalName: entry.fileName || entryPath, entryPath, kind: "TEXT", status: "REJECTED", mimeType: "application/octet-stream", sizeBytes: BigInt(size), sha256: sha, rejectionCode: code.slice(0, 64), rejectionReason: reason, createdById: task?.createdById ?? null },
      });
    };

    let result;
    try {
      result = await extractZip(zipPath, dir, deps.limits, scan, {
      alreadyDone: async (entry: ScanEntry) => {
        const existing = entry.entryPath ? await prisma.mediaAsset.findUnique({ where: { packId_entryPath: { packId, entryPath: entry.entryPath } } }) : null;
        if (existing && existing.status !== "ANALYZING") {
          await done(entry.entryPath);
          return true;
        }
        return false;
      },
      onSkipped: async (entry: ScanEntry) => {
        const entryPath = entry.entryPath ?? `invalid-entry-${entry.index}`;
        await recordRejected(entryPath, { fileName: entry.fileName, folder: entry.folder }, entry.reject?.code ?? "REJECTED", entry.reject?.message ?? "This entry cannot be used.", entry.declaredBytes);
        await done(entryPath);
      },
      onFile: async (file: ExtractedFile) => {
        const validation = validateUpload(file.fileName, null, file.head);
        if (!validation.ok) {
          await recordRejected(file.entryPath, file, validation.code, validation.message, file.sizeBytes, file.sha256);
          await done(file.entryPath);
          return;
        }
        const existing = await prisma.mediaAsset.findUnique({ where: { packId_entryPath: { packId, entryPath: file.entryPath } } });
        const original = existing
          ? null
          : await prisma.mediaAsset.findFirst({
              where: { organizationId, sha256: file.sha256, duplicateOfId: null, status: { in: ["READY", "ANALYZING", "FAILED"] } },
              orderBy: { createdAt: "asc" },
              select: { id: true },
            });
        if (original) {
          // exact same bytes as an earlier asset: record the fact, store nothing
          await prisma.mediaAsset.create({
            data: { organizationId, packId, folderPath: file.folder, originalName: file.fileName, entryPath: file.entryPath, kind: ASSET_KIND[validation.info.kind]!, status: "DUPLICATE", mimeType: validation.info.mime, sizeBytes: BigInt(file.sizeBytes), sha256: file.sha256, duplicateOfId: original.id, createdById: task?.createdById ?? null },
          });
          await done(file.entryPath);
          return;
        }

        const asset =
          existing ??
          (await prisma.mediaAsset.create({
            data: { organizationId, packId, folderPath: file.folder, originalName: file.fileName, entryPath: file.entryPath, kind: ASSET_KIND[validation.info.kind]!, status: "ANALYZING", mimeType: validation.info.mime, sizeBytes: BigInt(file.sizeBytes), sha256: file.sha256, createdById: task?.createdById ?? null },
          }));
        if (!asset.storageKey) {
          const key = libraryKeys.original(organizationId, asset.id, file.fileName);
          try {
            await deps.storage.putFile(key, file.tempPath, { contentType: validation.info.mime });
          } catch (err) {
            // a previous attempt stored it before it was interrupted: the original is immutable, so this is the same file
            if (!(err instanceof StorageKeyExistsError)) throw err;
          }
          await prisma.mediaAsset.update({ where: { id: asset.id }, data: { storageKey: key } });
        }
        await reporter.stage("Extracting and analyzing", `Analyzing ${file.entryPath}`);
        await analyzeLocalAsset(ctx, { id: asset.id, organizationId, kind: asset.kind, originalName: asset.originalName }, file.tempPath);
        await done(file.entryPath);
      },
    });
    } catch (err) {
      // an archive that lies about its own sizes (or blows a limit while inflating) is hostile: a permanent failure, never retried
      if (err instanceof ZipLimitError) {
        await reporter.flush();
        await failPack(err.code, err.message, ZIP_REMEDIES[err.code]);
        return;
      }
      throw err;
    }

    await reporter.flush();
    const counts = await prisma.mediaAsset.groupBy({ by: ["status"], where: { packId }, _count: { _all: true } });
    const n = (s: string) => counts.find((c) => c.status === s)?._count._all ?? 0;
    const usable = n("READY") + n("ANALYZING");
    const problems = n("REJECTED") + n("FAILED");
    const status = usable === 0 && n("DUPLICATE") === 0 ? "FAILED" : problems > 0 ? "PARTIAL" : "READY";
    await prisma.mediaPack.update({
      where: { id: packId },
      data: {
        status,
        assetCount: usable,
        rejectedCount: n("REJECTED"),
        duplicateCount: n("DUPLICATE"),
        completedAt: new Date(),
        ...(status === "FAILED" ? { errorCode: "ZIP_NO_USABLE_FILES", errorMessage: "None of the files in this archive could be used." } : { errorCode: null, errorMessage: null }),
      },
    });
    logger.info({ packId, ...result, usable, problems }, "media-processing: archive finished");

    if (status === "FAILED") {
      await reporter.fail({ code: "ZIP_NO_USABLE_FILES", message: "None of the files in this archive could be used.", remedy: "Open the pack to see why each file was rejected (unsupported type, wrong content, too large), fix them and upload again." });
    } else {
      await reporter.succeed(completed);
    }
  });
}
