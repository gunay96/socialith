import { ERROR_CODES } from "@socialith/types";
import type { VideoRenderOperation } from "@socialith/database";
import { ApiHttpError } from "../middleware/error-handler.js";
import { getContentDetail } from "./content.service.js";
import {
  findActiveRenderJob,
  createRenderJob,
  findRenderJobById,
  listRenderJobsForContent,
  type VideoRenderJob,
} from "../repositories/video-render-job.repository.js";
import { enqueueVideoRender } from "../lib/queue.js";
import type { SafeUser } from "../types/auth.js";

/**
 * Creates a VideoRenderJob row and enqueues it — real FFmpeg processing
 * happens in apps/worker/src/processors/video-render.processor.ts, never
 * on this request path. Idempotent the same way requestGeneration is: an
 * in-flight job for the same (content, sourceAsset, operation) is
 * returned as-is instead of duplicated.
 */
export async function requestRender(
  actor: SafeUser,
  contentId: string,
  sourceAssetId: string,
  operation: VideoRenderOperation,
): Promise<VideoRenderJob> {
  const content = await getContentDetail(actor, contentId); // 404s if not in this organization
  const sourceAsset = content.assets.find((asset) => asset.id === sourceAssetId);
  if (!sourceAsset) {
    throw new ApiHttpError(400, ERROR_CODES.INVALID_REQUEST, "sourceAssetId does not belong to this content.");
  }

  const existing = await findActiveRenderJob(actor.organizationId, contentId, sourceAssetId, operation);
  if (existing) return existing;

  const job = await createRenderJob({
    organizationId: actor.organizationId,
    contentId,
    sourceAssetId,
    operation,
    requestedById: actor.id,
  });
  await enqueueVideoRender(job.id);
  return job;
}

export async function getRenderJob(actor: SafeUser, id: string): Promise<VideoRenderJob> {
  const job = await findRenderJobById(actor.organizationId, id);
  if (!job) {
    throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, "Render job not found.");
  }
  return job;
}

export async function listRenderJobs(actor: SafeUser, contentId: string): Promise<VideoRenderJob[]> {
  await getContentDetail(actor, contentId); // 404s if not in this organization
  return listRenderJobsForContent(contentId);
}
