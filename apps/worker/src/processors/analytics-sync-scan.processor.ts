import { prisma } from "@socialith/database";
import { logger } from "../logger.js";
import { enqueueAnalyticsSyncFromScan } from "../scheduled/producers.js";

/** How often a PUBLISHED target's metrics get a real re-sync. */
const RESYNC_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

const MAX_PER_SCAN = 500;

/**
 * A single BullMQ repeatable job (registered once in index.ts) — the
 * production automation Phase 09's manual-only "sync now" was missing.
 * Finds PUBLISHED targets that either never synced or haven't synced
 * within RESYNC_INTERVAL_MS (ContentTarget.lastAnalyticsSyncAt, indexed
 * alongside `status`) and fans out one analytics-sync job per target —
 * the exact same queue/processor apps/api's manual trigger already uses,
 * so both paths share identical rate-limit/retry/provider-capability
 * behavior.
 */
export async function processAnalyticsSyncScan(): Promise<void> {
  const threshold = new Date(Date.now() - RESYNC_INTERVAL_MS);
  const dueTargets = await prisma.contentTarget.findMany({
    where: {
      status: "PUBLISHED",
      OR: [{ lastAnalyticsSyncAt: null }, { lastAnalyticsSyncAt: { lte: threshold } }],
    },
    select: { id: true },
    take: MAX_PER_SCAN,
  });

  for (const target of dueTargets) {
    await enqueueAnalyticsSyncFromScan(target.id);
  }

  if (dueTargets.length > 0) {
    logger.info({ count: dueTargets.length }, "analytics-sync-scan: enqueued sync jobs");
  }
}
