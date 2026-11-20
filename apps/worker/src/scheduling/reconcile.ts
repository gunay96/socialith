import type { PrismaClient } from "@socialith/database";
import type { Env } from "@socialith/config";
import { logger as defaultLogger } from "../logger.js";
import { holdStaleContent } from "./hold.js";
import { SOCIALITH_OWNED, PROVIDER_OWNED } from "./ownership.js";
import { classifySchedule, stuckFailureMessage } from "./policy.js";
import type { SchedulingQueuePort } from "./queue-port.js";

export interface ReconcileConfig {
  staleAfterMs: number;
  stuckAfterMs: number;
  recoveryMaxAgeMs: number;
}

export function buildReconcileConfig(
  env: Pick<Env, "SCHEDULE_STALE_AFTER_MINUTES" | "PUBLISHING_STUCK_AFTER_MINUTES" | "PUBLISHING_RECOVERY_MAX_AGE_HOURS">,
): ReconcileConfig {
  return {
    staleAfterMs: env.SCHEDULE_STALE_AFTER_MINUTES * 60_000,
    stuckAfterMs: env.PUBLISHING_STUCK_AFTER_MINUTES * 60_000,
    recoveryMaxAgeMs: env.PUBLISHING_RECOVERY_MAX_AGE_HOURS * 3_600_000,
  };
}

export interface ReconcileSummary {
  scheduledChecked: number;
  schedulingJobsEnqueued: number;
  heldStale: number;
  skippedNoScheduleTime: number;
  /** SCHEDULED content whose remaining targets are all owned by the Upload-Post scheduler (not ours to fire or hold). */
  skippedProviderOwned: number;
  stuckPublishingRequeued: number;
  stuckPollsRestored: number;
  stuckFailed: number;
  contentFinalized: number;
}

export interface ReconcileDeps {
  db: PrismaClient;
  port: SchedulingQueuePort;
  config: ReconcileConfig;
  now?: () => Date;
  log?: Pick<typeof defaultLogger, "info" | "warn">;
}

const PAGE_SIZE = 200;
const MAX_PAGES = 25;
const STUCK_BATCH = 200;

/**
 * Brings Redis back in line with the database — the database is the source
 * of truth, BullMQ is only the executor — and never publishes anything
 * itself. It fixes the failure mode where a SCHEDULED row has no job (lost
 * Redis state, a restored snapshot, rows written straight to the DB such as
 * seed data) and therefore silently never fires.
 *
 *  1. SCHEDULED content:
 *       STALE  → held (FAILED + explanation + audit row), its job removed. Never published.
 *       FUTURE / DUE → ensure a live scheduling job exists (create with the
 *                      right delay when missing or finished).
 *  2. Targets stuck in PUBLISHING longer than `stuckAfterMs`:
 *       older than `recoveryMaxAgeMs` → FAILED (manual retry);
 *       has a provider post id → restore the status-poll job;
 *       otherwise → restore the publishing job (processPublishing is idempotent and skips terminal targets).
 *  3. Content stuck in PUBLISHING whose targets are all terminal → finalize its status.
 *
 * Idempotent and safe to run concurrently with the normal processors:
 * every state change is a compare-and-set, every job id is deterministic.
 */
export async function reconcileScheduling(deps: ReconcileDeps): Promise<ReconcileSummary> {
  const { db, port, config } = deps;
  const log = deps.log ?? defaultLogger;
  const now = (deps.now ?? (() => new Date()))();
  const staleAfterMinutes = Math.round(config.staleAfterMs / 60_000);

  const summary: ReconcileSummary = {
    scheduledChecked: 0,
    schedulingJobsEnqueued: 0,
    heldStale: 0,
    skippedNoScheduleTime: 0,
    skippedProviderOwned: 0,
    stuckPublishingRequeued: 0,
    stuckPollsRestored: 0,
    stuckFailed: 0,
    contentFinalized: 0,
  };

  // Cheap feature check: provider-ownership queries only run when a hand-off row exists at all.
  const handoffInUse = (await db.contentTarget.count({ where: PROVIDER_OWNED, take: 1 })) > 0;

  // 1. SCHEDULED content ----------------------------------------------------
  let lastId = "";
  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await db.content.findMany({
      where: { status: "SCHEDULED", id: { gt: lastId } },
      select: { id: true, organizationId: true, scheduledAt: true },
      orderBy: { id: "asc" },
      take: PAGE_SIZE,
    });
    if (batch.length === 0) break;

    for (const content of batch) {
      lastId = content.id;
      summary.scheduledChecked++;

      if (!content.scheduledAt) {
        summary.skippedNoScheduleTime++;
        log.warn({ contentId: content.id }, "scheduling-reconcile: SCHEDULED content has no scheduledAt, skipping");
        continue;
      }

      // Phase 3: targets are scheduled independently, so the job's time is the EARLIEST time among the targets
      // Socialith itself must fire (the content's own scheduledAt is only the fallback for a target without one).
      const loadOurs = () => db.contentTarget.findMany({ where: { contentId: content.id, status: "SCHEDULED", ...SOCIALITH_OWNED }, select: { scheduledAt: true } });
      let ours = await loadOurs();
      if (handoffInUse && ours.length === 0) {
        summary.skippedProviderOwned++;
        continue;
      }
      const times = () => (ours.length ? ours.map((t) => t.scheduledAt ?? content.scheduledAt!) : [content.scheduledAt]);
      const earliest = () => new Date(Math.min(...times().map((d) => d!.getTime())));

      const isStale = (at: Date) => classifySchedule(at, now, config.staleAfterMs).kind === "STALE";
      if (times().some((d) => isStale(d!))) {
        const held = await holdStaleContent(
          db,
          { id: content.id, organizationId: content.organizationId, scheduledAt: content.scheduledAt },
          staleAfterMinutes,
          now,
        );
        // The old job's delay no longer fits: remove it; if targets are still scheduled it is re-created below.
        await port.removeContentScheduling(content.id);
        if (held) {
          summary.heldStale++;
          log.warn(
            { contentId: content.id, scheduledAt: content.scheduledAt.toISOString() },
            "scheduling-reconcile: held stale scheduled targets (not published)",
          );
        }
        const stillScheduled = await db.content.findUnique({ where: { id: content.id }, select: { status: true } });
        if (stillScheduled?.status !== "SCHEDULED") continue;
        ours = await loadOurs();
        if (ours.length === 0) continue;
      }

      const verdict = classifySchedule(earliest(), now, config.staleAfterMs);
      if ((await port.contentSchedulingLiveness(content.id)) !== "live") {
        await port.enqueueContentScheduling(content.id, verdict.delayMs);
        summary.schedulingJobsEnqueued++;
        log.info(
          { contentId: content.id, kind: verdict.kind, delayMs: verdict.delayMs },
          "scheduling-reconcile: re-created missing scheduling job",
        );
      }
    }
    if (batch.length < PAGE_SIZE) break;
  }

  // 2. Targets stuck in PUBLISHING -------------------------------------------
  const stuckBefore = new Date(now.getTime() - config.stuckAfterMs);
  const stuckTargets = await db.contentTarget.findMany({
    where: { status: "PUBLISHING", updatedAt: { lt: stuckBefore } },
    select: { id: true, externalPostId: true, updatedAt: true },
    orderBy: { updatedAt: "asc" },
    take: STUCK_BATCH,
  });

  for (const target of stuckTargets) {
    const ageMs = now.getTime() - target.updatedAt.getTime();

    if (ageMs > config.recoveryMaxAgeMs) {
      const failed = await db.contentTarget.updateMany({
        where: { id: target.id, status: "PUBLISHING" },
        data: { status: "FAILED", errorMessage: stuckFailureMessage(Math.round(config.recoveryMaxAgeMs / 3_600_000)) },
      });
      if (failed.count > 0) {
        summary.stuckFailed++;
        log.warn({ contentTargetId: target.id }, "scheduling-reconcile: failed a target stuck in PUBLISHING past the recovery limit");
      }
      continue;
    }

    if (target.externalPostId) {
      if ((await port.publishStatusPollLiveness(target.id)) !== "live") {
        await port.enqueuePublishStatusPoll(target.id, 1);
        summary.stuckPollsRestored++;
        log.info({ contentTargetId: target.id }, "scheduling-reconcile: restored missing status-poll job");
      }
    } else if ((await port.publishingLiveness(target.id)) !== "live") {
      await port.enqueuePublishing(target.id);
      summary.stuckPublishingRequeued++;
      log.info({ contentTargetId: target.id }, "scheduling-reconcile: restored missing publishing job");
    }
  }

  // 3. Content whose targets are all terminal but whose own status never rolled up
  const settled = await db.content.findMany({
    where: {
      status: "PUBLISHING",
      AND: [
        { targets: { some: {} } },
        // held / cancelled targets (Phase 3) are parked on purpose and do not keep a content open
        { targets: { none: { status: { in: ["PENDING", "SCHEDULED", "PUBLISHING"] }, OR: [{ exception: null }, { exception: "STALE" }] } } },
      ],
    },
    select: { id: true },
    take: STUCK_BATCH,
  });
  for (const content of settled) {
    const failedCount = await db.contentTarget.count({ where: { contentId: content.id, status: "FAILED" } });
    const updated = await db.content.updateMany({
      where: { id: content.id, status: "PUBLISHING" },
      data: { status: failedCount > 0 ? "FAILED" : "PUBLISHED" },
    });
    if (updated.count > 0) {
      summary.contentFinalized++;
      log.info({ contentId: content.id }, "scheduling-reconcile: finalized content whose targets were all terminal");
    }
  }

  return summary;
}
