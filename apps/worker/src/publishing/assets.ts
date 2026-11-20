import { resolveAssetStorageConfig, type Env } from "@socialith/config";
import { resolveAssetStorage } from "@socialith/video-engine";
import type { Prisma } from "@socialith/database";

/**
 * ContentAsset.url is a snapshot taken at upload/render time — fine for the real local storage backend
 * (never expires), but for R2 without a public bucket it's a presigned URL good for only ~1 hour (see
 * packages/video-engine's R2AssetStorage.getDownloadUrl). A target scheduled days out would otherwise hand
 * the platform an already-expired URL. Regenerates a fresh signed URL from the asset's real storage key
 * right before every publish attempt instead of trusting the stale persisted one; a url-only asset (no
 * storageKey — referencing media that lives somewhere else entirely) and any local-storage asset both pass
 * through unchanged. Moved out of publishing.processor.ts unchanged so other publishers can share it.
 */
export async function resolveAssetUrl(env: Env, asset: { url: string; metadata: Prisma.JsonValue }): Promise<string> {
  const storageKey =
    asset.metadata && typeof asset.metadata === "object" && !Array.isArray(asset.metadata)
      ? (asset.metadata as Record<string, unknown>).storageKey
      : undefined;
  if (typeof storageKey !== "string") return asset.url;

  const storage = resolveAssetStorage(resolveAssetStorageConfig(env));
  if (storage.kind !== "r2") return asset.url;
  return storage.getDownloadUrl(storageKey);
}

/**
 * True when the URLs handed to a provider will NOT expire within hours: local storage, a url-only asset, or
 * R2 behind a public bucket. A presigned R2 URL (~1 h) is not stable enough to hand to a provider that may
 * fetch the media much later (e.g. a job it will run in two days).
 */
export function assetUrlsAreDurable(env: Env): boolean {
  const storage = resolveAssetStorage(resolveAssetStorageConfig(env));
  return storage.kind !== "r2" || Boolean(env.R2_PUBLIC_URL);
}
