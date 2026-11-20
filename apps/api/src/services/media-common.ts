import { loadEnv, resolveLibraryStorageConfig, resolveMediaLimits } from "@socialith/config";
import type { MediaAsset, MediaAssetTag, MediaDerivative, MediaPack, Prisma } from "@socialith/database";
import { ERROR_CODES } from "@socialith/types";
import type { MediaLimits } from "@socialith/media-pack";
import { resolveAssetStorage, type AssetStorage } from "@socialith/video-engine";
import { ApiHttpError } from "../middleware/error-handler.js";

let storage: AssetStorage | null = null;
/** The PRIVATE library storage (never the public media storage). Resolved once. */
export function libraryStorage(): AssetStorage {
  storage ??= resolveAssetStorage(resolveLibraryStorageConfig(loadEnv()));
  return storage;
}

export function mediaLimits(): MediaLimits {
  return resolveMediaLimits(loadEnv());
}

export const notFound = (what: string) => new ApiHttpError(404, ERROR_CODES.NOT_FOUND, `${what} not found.`);
export const conflict = (message: string, details?: unknown) => new ApiHttpError(409, ERROR_CODES.CONFLICT, message, details);
export const invalidMedia = (message: string, details?: unknown, status = 400) => new ApiHttpError(status, ERROR_CODES.INVALID_MEDIA, message, details);

export type AssetWithRelations = MediaAsset & {
  tags?: MediaAssetTag[];
  derivatives?: MediaDerivative[];
  pack?: Pick<MediaPack, "id" | "name"> | null;
  duplicateOf?: Pick<MediaAsset, "id" | "originalName"> | null;
};

const TEXTUAL: ReadonlySet<string> = new Set(["TEXT", "SPREADSHEET"]);

/** What the interface may know about an asset. Storage keys never leave the server. */
export function assetDto(a: AssetWithRelations) {
  const thumb = a.derivatives?.find((d) => d.kind === "THUMBNAIL");
  return {
    id: a.id,
    packId: a.packId,
    pack: a.pack ? { id: a.pack.id, name: a.pack.name } : null,
    folderPath: a.folderPath,
    originalName: a.originalName,
    entryPath: a.entryPath,
    kind: a.kind,
    status: a.status,
    mimeType: a.mimeType,
    sizeBytes: Number(a.sizeBytes),
    sha256: a.sha256,
    duplicateOf: a.duplicateOf ? { id: a.duplicateOf.id, originalName: a.duplicateOf.originalName } : a.duplicateOfId ? { id: a.duplicateOfId, originalName: null } : null,
    rejection: a.rejectionCode ? { code: a.rejectionCode, reason: a.rejectionReason } : null,
    // measured facts: null = ffprobe did not report it (never a default)
    facts: {
      width: a.width,
      height: a.height,
      aspectRatio: a.aspectRatio,
      aspectDecimal: a.aspectDecimal,
      durationMs: a.durationMs,
      fps: a.fps,
      videoCodec: a.videoCodec,
      audioCodec: a.audioCodec,
      hasAudio: a.hasAudio,
      bitrateKbps: a.bitrateKbps,
      container: a.container,
      sampleRate: a.sampleRate,
      channels: a.channels,
      measured: a.analyzedAt !== null && a.status === "READY" && (a.kind === "VIDEO" || a.kind === "IMAGE" || a.kind === "AUDIO"),
    },
    rights: { status: a.rightsStatus, notes: a.rightsNotes, confirmedAt: a.rightsConfirmedAt },
    notes: a.notes,
    tags: (a.tags ?? []).map((t) => t.tag).sort(),
    hasThumbnail: Boolean(thumb),
    thumbnailUrl: thumb ? `/api/media/assets/${a.id}/thumbnail` : null,
    contentUrl: a.storageKey ? `/api/media/assets/${a.id}/content` : null,
    /** Text and spreadsheets are only ever offered as downloads, never rendered in the page. */
    downloadOnly: TEXTUAL.has(a.kind),
    createdAt: a.createdAt,
    analyzedAt: a.analyzedAt,
  };
}
export type AssetDto = ReturnType<typeof assetDto>;

export const ASSET_INCLUDE = {
  tags: true,
  derivatives: true,
  pack: { select: { id: true, name: true } },
  duplicateOf: { select: { id: true, originalName: true } },
} satisfies Prisma.MediaAssetInclude;

export interface PackCounts {
  ready: number;
  analyzing: number;
  failed: number;
  rejected: number;
  duplicate: number;
  archived: number;
  total: number;
}

export function emptyCounts(): PackCounts {
  return { ready: 0, analyzing: 0, failed: 0, rejected: 0, duplicate: 0, archived: 0, total: 0 };
}

export function packDto(p: MediaPack, counts: PackCounts, extra: { campaigns?: { id: string; name: string }[]; pageGroups?: { id: string; name: string }[]; task?: unknown } = {}) {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    sourceType: p.sourceType,
    sourceFileName: p.sourceFileName,
    sourceArchiveBytes: p.sourceArchiveBytes === null ? null : Number(p.sourceArchiveBytes),
    status: p.status,
    entryCount: p.entryCount,
    ignoredCount: p.ignoredCount,
    counts,
    error: p.errorCode ? { code: p.errorCode, message: p.errorMessage } : null,
    campaigns: extra.campaigns ?? [],
    pageGroups: extra.pageGroups ?? [],
    task: extra.task ?? null,
    createdAt: p.createdAt,
    completedAt: p.completedAt,
  };
}
export type PackDto = ReturnType<typeof packDto>;

export function normalizeTag(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 64);
}
