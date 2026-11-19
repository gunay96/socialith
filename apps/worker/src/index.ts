import http from "node:http";
import Redis from "ioredis";
import { Queue, Worker, type Job } from "bullmq";
import { loadEnv } from "@socialith/config";
import { prisma } from "@socialith/database";
import { logger } from "./logger.js";
import { QUEUE_NAMES } from "./queues.js";
import { processContentScheduling } from "./processors/content-scheduling.processor.js";
import { processContentGeneration } from "./processors/content-generation.processor.js";
import { processVideoRender } from "./processors/video-render.processor.js";
import { processPublishing, maybeFinalizeContentStatus } from "./processors/publishing.processor.js";
import { processPublishStatusPoll, recordPublishStatusPollFailure } from "./processors/publish-status-poll.processor.js";
import { closePublishingQueueProducer } from "./publishing/enqueue.js";
import { processAnalyticsSync } from "./processors/analytics-sync.processor.js";
import { AiProviderRateLimitError } from "./ai/provider.js";
import { processAnalyticsSyncScan } from "./processors/analytics-sync-scan.processor.js";
import { processTokenRefresh } from "./processors/token-refresh.processor.js";
import { processTokenRefreshScan } from "./processors/token-refresh-scan.processor.js";
import { closeScheduledProducers } from "./scheduled/producers.js";
import { createBullMqSchedulingPort } from "./scheduling/queue-port.js";
import { buildReconcileConfig, reconcileScheduling } from "./scheduling/reconcile.js";
import { ensureRepeatable } from "./scheduling/ensure-repeatable.js";

const env = loadEnv();

// REDIS_URL is optional at the @socialith/config schema level (the
// shared-hosting/demo-lite API tier boots without it — see
// apps/api/src/index.ts) but this worker process has nothing to do
// without a real queue backend, so it still fails fast and clearly here
// rather than passing `undefined` into ioredis and failing confusingly.
if (!env.REDIS_URL) {
  throw new Error("REDIS_URL is required for apps/worker — this process has no purpose without a real queue backend.");
}

const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

connection.on("error", (err) => {
  logger.error({ err }, "Worker Redis connection error");
});

// Phase 01 smoke-test queue: proves the worker can enqueue and process a
// job end-to-end. Real processors (content-generation, video-render,
// publishing, analytics-sync, notifications, cleanup) are added per
// docs/architecture.md as each owning phase lands.
const systemQueue = new Queue(QUEUE_NAMES.CLEANUP, { connection });

const systemWorker = new Worker(
  QUEUE_NAMES.CLEANUP,
  async (job) => {
    logger.info({ jobId: job.id, name: job.name }, "Processed job");
    return { processedAt: new Date().toISOString() };
  },
  { connection },
);

systemWorker.on("failed", (job, err) => {
  logger.error({ jobId: job?.id, err }, "Job failed");
});

// Phase 06: transitions SCHEDULED content/targets to PUBLISHING (or
// FAILED, if there's nothing to publish) once their scheduled time
// arrives. Enqueued by apps/api's content-target.service.ts.
const contentSchedulingQueue = new Queue(QUEUE_NAMES.CONTENT_SCHEDULING, { connection });

const contentSchedulingWorker = new Worker(QUEUE_NAMES.CONTENT_SCHEDULING, processContentScheduling, { connection });

contentSchedulingWorker.on("failed", (job, err) => {
  logger.error({ jobId: job?.id, err }, "content-scheduling job failed");
});

/**
 * True once BullMQ has exhausted every configured retry for this job —
 * only then should the DB row (ContentGenerationJob/VideoRenderJob) be
 * marked conclusively FAILED. Before that point the processor itself
 * already re-set the row to PROCESSING for the next attempt, so a
 * "failed" event mid-retry means nothing changes here.
 */
function isFinalAttempt(job: Job | undefined): boolean {
  if (!job) return false;
  const maxAttempts = job.opts.attempts ?? 1;
  return job.attemptsMade >= maxAttempts;
}

// Phase 07: AI caption/hashtag generation (apps/worker/src/ai/provider.ts)
// and FFmpeg video rendering (packages/video-engine). Enqueued by
// apps/api's content-generation.service.ts / video-render.service.ts.
const contentGenerationQueue = new Queue(QUEUE_NAMES.CONTENT_GENERATION, { connection });
const contentGenerationWorker = new Worker(QUEUE_NAMES.CONTENT_GENERATION, processContentGeneration, {
  connection,
  limiter: { max: env.AI_PROVIDER_RATE_LIMIT_MAX, duration: env.AI_PROVIDER_RATE_LIMIT_DURATION_MS },
});

contentGenerationWorker.on("failed", (job, err) => {
  logger.error({ jobId: job?.id, attemptsMade: job?.attemptsMade, err }, "content-generation job failed");
  if (isFinalAttempt(job) && job) {
    const { jobRowId } = job.data as { jobRowId: string };
    const errorCode = err instanceof AiProviderRateLimitError ? "RATE_LIMITED" : null;
    prisma.contentGenerationJob
      .update({ where: { id: jobRowId }, data: { status: "FAILED", errorMessage: err.message, errorCode, completedAt: new Date() } })
      .catch((updateErr) => logger.error({ jobRowId, updateErr }, "content-generation: failed to record final FAILED state"));
  }
});

const videoRenderQueue = new Queue(QUEUE_NAMES.VIDEO_RENDER, { connection });
const videoRenderWorker = new Worker(QUEUE_NAMES.VIDEO_RENDER, processVideoRender, { connection });

videoRenderWorker.on("failed", (job, err) => {
  logger.error({ jobId: job?.id, attemptsMade: job?.attemptsMade, err }, "video-render job failed");
  if (isFinalAttempt(job) && job) {
    const { jobRowId } = job.data as { jobRowId: string };
    prisma.videoRenderJob
      .update({ where: { id: jobRowId }, data: { status: "FAILED", errorMessage: err.message, completedAt: new Date() } })
      .catch((updateErr) => logger.error({ jobRowId, updateErr }, "video-render: failed to record final FAILED state"));
  }
});

// Phase 08: one job per ContentTarget — real platform publish attempts
// (apps/worker/src/publishing/). Enqueued by content-scheduling.processor.ts
// (scheduled publish) and apps/api's retry endpoint (manual retry).
// Concurrency capped below 1000+ scale's raw target count on purpose:
// BullMQ pulls jobs off the queue as capacity frees up rather than this
// worker ever holding 1000 HTTP calls open at once.
const publishingQueue = new Queue(QUEUE_NAMES.PUBLISHING, { connection });
const publishingWorker = new Worker(QUEUE_NAMES.PUBLISHING, processPublishing, {
  connection,
  concurrency: 10,
  // Real cap, not just concurrency: BullMQ's `limiter` bounds total jobs
  // started per window regardless of how many complete instantly — the
  // one honest limitation is this queue is shared across all 3 platforms
  // (see TARGET_INCLUDE above), so this is an aggregate cap, not a
  // per-platform one; splitting into per-platform queues would be real
  // rearchitecture this phase's rules don't call for.
  limiter: { max: env.PUBLISHING_RATE_LIMIT_MAX, duration: env.PUBLISHING_RATE_LIMIT_DURATION_MS },
});

publishingWorker.on("failed", (job, err) => {
  logger.error({ jobId: job?.id, attemptsMade: job?.attemptsMade, err }, "publishing job failed");
  if (isFinalAttempt(job) && job) {
    const { contentTargetId } = job.data as { contentTargetId: string };
    prisma.contentTarget
      .update({ where: { id: contentTargetId }, data: { status: "FAILED", errorMessage: err.message } })
      .then((target) => maybeFinalizeContentStatus(target.contentId))
      .catch((updateErr) => logger.error({ contentTargetId, updateErr }, "publishing: failed to record final FAILED state"));
  }
});

// Phase 10 TikTok hardening: one job per ContentTarget whose provider
// only *initiated* an async publish (TikTok's real Direct Post flow —
// see tiktok.provider.ts's checkPublishStatus). Re-enqueues itself
// (via publishing/enqueue.ts) until a terminal status or MAX_POLL_ATTEMPTS.
const publishStatusPollQueue = new Queue(QUEUE_NAMES.PUBLISH_STATUS_POLL, { connection });
const publishStatusPollWorker = new Worker(QUEUE_NAMES.PUBLISH_STATUS_POLL, processPublishStatusPoll, {
  connection,
  concurrency: 10,
  limiter: { max: env.PUBLISH_STATUS_POLL_RATE_LIMIT_MAX, duration: env.PUBLISH_STATUS_POLL_RATE_LIMIT_DURATION_MS },
});

publishStatusPollWorker.on("failed", (job, err) => {
  logger.error({ jobId: job?.id, attemptsMade: job?.attemptsMade, err }, "publish-status-poll job failed");
  if (isFinalAttempt(job) && job) {
    const { contentTargetId } = job.data as { contentTargetId: string };
    void recordPublishStatusPollFailure(contentTargetId, err);
  }
});

// Phase 09: manually-triggered per-target metrics fetch
// (apps/worker/src/analytics/). No retry/backoff — see
// analytics-sync.processor.ts's own doc for why a plain single-attempt
// Worker (no defaultJobOptions) is the right amount of machinery here.
const analyticsSyncQueue = new Queue(QUEUE_NAMES.ANALYTICS_SYNC, { connection });
const analyticsSyncWorker = new Worker(QUEUE_NAMES.ANALYTICS_SYNC, processAnalyticsSync, {
  connection,
  concurrency: 10,
  limiter: { max: env.ANALYTICS_SYNC_RATE_LIMIT_MAX, duration: env.ANALYTICS_SYNC_RATE_LIMIT_DURATION_MS },
});

analyticsSyncWorker.on("failed", (job, err) => {
  logger.error({ jobId: job?.id, err }, "analytics-sync job failed");
});

// Phase 10: repeatable scan that fans out the analytics-sync jobs above for
// PUBLISHED targets due a re-sync (see analytics-sync-scan.processor.ts).
// Single-item queue driven entirely by BullMQ's native repeatable-job
// scheduling — registered once below, right before the health server starts.
const analyticsSyncScanQueue = new Queue(QUEUE_NAMES.ANALYTICS_SYNC_SCAN, { connection });
const analyticsSyncScanWorker = new Worker(
  QUEUE_NAMES.ANALYTICS_SYNC_SCAN,
  processAnalyticsSyncScan,
  { connection, concurrency: 1 },
);

analyticsSyncScanWorker.on("failed", (job, err) => {
  logger.error({ jobId: job?.id, err }, "analytics-sync-scan job failed");
});

// Phase 10: one job per PlatformConnection nearing expiry
// (apps/worker/src/publishing/token.ts's forceRefreshAccessToken). Enqueued
// by the repeatable scan below via apps/worker/src/scheduled/producers.ts.
const tokenRefreshQueue = new Queue(QUEUE_NAMES.TOKEN_REFRESH, { connection });
const tokenRefreshWorker = new Worker(QUEUE_NAMES.TOKEN_REFRESH, processTokenRefresh, {
  connection,
  concurrency: 10,
  limiter: { max: env.TOKEN_REFRESH_RATE_LIMIT_MAX, duration: env.TOKEN_REFRESH_RATE_LIMIT_DURATION_MS },
});

tokenRefreshWorker.on("failed", (job, err) => {
  logger.error({ jobId: job?.id, err }, "token-refresh job failed");
});

// Phase 10: repeatable scan that fans out the token-refresh jobs above for
// connections nearing expiry (see token-refresh-scan.processor.ts).
const tokenRefreshScanQueue = new Queue(QUEUE_NAMES.TOKEN_REFRESH_SCAN, { connection });
const tokenRefreshScanWorker = new Worker(QUEUE_NAMES.TOKEN_REFRESH_SCAN, processTokenRefreshScan, { connection, concurrency: 1 });

tokenRefreshScanWorker.on("failed", (job, err) => {
  logger.error({ jobId: job?.id, err }, "token-refresh-scan job failed");
});

// Phase 1: DB↔Redis scheduling reconciler (apps/worker/src/scheduling). The
// database is the source of truth for what is scheduled; BullMQ only executes.
// Re-creates missing scheduling/publishing jobs, holds stale scheduled content
// instead of publishing it late, recovers targets stuck in PUBLISHING. Runs
// once at every worker start and then on an interval.
const schedulingPort = createBullMqSchedulingPort(env.REDIS_URL);
const reconcileConfig = buildReconcileConfig(env);
const schedulingReconcileQueue = new Queue(QUEUE_NAMES.SCHEDULING_RECONCILE, { connection });
const schedulingReconcileWorker = new Worker(
  QUEUE_NAMES.SCHEDULING_RECONCILE,
  async () => {
    const summary = await reconcileScheduling({ db: prisma, port: schedulingPort, config: reconcileConfig });
    const acted = Object.entries(summary).some(([key, value]) => key !== "scheduledChecked" && value > 0);
    if (acted) logger.info({ summary }, "scheduling-reconcile: run complete");
    else logger.debug({ summary }, "scheduling-reconcile: run complete, nothing to do");
    return summary;
  },
  { connection, concurrency: 1 },
);

schedulingReconcileWorker.on("failed", (job, err) => {
  logger.error({ jobId: job?.id, err }, "scheduling-reconcile job failed");
});

const SCAN_EVERY_MS = 15 * 60 * 1000;
const reconcileEveryMs = env.SCHEDULING_RECONCILE_INTERVAL_SECONDS * 1000;

/**
 * Guarantees the three repeatable jobs (analytics scan, token-refresh scan,
 * scheduling reconciler — BullMQ's native feature, not a new scheduler
 * dependency) are registered. Idempotent (see scheduling/ensure-repeatable.ts)
 * and called at boot AND on a timer: if Redis loses its state while this
 * process keeps running, every repeatable schedule vanishes with it and the
 * periodic work would otherwise stop until the next restart.
 *
 * `atBoot` always queues one reconcile immediately, so a restart recovers
 * missing/overdue work right away; after boot, one is queued only when the
 * reconciler's own schedule had to be re-created (a sign Redis lost state),
 * which is exactly when recovery is most needed.
 */
async function ensureScheduledJobs(atBoot: boolean): Promise<void> {
  await ensureRepeatable(analyticsSyncScanQueue, {
    name: QUEUE_NAMES.ANALYTICS_SYNC_SCAN,
    jobId: "analytics-sync-scan",
    everyMs: SCAN_EVERY_MS,
  });
  await ensureRepeatable(tokenRefreshScanQueue, {
    name: QUEUE_NAMES.TOKEN_REFRESH_SCAN,
    jobId: "token-refresh-scan",
    everyMs: SCAN_EVERY_MS,
  });
  const reconcile = await ensureRepeatable(schedulingReconcileQueue, {
    name: QUEUE_NAMES.SCHEDULING_RECONCILE,
    jobId: "scheduling-reconcile",
    everyMs: reconcileEveryMs,
  });

  if (!atBoot && reconcile === "registered") {
    logger.warn("repeatable schedules were missing while running (Redis state lost?) — re-registered, reconciling now");
  }
  if (atBoot || reconcile === "registered") {
    await schedulingReconcileQueue.add(QUEUE_NAMES.SCHEDULING_RECONCILE, {}, { removeOnComplete: true, removeOnFail: true });
  }
}

void ensureScheduledJobs(true).catch((err) => logger.error({ err }, "failed to register scheduled jobs"));

// Re-assert the schedules at least once a minute (cheap, idempotent). unref():
// this timer must never be the thing that keeps the process alive.
const ensureTimer = setInterval(
  () => void ensureScheduledJobs(false).catch((err) => logger.error({ err }, "failed to re-assert scheduled jobs")),
  Math.min(reconcileEveryMs, 60_000),
);
ensureTimer.unref();

// /health reports ready only once every worker is connected — a partial
// start (e.g. one queue's Redis subscription still pending) should not
// report healthy.
const readiness = {
  system: false,
  contentScheduling: false,
  contentGeneration: false,
  videoRender: false,
  publishing: false,
  publishStatusPoll: false,
  analyticsSync: false,
  analyticsSyncScan: false,
  tokenRefresh: false,
  tokenRefreshScan: false,
  schedulingReconcile: false,
};
function isReady(): boolean {
  return (
    readiness.system &&
    readiness.contentScheduling &&
    readiness.contentGeneration &&
    readiness.videoRender &&
    readiness.publishing &&
    readiness.publishStatusPoll &&
    readiness.analyticsSync &&
    readiness.analyticsSyncScan &&
    readiness.tokenRefresh &&
    readiness.tokenRefreshScan &&
    readiness.schedulingReconcile
  );
}

systemWorker.on("ready", () => {
  readiness.system = true;
  logger.info("Socialith worker ready and connected to Redis");
});

contentSchedulingWorker.on("ready", () => {
  readiness.contentScheduling = true;
  logger.info("content-scheduling worker ready and connected to Redis");
});

contentGenerationWorker.on("ready", () => {
  readiness.contentGeneration = true;
  logger.info("content-generation worker ready and connected to Redis");
});

videoRenderWorker.on("ready", () => {
  readiness.videoRender = true;
  logger.info("video-render worker ready and connected to Redis");
});

publishingWorker.on("ready", () => {
  readiness.publishing = true;
  logger.info("publishing worker ready and connected to Redis");
});

publishStatusPollWorker.on("ready", () => {
  readiness.publishStatusPoll = true;
  logger.info("publish-status-poll worker ready and connected to Redis");
});

analyticsSyncWorker.on("ready", () => {
  readiness.analyticsSync = true;
  logger.info("analytics-sync worker ready and connected to Redis");
});

analyticsSyncScanWorker.on("ready", () => {
  readiness.analyticsSyncScan = true;
  logger.info("analytics-sync-scan worker ready and connected to Redis");
});

tokenRefreshWorker.on("ready", () => {
  readiness.tokenRefresh = true;
  logger.info("token-refresh worker ready and connected to Redis");
});

tokenRefreshScanWorker.on("ready", () => {
  readiness.tokenRefreshScan = true;
  logger.info("token-refresh-scan worker ready and connected to Redis");
});

schedulingReconcileWorker.on("ready", () => {
  readiness.schedulingReconcile = true;
  logger.info("scheduling-reconcile worker ready and connected to Redis");
});

const healthServer = http.createServer((req, res) => {
  if (req.url === "/health") {
    const ready = isReady();
    res.writeHead(ready ? 200 : 503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, data: { status: ready ? "ok" : "starting" } }));
    return;
  }
  res.writeHead(404);
  res.end();
});

healthServer.listen(env.WORKER_PORT, () => {
  logger.info(`Socialith worker health endpoint listening on port ${env.WORKER_PORT}`);
});

async function shutdown(signal: string) {
  logger.info(`Received ${signal}, shutting down worker gracefully`);
  clearInterval(ensureTimer);
  await Promise.allSettled([
    systemWorker.close(),
    systemQueue.close(),
    contentSchedulingWorker.close(),
    contentSchedulingQueue.close(),
    contentGenerationWorker.close(),
    contentGenerationQueue.close(),
    videoRenderWorker.close(),
    videoRenderQueue.close(),
    publishingWorker.close(),
    publishingQueue.close(),
    publishStatusPollWorker.close(),
    publishStatusPollQueue.close(),
    closePublishingQueueProducer(),
    analyticsSyncWorker.close(),
    analyticsSyncQueue.close(),
    analyticsSyncScanWorker.close(),
    analyticsSyncScanQueue.close(),
    tokenRefreshWorker.close(),
    tokenRefreshQueue.close(),
    tokenRefreshScanWorker.close(),
    tokenRefreshScanQueue.close(),
    schedulingReconcileWorker.close(),
    schedulingReconcileQueue.close(),
    schedulingPort.close(),
    closeScheduledProducers(),
    connection.quit(),
    prisma.$disconnect(),
  ]);
  healthServer.close(() => process.exit(0));
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
