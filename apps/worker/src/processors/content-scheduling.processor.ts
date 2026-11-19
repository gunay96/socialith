import { prisma } from "@socialith/database";
import { loadEnv } from "@socialith/config";
import type { Job } from "bullmq";
import type { ContentSchedulingJobData } from "@socialith/types";
import { logger } from "../logger.js";
import { enqueuePublishingJob } from "../publishing/enqueue.js";
import { holdStaleContent } from "../scheduling/hold.js";
import { classifySchedule, EARLY_FIRE_TOLERANCE_MS } from "../scheduling/policy.js";
import { SOCIALITH_OWNED } from "../scheduling/ownership.js";

/**
 * Fires once a scheduled content item's `scheduledAt` arrives (job
 * enqueued by apps/api/src/lib/queue.ts, delayed to that exact instant,
 * or re-created by the scheduling reconciler).
 * Transitions Content + its SCHEDULED targets out of SCHEDULED — to
 * PUBLISHING when the content actually has something to publish, or
 * straight to FAILED when it doesn't. Phase 08: once targets are
 * PUBLISHING, enqueues one real publishing job per target (see
 * apps/worker/src/publishing/ and processors/publishing.processor.ts) —
 * this function itself still never calls a platform API directly.
 *
 * Phase 1 stale guard: a job that fires more than SCHEDULE_STALE_AFTER_MINUTES
 * after `scheduledAt` (worker was down, Redis restored from an old snapshot,
 * a leftover job for old seed data) does NOT publish — the content is held
 * (see scheduling/hold.ts) for a human to decide.
 */
export async function processContentScheduling(job: Job<ContentSchedulingJobData>): Promise<void> {
  const { contentId } = job.data;

  const content = await prisma.content.findUnique({
    where: { id: contentId },
    select: {
      id: true,
      organizationId: true,
      status: true,
      scheduledAt: true,
      _count: { select: { variations: true, assets: true } },
    },
  });

  if (!content) {
    // Content was deleted after scheduling — nothing left to transition.
    // Not an error: the job simply has nothing to do anymore.
    logger.warn({ contentId }, "content-scheduling: content no longer exists, skipping");
    return;
  }

  // Defensive idempotency check: only act on content still in SCHEDULED
  // status. A content item can only reach this processor via a job that
  // content-target.service.ts's scheduleContent() enqueues under a
  // deterministic per-content jobId (removing any prior job for the same
  // content first), so in practice there is at most one live job per
  // content — this guard exists for the unlikely case of a duplicate
  // delivery or a status changed out from under the job some other way.
  if (content.status !== "SCHEDULED") {
    logger.warn(
      { contentId, status: content.status },
      "content-scheduling: content is no longer SCHEDULED, skipping",
    );
    return;
  }

  if (content.scheduledAt) {
    const env = loadEnv();
    const staleAfterMinutes = env.SCHEDULE_STALE_AFTER_MINUTES;
    const verdict = classifySchedule(content.scheduledAt, new Date(), staleAfterMinutes * 60_000);

    if (verdict.kind === "STALE") {
      const held = await holdStaleContent(
        prisma,
        { id: content.id, organizationId: content.organizationId, scheduledAt: content.scheduledAt },
        staleAfterMinutes,
        new Date(),
      );
      logger.warn(
        { contentId, scheduledAt: content.scheduledAt.toISOString(), lateByMinutes: Math.round(verdict.lateByMs / 60_000), held },
        "content-scheduling: scheduling job fired too late — held, not published",
      );
      return;
    }

    if (verdict.kind === "FUTURE" && verdict.delayMs > EARLY_FIRE_TOLERANCE_MS) {
      // Rescheduled later after this job was created (or clock skew). Leave
      // the content SCHEDULED; the reconciler re-creates the job with the
      // correct delay.
      logger.warn(
        { contentId, delayMs: verdict.delayMs },
        "content-scheduling: job fired before scheduledAt, leaving SCHEDULED for the reconciler",
      );
      return;
    }
  }

  const hasPublishableMaterial = content._count.variations > 0 || content._count.assets > 0;

  if (!hasPublishableMaterial) {
    const errorMessage = "Scheduled publish time arrived with no variations or assets to publish.";
    await prisma.$transaction([
      prisma.content.update({ where: { id: contentId }, data: { status: "FAILED" } }),
      prisma.contentTarget.updateMany({
        where: { contentId, status: "SCHEDULED", ...SOCIALITH_OWNED },
        data: { status: "FAILED", errorMessage },
      }),
    ]);
    logger.info({ contentId }, "content-scheduling: marked content FAILED (no variations/assets)");
    return;
  }

  // Targets handed to Upload-Post's scheduler are not ours to fire (see scheduling/ownership.ts).
  const targetsToPublish = await prisma.contentTarget.findMany({
    where: { contentId, status: "SCHEDULED", ...SOCIALITH_OWNED },
    select: { id: true },
  });
  if (targetsToPublish.length === 0) {
    logger.info({ contentId }, "content-scheduling: every remaining target is owned by the Upload-Post scheduler, nothing to fire");
    return;
  }

  await prisma.$transaction([
    prisma.content.update({ where: { id: contentId }, data: { status: "PUBLISHING" } }),
    prisma.contentTarget.updateMany({
      where: { contentId, status: "SCHEDULED", ...SOCIALITH_OWNED },
      data: { status: "PUBLISHING" },
    }),
  ]);
  logger.info(
    { contentId, targetCount: targetsToPublish.length },
    "content-scheduling: transitioned content to PUBLISHING",
  );

  // One BullMQ job per target — never a loop of blocking HTTP calls here
  // or in the publishing worker. enqueuePublishingJob's deterministic
  // jobId (the target's own id) means this is safe to run again for the
  // same targets without creating duplicate jobs.
  for (const target of targetsToPublish) {
    await enqueuePublishingJob(target.id);
  }
}
