import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { prisma } from "@socialith/database";
import type { AssetType } from "@socialith/database";
import { loadEnv, resolveAssetStorageConfig } from "@socialith/config";
import { assertFfmpegAvailable, resolveAssetStorage, resolveVideoOperation } from "@socialith/video-engine";
import type { Job } from "bullmq";
import type { VideoRenderJobData } from "@socialith/types";
import { ERROR_CODES } from "@socialith/types";
import { logger } from "../logger.js";

async function downloadToTempFile(url: string, dir: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download source asset (${url}): ${res.status} ${res.statusText}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  const ext = extname(new URL(url).pathname) || ".bin";
  const path = join(dir, `source${ext}`);
  await writeFile(path, buffer);
  return path;
}

/**
 * Fires once per video-render job. Real work: download the source
 * ContentAsset (any reachable URL — today always our own /media route,
 * see content-asset-upload.service.ts), run real FFmpeg, store the real
 * output via @socialith/video-engine's local storage, and register it as
 * a new ContentAsset. No external credential is needed for any of this —
 * FFmpeg is a local binary — so unlike content-generation, this
 * pipeline's success path is fully real and exercisable here.
 *
 * On success, also flips Content.status DRAFT → GENERATED (only from
 * DRAFT, so this can't clobber a content item that's already moved past
 * that point) — schema.prisma's Content.status comment documents GENERATED
 * as meaning "after real video rendering", which this is.
 */
export async function processVideoRender(job: Job<VideoRenderJobData>): Promise<void> {
  const { jobRowId } = job.data;

  const jobRow = await prisma.videoRenderJob.findUnique({
    where: { id: jobRowId },
    include: { sourceAsset: true },
  });
  if (!jobRow) {
    logger.warn({ jobRowId }, "video-render: job row no longer exists, skipping");
    return;
  }
  if (jobRow.status === "SUCCEEDED" || jobRow.status === "FAILED") {
    logger.warn({ jobRowId, status: jobRow.status }, "video-render: job already in a terminal state, skipping");
    return;
  }

  await prisma.videoRenderJob.update({
    where: { id: jobRowId },
    data: { status: "PROCESSING", attempts: { increment: 1 }, startedAt: new Date() },
  });

  const env = loadEnv();
  let tempDir: string | undefined;
  try {
    await assertFfmpegAvailable(env.FFMPEG_PATH);

    // Dispatches through @socialith/video-engine's operation registry
    // (packages/video-engine/src/operations.ts) — THUMBNAIL is the only
    // one implemented today; adding RESIZE/CROP/SUBTITLES/etc. later means
    // registering a handler there, not touching this processor. An
    // operation schema.prisma's enum allows but that has no registered
    // handler is a real CONFIGURATION_ERROR, not a silent no-op.
    const operation = resolveVideoOperation(jobRow.operation);
    if (!operation) {
      const err = new Error(`No handler registered for render operation: ${jobRow.operation}`);
      (err as Error & { errorCode?: string }).errorCode = ERROR_CODES.CONFIGURATION_ERROR;
      throw err;
    }

    tempDir = await mkdtemp(join(tmpdir(), "socialith-render-"));
    const sourcePath = await downloadToTempFile(jobRow.sourceAsset.url, tempDir);
    const result = await operation({ ffmpegPath: env.FFMPEG_PATH, sourcePath, outputDir: tempDir });
    const outputBuffer = await readFile(result.outputPath);

    const storage = resolveAssetStorage(resolveAssetStorageConfig(env));
    const key = `${jobRow.organizationId}/${jobRow.contentId}/${randomUUID()}${extname(result.outputPath)}`;
    const stored = await storage.upload(key, outputBuffer, result.contentType);

    const resultAsset = await prisma.contentAsset.create({
      data: {
        contentId: jobRow.contentId,
        type: result.assetType as AssetType,
        platform: jobRow.sourceAsset.platform,
        url: stored.url,
        metadata: { storageKey: stored.key, sourceAssetId: jobRow.sourceAssetId, renderJobId: jobRow.id },
      },
    });

    await prisma.$transaction([
      prisma.videoRenderJob.update({
        where: { id: jobRowId },
        data: { status: "SUCCEEDED", resultAssetId: resultAsset.id, errorMessage: null, completedAt: new Date() },
      }),
      prisma.content.updateMany({ where: { id: jobRow.contentId, status: "DRAFT" }, data: { status: "GENERATED" } }),
    ]);
    logger.info({ jobRowId, resultAssetId: resultAsset.id }, "video-render: succeeded");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const errorCode = err instanceof Error ? (err as Error & { errorCode?: string }).errorCode ?? null : null;
    await prisma.videoRenderJob.update({ where: { id: jobRowId }, data: { errorMessage: message, errorCode } }).catch(() => {});
    throw err; // let BullMQ's attempts/backoff retry a genuinely transient failure
  } finally {
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}
