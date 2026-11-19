import Redis from "ioredis";
import { Queue } from "bullmq";
import { loadEnv } from "@socialith/config";
import { QUEUE_NAMES, type TokenRefreshJobData, type AnalyticsSyncJobData } from "@socialith/types";
import { logger } from "../logger.js";

/**
 * The two repeatable scan processors (token-refresh-scan,
 * analytics-sync-scan) enqueue individual work items onto queues other
 * workers consume — same "producer living where the enqueue call
 * actually happens" pattern as publishing/enqueue.ts (content-scheduling
 * enqueuing publishing jobs). Its own Redis connection, same reasoning
 * as every other BullMQ connection in this codebase. REDIS_URL is optional
 * at the config-schema level (the shared-hosting API tier boots without
 * it), but apps/worker itself still requires it (index.ts throws fast at
 * boot if it's missing) — the non-null assertion reflects that.
 */
const connection = new Redis(loadEnv().REDIS_URL!, { maxRetriesPerRequest: null });

connection.on("error", (err) => {
  logger.error({ err }, "Scheduled-scan queue producer Redis connection error");
});

const tokenRefreshQueue = new Queue<TokenRefreshJobData>(QUEUE_NAMES.TOKEN_REFRESH, { connection });
const analyticsSyncQueue = new Queue<AnalyticsSyncJobData>(QUEUE_NAMES.ANALYTICS_SYNC, { connection });

/** Deterministic jobId = the row being worked on, `.remove()`-then-add for the same reuse-of-id reason every other queue in this codebase documents. */
export async function enqueueTokenRefresh(platformConnectionId: string): Promise<void> {
  await tokenRefreshQueue.remove(platformConnectionId);
  await tokenRefreshQueue.add(QUEUE_NAMES.TOKEN_REFRESH, { platformConnectionId }, { jobId: platformConnectionId });
}

export async function enqueueAnalyticsSyncFromScan(contentTargetId: string): Promise<void> {
  await analyticsSyncQueue.remove(contentTargetId);
  await analyticsSyncQueue.add(QUEUE_NAMES.ANALYTICS_SYNC, { contentTargetId }, { jobId: contentTargetId });
}

export async function closeScheduledProducers(): Promise<void> {
  await Promise.allSettled([tokenRefreshQueue.close(), analyticsSyncQueue.close(), connection.quit()]);
}
