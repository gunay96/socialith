import { prisma } from "@socialith/database";
import { loadEnv } from "@socialith/config";
import { DelayedError, type Job } from "bullmq";
import type { ContentSchedulingJobData } from "@socialith/types";
import { logger } from "../logger.js";
import { enqueuePublishingJob } from "../publishing/enqueue.js";
import { evaluateApprovalGate } from "../publishing/approval-gate.js";
import { holdStaleContent } from "../scheduling/hold.js";
import { classifySchedule, EARLY_FIRE_TOLERANCE_MS } from "../scheduling/policy.js";
import { SOCIALITH_OWNED } from "../scheduling/ownership.js";
import { rollUpContent } from "../scheduling/rollup.js";

/**
 * Fires the SCHEDULED targets of a content item that are due. Enqueued by apps/api/src/lib/queue.ts as a delayed
 * job under one deterministic id per content (or re-created by the scheduling reconciler); the job's time is the
 * EARLIEST scheduled time among the content's targets.
 *
 * Phase 3: targets are scheduled independently, so this processor fires only the targets whose own time has come
 * (`scheduledAt` ≤ now, give or take the early-fire tolerance), holds only the targets that are individually stale,
 * leaves the rest SCHEDULED, and — when targets remain — moves THIS job to the next due time (BullMQ
 * `moveToDelayed`), so a content item with staggered destinations needs no second scheduler. With identical target
 * times (everything scheduled before Phase 3) the behaviour is exactly the previous one.
 *
 * Per due target, in order:
 *   1. approval gate: when the organization requires approval, an unapproved target — or one whose content changed
 *      after approval — is HELD (never fired, never failed), with a publication event saying why;
 *   2. transition to PUBLISHING and enqueue one publishing job (deterministic job id = the target id, so a repeat
 *      never creates a duplicate).
 * This function never calls a platform API itself. Targets handed to Upload-Post's scheduler are not ours to fire
 * (see scheduling/ownership.ts).
 *
 * Phase 1 stale guard: targets that are more than SCHEDULE_STALE_AFTER_MINUTES late (worker was down, Redis restored
 * from an old snapshot, a leftover seed row) are NOT published — they are held (scheduling/hold.ts) as STALE for a
 * human to decide.
 */
export async function processContentScheduling(job: Job<ContentSchedulingJobData>, token?: string): Promise<void> {
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

  // Defensive idempotency check: only act on content still in SCHEDULED status (duplicate delivery, or a status
  // changed out from under the job some other way).
  if (content.status !== "SCHEDULED") {
    logger.warn({ contentId, status: content.status }, "content-scheduling: content is no longer SCHEDULED, skipping");
    return;
  }

  const env = loadEnv();
  const staleAfterMinutes = env.SCHEDULE_STALE_AFTER_MINUTES;
  const staleMs = staleAfterMinutes * 60_000;
  const fallbackAt = content.scheduledAt ?? new Date();

  const loadOurs = () =>
    prisma.contentTarget.findMany({
      where: { contentId, status: "SCHEDULED", ...SOCIALITH_OWNED },
      select: { id: true, scheduledAt: true },
    });
  const timeOf = (t: { scheduledAt: Date | null }) => t.scheduledAt ?? fallbackAt;

  // 1. stale targets are held, never published ------------------------------------------------------
  let ours = await loadOurs();
  if (ours.length > 0 && ours.some((t) => classifySchedule(timeOf(t), new Date(), staleMs).kind === "STALE")) {
    const held = await holdStaleContent(
      prisma,
      { id: content.id, organizationId: content.organizationId, scheduledAt: fallbackAt },
      staleAfterMinutes,
      new Date(),
    );
    logger.warn({ contentId, held }, "content-scheduling: scheduling job fired too late for some targets — held, not published");
    ours = await loadOurs();
  }

  if (ours.length === 0) {
    // Everything was held, or every remaining target is owned by the Upload-Post scheduler: nothing for us to fire.
    logger.info({ contentId }, "content-scheduling: no Socialith-owned scheduled target left, nothing to fire");
    return;
  }

  // 2. which of the remaining targets are due ----------------------------------------------------
  const now = new Date();
  const due: { id: string; scheduledAt: Date | null }[] = [];
  const waiting: { id: string; scheduledAt: Date | null }[] = [];
  for (const t of ours) {
    const verdict = classifySchedule(timeOf(t), now, staleMs);
    if (verdict.kind === "FUTURE" && verdict.delayMs > EARLY_FIRE_TOLERANCE_MS) waiting.push(t);
    else due.push(t);
  }

  if (due.length === 0) {
    // Fired before any target's time (rescheduled later after this job was created, or clock skew).
    logger.warn({ contentId }, "content-scheduling: job fired before any target was due, leaving SCHEDULED");
    await wakeAgainAt(job, token, nextTime(waiting, fallbackAt));
    return;
  }

  // 3. nothing to publish at all ---------------------------------------------------------------
  const hasPublishableMaterial = content._count.variations > 0 || content._count.assets > 0;
  if (!hasPublishableMaterial) {
    const errorMessage = "Scheduled publish time arrived with no variations or assets to publish.";
    await prisma.$transaction(async (tx) => {
      await tx.contentTarget.updateMany({ where: { id: { in: due.map((t) => t.id) }, status: "SCHEDULED" }, data: { status: "FAILED", errorMessage } });
      await rollUpContent(tx, contentId);
    });
    logger.info({ contentId }, "content-scheduling: marked due targets FAILED (no variations/assets)");
    await wakeAgainAt(job, token, nextTime(waiting, null));
    return;
  }

  // 4. approval gate: an unapproved or changed publication is held, not fired ---------------------------------
  const toFire: string[] = [];
  for (const t of due) {
    const verdict = await evaluateApprovalGate(prisma, t.id);
    if (verdict.ok) {
      toFire.push(t.id);
      continue;
    }
    const held = await prisma.contentTarget.updateMany({
      where: { id: t.id, status: "SCHEDULED" },
      data: { status: "PENDING", exception: "HELD", errorMessage: verdict.message },
    });
    if (held.count === 1) {
      await prisma.publicationEvent.create({
        data: { organizationId: content.organizationId, contentTargetId: t.id, type: "HELD", fromState: "SCHEDULED", toState: "HELD", actorId: null, reason: verdict.message, metadata: { gate: verdict.code } },
      });
      logger.warn({ contentTargetId: t.id, gate: verdict.code }, "content-scheduling: approval gate held a due target");
    }
  }

  // 5. fire ------------------------------------------------------------------------------------
  const fired = toFire.length
    ? await prisma.contentTarget.findMany({ where: { id: { in: toFire }, status: "SCHEDULED" }, select: { id: true } })
    : [];
  await prisma.$transaction(async (tx) => {
    if (fired.length) await tx.contentTarget.updateMany({ where: { id: { in: fired.map((t) => t.id) }, status: "SCHEDULED" }, data: { status: "PUBLISHING" } });
    await rollUpContent(tx, contentId);
  });
  logger.info({ contentId, targetCount: fired.length, waiting: waiting.length }, "content-scheduling: fired due targets");

  // One BullMQ job per target — never a loop of blocking HTTP calls here or in the publishing worker.
  // enqueuePublishingJob's deterministic jobId (the target's own id) means this is safe to run again for the same
  // targets without creating duplicate jobs.
  for (const target of fired) {
    await enqueuePublishingJob(target.id);
  }

  // 6. targets still waiting for their own time: this job wakes up again then ------------------------------
  if (waiting.length > 0) await wakeAgainAt(job, token, nextTime(waiting, null));
}

function nextTime(targets: { scheduledAt: Date | null }[], fallback: Date | null): Date | null {
  const times = targets.map((t) => t.scheduledAt ?? fallback).filter((d): d is Date => d !== null);
  return times.length ? new Date(Math.min(...times.map((d) => d.getTime()))) : null;
}

/**
 * Moves THIS job (the one deterministic job of the content) to the next due time instead of finishing — the BullMQ
 * pattern for a job that has more to do later. Without a BullMQ context (unit/integration tests call the processor
 * directly) or without a next time this does nothing, and the scheduling reconciler re-creates the job from the
 * database on its next run — the database is always the source of truth.
 */
async function wakeAgainAt(job: Job<ContentSchedulingJobData>, token: string | undefined, at: Date | null): Promise<void> {
  if (!at || !token || typeof job.moveToDelayed !== "function") return;
  await job.moveToDelayed(Math.max(Date.now() + 1_000, at.getTime()), token);
  throw new DelayedError();
}
