import { prisma } from "@socialith/database";
import { ERROR_CODES } from "@socialith/types";
import { ApiHttpError } from "../middleware/error-handler.js";
import { getContentDetail } from "./content.service.js";
import {
  filterOwnedSocialAccountIds,
  assignContentTargets,
  removeContentTargets,
  scheduleContentTargets,
  listContentTargets,
  findContentTargetByAccount,
  resetTargetForRetry,
  type ListContentTargetsResult,
} from "../repositories/content-target.repository.js";
import { listPublishAttempts, type PublishAttempt } from "../repositories/publish-attempt.repository.js";
import { listMetricsSnapshots, type PostMetricsSnapshot } from "../repositories/analytics.repository.js";
import { updateContent } from "../repositories/content.repository.js";
import { enqueueContentScheduling, enqueuePublishingJob, enqueueAnalyticsSync } from "../lib/queue.js";
import type { Content, ContentTargetStatus } from "@socialith/database";
import type { SafeUser } from "../types/auth.js";

export interface AssignTargetsResult {
  assigned: number;
  requested: number;
  skipped: string[];
}

/**
 * Bulk assign — one INSERT for however many accounts were requested
 * (see content-target.repository.ts's assignContentTargets), not one
 * request/query per account. IDs that don't belong to the actor's
 * organization are silently excluded and reported back as `skipped`
 * rather than failing the whole batch or leaking whether that ID exists
 * in another tenant.
 */
export async function assignTargets(
  actor: SafeUser,
  contentId: string,
  socialAccountIds: string[],
): Promise<AssignTargetsResult> {
  await getContentDetail(actor, contentId); // 404s if not in this organization

  const owned = await filterOwnedSocialAccountIds(actor.organizationId, socialAccountIds);
  const skipped = socialAccountIds.filter((id) => !owned.includes(id));
  const assigned = await assignContentTargets(contentId, owned);

  return { assigned, requested: socialAccountIds.length, skipped };
}

export async function removeTargets(actor: SafeUser, contentId: string, socialAccountIds: string[]): Promise<number> {
  await getContentDetail(actor, contentId);
  return removeContentTargets(contentId, socialAccountIds);
}

export async function getTargets(
  actor: SafeUser,
  contentId: string,
  page: number,
  pageSize: number,
  status?: ContentTargetStatus,
): Promise<ListContentTargetsResult> {
  await getContentDetail(actor, contentId);
  return listContentTargets(contentId, page, pageSize, status);
}

/**
 * Sets the content-level `scheduledAt`/`status` and bulk-transitions
 * every currently-PENDING target to SCHEDULED with the same timestamp —
 * both in one transaction, so a crash mid-flow can't leave the content
 * marked SCHEDULED with zero targets actually scheduled, or vice versa.
 * Requires at least one target to already be assigned (via assignTargets
 * first) — scheduling nothing isn't a meaningful action.
 *
 * After the transaction commits, enqueues the delayed BullMQ job
 * (apps/api/src/lib/queue.ts) that will flip this content out of
 * SCHEDULED once `scheduledAt` arrives — see apps/worker's
 * content-scheduling processor. Enqueuing happens after, not inside, the
 * transaction: BullMQ isn't transactional with Postgres, so ordering it
 * this way means a failed enqueue never leaves a job for content the DB
 * doesn't actually think is scheduled (the reverse — a committed
 * SCHEDULED row with no job — is instead handled by scheduleContent
 * being safely re-callable to re-enqueue).
 */
export async function scheduleContent(actor: SafeUser, contentId: string, scheduledAt: Date): Promise<Content> {
  const content = await getContentDetail(actor, contentId);
  if (content._count.targets === 0) {
    throw new ApiHttpError(
      400,
      ERROR_CODES.INVALID_REQUEST,
      "Assign at least one target account before scheduling.",
    );
  }

  const updated = await prisma.$transaction(async (tx) => {
    const result = await updateContent(contentId, { status: "SCHEDULED", scheduledAt }, tx);
    await scheduleContentTargets(contentId, scheduledAt, tx);
    return result;
  });

  await enqueueContentScheduling(contentId, scheduledAt);

  return updated;
}

/**
 * Phase 08's "publish now" — reuses scheduleContent's exact transaction +
 * enqueue path rather than a parallel pipeline, per this phase's explicit
 * "don't build a separate scheduler" instruction. `scheduledAt` is
 * effectively immediate (1 second out) while still satisfying
 * scheduleContentSchema's existing "must be in the future" contract
 * unchanged — see validation/content.validation.ts.
 */
export async function publishNow(actor: SafeUser, contentId: string): Promise<Content> {
  return scheduleContent(actor, contentId, new Date(Date.now() + 1000));
}

/**
 * Manual retry for one FAILED target — idempotent via
 * resetTargetForRetry's atomic conditional UPDATE (only a target still
 * FAILED at the moment this runs gets reset), so two concurrent retry
 * clicks can't both re-enqueue the same target.
 */
export async function retryTarget(actor: SafeUser, contentId: string, socialAccountId: string): Promise<void> {
  await getContentDetail(actor, contentId); // 404s if not in this organization

  const target = await findContentTargetByAccount(contentId, socialAccountId);
  if (!target) {
    throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, "Target account not found on this content.");
  }

  const reset = await resetTargetForRetry(target.id);
  if (!reset) {
    throw new ApiHttpError(409, ERROR_CODES.CONFLICT, "Only a FAILED target can be retried.");
  }

  await enqueuePublishingJob(target.id);
}

export async function getPublishAttempts(actor: SafeUser, contentId: string, socialAccountId: string): Promise<PublishAttempt[]> {
  await getContentDetail(actor, contentId); // 404s if not in this organization

  const target = await findContentTargetByAccount(contentId, socialAccountId);
  if (!target) {
    throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, "Target account not found on this content.");
  }

  return listPublishAttempts(target.id);
}

/**
 * Phase 09 — manually enqueues a real metrics fetch for one target (see
 * apps/worker/src/processors/analytics-sync.processor.ts). Only
 * meaningful once the target has actually published (a real
 * externalPostId to look up) — a target that never got that far has
 * nothing to sync, so this rejects rather than silently enqueuing a job
 * the worker would just skip anyway.
 */
export async function syncAnalytics(actor: SafeUser, contentId: string, socialAccountId: string): Promise<void> {
  await getContentDetail(actor, contentId); // 404s if not in this organization

  const target = await findContentTargetByAccount(contentId, socialAccountId);
  if (!target) {
    throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, "Target account not found on this content.");
  }
  if (target.status !== "PUBLISHED" || !target.externalPostId) {
    throw new ApiHttpError(409, ERROR_CODES.CONFLICT, "Only a published target has real post metrics to sync.");
  }

  await enqueueAnalyticsSync(target.id);
}

export async function getMetricsHistory(actor: SafeUser, contentId: string, socialAccountId: string): Promise<PostMetricsSnapshot[]> {
  await getContentDetail(actor, contentId); // 404s if not in this organization

  const target = await findContentTargetByAccount(contentId, socialAccountId);
  if (!target) {
    throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, "Target account not found on this content.");
  }

  return listMetricsSnapshots(target.id);
}
