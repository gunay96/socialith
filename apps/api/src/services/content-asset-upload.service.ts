import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import multer from "multer";
import type { RequestHandler } from "express";
import { ERROR_CODES } from "@socialith/types";
import { loadEnv, resolveAssetStorageConfig } from "@socialith/config";
import { resolveAssetStorage } from "@socialith/video-engine";
import type { AssetType, Platform, Prisma } from "@socialith/database";
import { ApiHttpError } from "../middleware/error-handler.js";
import { getContentDetail } from "./content.service.js";
import { createContentAsset, type ContentAsset } from "../repositories/content-asset.repository.js";
import type { SafeUser } from "../types/auth.js";

/**
 * Real file upload — the one way a ContentAsset gets a genuine local URL
 * in this phase (see packages/video-engine's storage comment). The
 * existing `POST /api/content/:id/assets` (Phase 05, url-only) is
 * unchanged and still works for referencing media that already lives
 * somewhere else; this is a sibling route, not a replacement.
 */
const ALLOWED_MIME_TO_ASSET_TYPE: Record<string, AssetType> = {
  "video/mp4": "VIDEO",
  "video/quicktime": "VIDEO",
  "video/webm": "VIDEO",
  "image/png": "IMAGE",
  "image/jpeg": "IMAGE",
  "image/webp": "IMAGE",
};

/**
 * Memory storage, not disk — files are small enough (200MB cap) to hold
 * in memory for the single write-to-local-storage step that follows, and
 * this avoids a second temp-file cleanup concern. Bumped past Express's
 * default JSON body limit deliberately: this route never goes through
 * `express.json()` (see app.ts — multer parses multipart bodies itself).
 */
export const assetUpload: RequestHandler = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 },
}).single("file");

export interface UploadAssetServiceInput {
  platform?: Platform | null;
  buffer: Buffer;
  mimetype: string;
  originalFilename: string;
}

export async function uploadAsset(
  actor: SafeUser,
  contentId: string,
  input: UploadAssetServiceInput,
): Promise<ContentAsset> {
  await getContentDetail(actor, contentId); // 404s if not in this organization

  const assetType = ALLOWED_MIME_TO_ASSET_TYPE[input.mimetype];
  if (!assetType) {
    throw new ApiHttpError(
      400,
      ERROR_CODES.INVALID_MEDIA,
      `Unsupported file type: ${input.mimetype}. Allowed: ${Object.keys(ALLOWED_MIME_TO_ASSET_TYPE).join(", ")}.`,
    );
  }

  const env = loadEnv();
  const storage = resolveAssetStorage(resolveAssetStorageConfig(env));
  const extension = extname(input.originalFilename) || (assetType === "VIDEO" ? ".mp4" : ".png");
  const key = `${actor.organizationId}/${contentId}/${randomUUID()}${extension}`;
  const stored = await storage.upload(key, input.buffer, input.mimetype);

  return createContentAsset({
    contentId,
    type: assetType,
    platform: input.platform ?? null,
    url: stored.url,
    metadata: {
      originalFilename: input.originalFilename,
      sizeBytes: input.buffer.length,
      storageKey: stored.key,
    } as unknown as Prisma.InputJsonValue,
  });
}
