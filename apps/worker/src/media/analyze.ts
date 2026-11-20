import { join } from "node:path";
import { stat } from "node:fs/promises";
import { prisma } from "@socialith/database";
import type { MediaAssetKind, Prisma } from "@socialith/database";
import { libraryKeys } from "@socialith/media-pack";
import { makeThumbnail, probeMedia, ProbeError, type AssetStorage, type MediaFacts } from "@socialith/video-engine";

export interface AnalyzeContext {
  ffmpegPath: string;
  ffprobePath: string;
  /** The PRIVATE library storage. */
  storage: AssetStorage;
  /** Scratch directory the caller owns and removes. */
  workDir: string;
}

export interface AnalyzableAsset {
  id: string;
  organizationId: string;
  kind: MediaAssetKind;
  originalName: string;
}

const EXPECTED_FACT_KIND: Partial<Record<MediaAssetKind, MediaFacts["kind"]>> = { VIDEO: "video", IMAGE: "image", AUDIO: "audio" };

export type AnalyzeOutcome = { status: "READY"; warnings: string[] } | { status: "FAILED"; code: string; reason: string };

/**
 * Measures one stored file and makes its thumbnail. `localPath` is the file on local disk (already there during ZIP
 * extraction, downloaded by the caller otherwise) - the original in storage is never touched.
 *
 * Every fact written is measured by ffprobe; what it did not report stays null. A file that cannot be decoded, or whose
 * content is not the kind its extension claimed, ends as FAILED with a reason - never as a half-filled READY. A missing
 * ffprobe (a configuration problem, not a property of the file) is thrown so the task fails with the real cause and the
 * asset stays ANALYZING, ready to be analyzed again once FFmpeg is installed.
 */
export async function analyzeLocalAsset(ctx: AnalyzeContext, asset: AnalyzableAsset, localPath: string): Promise<AnalyzeOutcome> {
  const warnings: string[] = [];

  if (asset.kind === "TEXT" || asset.kind === "SPREADSHEET") {
    await prisma.mediaAsset.update({ where: { id: asset.id }, data: { status: "READY", analyzedAt: new Date(), rejectionCode: null, rejectionReason: null } });
    return { status: "READY", warnings };
  }

  const { size } = await stat(localPath);
  let facts: MediaFacts;
  try {
    facts = await probeMedia(ctx.ffprobePath, localPath, { sizeBytes: size });
  } catch (err) {
    if (err instanceof ProbeError && err.errorCode === "INVALID_MEDIA") return fail(asset.id, "NOT_DECODABLE", err.message);
    throw err;
  }

  const expected = EXPECTED_FACT_KIND[asset.kind];
  if (expected && facts.kind !== expected) {
    const found = facts.kind === "unknown" ? "no recognisable media" : `${facts.kind} content`;
    return fail(asset.id, "KIND_MISMATCH", `"${asset.originalName}" is a ${asset.kind.toLowerCase()} file by name but contains ${found}.`);
  }

  if (asset.kind === "IMAGE" || asset.kind === "VIDEO") {
    try {
      const thumbPath = join(ctx.workDir, `thumb-${asset.id}.jpg`);
      const thumb = await makeThumbnail(ctx.ffmpegPath, ctx.ffprobePath, localPath, thumbPath, { kind: asset.kind === "VIDEO" ? "video" : "image", durationMs: facts.durationMs });
      const key = libraryKeys.derivative(asset.organizationId, asset.id, "thumbnail", ".jpg");
      await ctx.storage.putFile(key, thumbPath, { contentType: "image/jpeg", overwrite: true });
      await prisma.mediaDerivative.upsert({
        where: { assetId_kind: { assetId: asset.id, kind: "THUMBNAIL" } },
        update: { storageKey: key, sizeBytes: thumb.sizeBytes, width: thumb.width, height: thumb.height },
        create: { assetId: asset.id, kind: "THUMBNAIL", storageKey: key, contentType: "image/jpeg", sizeBytes: thumb.sizeBytes, width: thumb.width, height: thumb.height },
      });
    } catch (err) {
      // the file itself is fine and measured; a missing thumbnail is reported, not hidden, and does not fail the asset
      warnings.push(`Thumbnail could not be created: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  await prisma.mediaAsset.update({
    where: { id: asset.id },
    data: {
      status: "READY",
      width: facts.width,
      height: facts.height,
      aspectRatio: facts.aspectRatio,
      aspectDecimal: facts.aspectDecimal,
      durationMs: facts.durationMs,
      fps: facts.fps,
      videoCodec: facts.videoCodec,
      audioCodec: facts.audioCodec,
      hasAudio: facts.kind === "image" ? null : facts.hasAudio,
      bitrateKbps: facts.bitrateKbps,
      container: facts.container,
      sampleRate: facts.sampleRate,
      channels: facts.channels,
      facts: { ...facts, warnings } as unknown as Prisma.InputJsonValue,
      analyzedAt: new Date(),
      rejectionCode: null,
      rejectionReason: null,
    },
  });
  return { status: "READY", warnings };
}

async function fail(assetId: string, code: string, reason: string): Promise<AnalyzeOutcome> {
  await prisma.mediaAsset.update({ where: { id: assetId }, data: { status: "FAILED", rejectionCode: code, rejectionReason: reason, analyzedAt: new Date() } });
  return { status: "FAILED", code, reason };
}
