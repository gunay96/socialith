import { ERROR_CODES } from "@socialith/types";
import type { Platform } from "@socialith/database";
import { ApiHttpError } from "../middleware/error-handler.js";
import { getContentDetail } from "./content.service.js";
import {
  findActiveGenerationJob,
  createGenerationJob,
  findGenerationJobById,
  listGenerationJobsForContent,
  type ContentGenerationJob,
} from "../repositories/content-generation-job.repository.js";
import { enqueueContentGeneration } from "../lib/queue.js";
import type { SafeUser } from "../types/auth.js";

/**
 * Creates a ContentGenerationJob row and enqueues it — this call itself
 * returns immediately; the actual AI call happens in
 * apps/worker/src/processors/content-generation.processor.ts, never on
 * this request path (per this phase's explicit "no long-running work in
 * an HTTP request" rule).
 *
 * Idempotent: if a PENDING/PROCESSING job already exists for this exact
 * (content, platform) pair, that job is returned as-is instead of
 * creating a second one — this is what "the same job can't be started
 * twice while one is in flight" means at the service layer (BullMQ's own
 * jobId-based dedup in lib/queue.ts is the second, lower-level guard).
 */
export async function requestGeneration(
  actor: SafeUser,
  contentId: string,
  platform: Platform | null,
): Promise<ContentGenerationJob> {
  await getContentDetail(actor, contentId); // 404s if not in this organization

  const existing = await findActiveGenerationJob(actor.organizationId, contentId, platform);
  if (existing) return existing;

  const job = await createGenerationJob({
    organizationId: actor.organizationId,
    contentId,
    platform,
    requestedById: actor.id,
  });
  await enqueueContentGeneration(job.id);
  return job;
}

export async function getGenerationJob(actor: SafeUser, id: string): Promise<ContentGenerationJob> {
  const job = await findGenerationJobById(actor.organizationId, id);
  if (!job) {
    throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, "Generation job not found.");
  }
  return job;
}

export async function listGenerationJobs(actor: SafeUser, contentId: string): Promise<ContentGenerationJob[]> {
  await getContentDetail(actor, contentId); // 404s if not in this organization
  return listGenerationJobsForContent(contentId);
}
