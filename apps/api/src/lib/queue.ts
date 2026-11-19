import Redis from "ioredis";
import { Queue } from "bullmq";
import { loadEnv } from "@socialith/config";
import {
  QUEUE_NAMES,
  contentSchedulingJobId,
  type ContentSchedulingJobData,
  type ContentGenerationJobData,
  type VideoRenderJobData,
  type PublishingJobData,
  type AnalyticsSyncJobData,
} from "@socialith/types";
import { logger } from "../logger.js";

/**
 * Shared-hosting/demo-lite tier: REDIS_URL is optional (see
 * @socialith/config), and this API process runs alone, without
 * apps/worker, on cPanel shared hosting where a persistent BullMQ
 * consumer isn't viable. Every enqueue* export below degrades to a
 * logged no-op when Redis isn't configured, instead of crashing the
 * request that called it — the real, honest limitation this creates is
 * that content generation, video rendering, scheduled publishing, and
 * analytics sync never run in that tier. Login/OAuth connect/Dashboard/
 * Accounts never call anything in this file (verified) and are
 * unaffected.
 */
const connection = loadEnv().REDIS_URL
  ? new Redis(loadEnv().REDIS_URL!, { maxRetriesPerRequest: null })
  : undefined;

connection?.on("error", (err) => {
  logger.error({ err }, "Queue Redis connection error");
});

if (!connection) {
  logger.warn(
    "REDIS_URL not configured — content generation, video rendering, scheduled publishing, and analytics sync are disabled in this deployment. Login, OAuth connect, Dashboard, and Accounts are unaffected.",
  );
}

const contentSchedulingQueue = connection
  ? new Queue<ContentSchedulingJobData>(QUEUE_NAMES.CONTENT_SCHEDULING, { connection })
  : undefined;
const contentGenerationQueue = connection
  ? new Queue<ContentGenerationJobData>(QUEUE_NAMES.CONTENT_GENERATION, { connection })
  : undefined;
const videoRenderQueue = connection ? new Queue<VideoRenderJobData>(QUEUE_NAMES.VIDEO_RENDER, { connection }) : undefined;
const publishingQueue = connection ? new Queue<PublishingJobData>(QUEUE_NAMES.PUBLISHING, { connection }) : undefined;
const analyticsSyncQueue = connection
  ? new Queue<AnalyticsSyncJobData>(QUEUE_NAMES.ANALYTICS_SYNC, { connection })
  : undefined;

/** Deterministic per-content job ID (shared with the worker's reconciler via @socialith/types) — enqueuing again for the same content
 * (re-scheduling) removes any prior pending job first, so a content item
 * never ends up with two competing scheduled transitions. */
const jobIdFor = contentSchedulingJobId;

/**
 * Enqueues (or re-enqueues) the delayed job that flips this content from
 * SCHEDULED to PUBLISHING/FAILED once `scheduledAt` arrives. Called after
 * content-target.service.ts's scheduleContent() transaction commits, so
 * the DB state and the queued job never disagree about whether scheduling
 * succeeded. No-ops (with a warning) when Redis isn't configured — the
 * Content row itself still ends up SCHEDULED in the DB, it just never
 * transitions further without a worker.
 */
export async function enqueueContentScheduling(contentId: string, scheduledAt: Date): Promise<void> {
  if (!contentSchedulingQueue) {
    logger.warn({ contentId }, "enqueueContentScheduling: no-op, Redis not configured");
    return;
  }
  const jobId = jobIdFor(contentId);
  await contentSchedulingQueue.remove(jobId);
  const delay = Math.max(0, scheduledAt.getTime() - Date.now());
  await contentSchedulingQueue.add(QUEUE_NAMES.CONTENT_SCHEDULING, { contentId }, { jobId, delay });
}

/**
 * Real retry/backoff for the Phase 07 pipeline: transient failures (a
 * flaky AI provider response, a momentary FFmpeg hiccup) get retried a
 * few times with exponential backoff before the job is left failed;
 * content-scheduling above has no such retry because a scheduling
 * transition either succeeds deterministically or is a permanent
 * "nothing to publish" state — retrying it can't change the outcome.
 */
const GENERATION_JOB_OPTIONS = { attempts: 3, backoff: { type: "exponential", delay: 5000 } } as const;

/**
 * `jobId: jobRowId` makes this call idempotent at the BullMQ level: BullMQ
 * refuses to create a second job with an id already present in the queue,
 * so even if a caller somehow invoked this twice for the same DB row, only
 * one job ever runs. The real duplicate-request guard (a user clicking
 * "Generate" twice) lives one layer up, in the service functions that
 * decide whether to create a new job ROW at all — see
 * content-generation.service.ts / video-render.service.ts. No-ops (with a
 * warning) when Redis isn't configured — the ContentGenerationJob row
 * stays PENDING forever without a worker, a real and visible limitation
 * rather than a fabricated success.
 */
export async function enqueueContentGeneration(jobRowId: string): Promise<void> {
  if (!contentGenerationQueue) {
    logger.warn({ jobRowId }, "enqueueContentGeneration: no-op, Redis not configured");
    return;
  }
  await contentGenerationQueue.add(QUEUE_NAMES.CONTENT_GENERATION, { jobRowId }, { jobId: jobRowId, ...GENERATION_JOB_OPTIONS });
}

export async function enqueueVideoRender(jobRowId: string): Promise<void> {
  if (!videoRenderQueue) {
    logger.warn({ jobRowId }, "enqueueVideoRender: no-op, Redis not configured");
    return;
  }
  await videoRenderQueue.add(QUEUE_NAMES.VIDEO_RENDER, { jobRowId }, { jobId: jobRowId, ...GENERATION_JOB_OPTIONS });
}

export interface QueueHealthEntry {
  name: string;
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
}

/**
 * Phase 10 §17: real per-queue backlog counts for the API's /health
 * endpoint — not just "is Redis reachable" but "is work actually flowing"
 * (a growing `failed`/`waiting` count with no worker consuming it is
 * exactly the kind of thing a health check should surface). Queried from
 * this same producer connection, not a new one. Returns an empty array
 * when Redis isn't configured — health.ts only calls this once it has
 * already confirmed Redis is reachable.
 */
export async function getQueueHealth(): Promise<QueueHealthEntry[]> {
  const queues = [contentSchedulingQueue, contentGenerationQueue, videoRenderQueue, publishingQueue, analyticsSyncQueue].filter(
    (q): q is NonNullable<typeof q> => q !== undefined,
  );
  return Promise.all(
    queues.map(async (queue) => {
      const counts = await queue.getJobCounts("waiting", "active", "delayed", "failed");
      return {
        name: queue.name,
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        delayed: counts.delayed ?? 0,
        failed: counts.failed ?? 0,
      };
    }),
  );
}

/**
 * Phase 08: same queue apps/worker's content-scheduling processor enqueues
 * onto for a scheduled publish — this producer exists here too so
 * content-target.service.ts's manual retry endpoint can enqueue a
 * publishing job directly, without a scheduling delay. `jobId:
 * contentTargetId` gives the same BullMQ-level dedup guarantee as every
 * other queue in this codebase: a target can never have two publish jobs
 * in flight at once. Unlike content-generation/video-render (each DB job
 * row gets a fresh cuid, so its jobId is never reused), a ContentTarget's
 * id is reused across a retry — BullMQ keeps a completed/failed job's
 * record around for a while, so adding again with the same id would
 * otherwise silently no-op instead of running a new attempt. `.remove()`
 * first, exactly like enqueueContentScheduling above, avoids that.
 */
const PUBLISH_JOB_OPTIONS = { attempts: 4, backoff: { type: "exponential", delay: 10_000 } } as const;

export async function enqueuePublishingJob(contentTargetId: string): Promise<void> {
  if (!publishingQueue) {
    logger.warn({ contentTargetId }, "enqueuePublishingJob: no-op, Redis not configured");
    return;
  }
  await publishingQueue.remove(contentTargetId);
  await publishingQueue.add(
    QUEUE_NAMES.PUBLISHING,
    { contentTargetId },
    { jobId: contentTargetId, ...PUBLISH_JOB_OPTIONS },
  );
}

/**
 * Phase 09: manually-triggered metrics sync (analytics.service.ts's
 * "sync now"). No retry/backoff options — a failed fetch is safe to
 * re-trigger by hand and isn't time-critical the way a publish attempt
 * is (see apps/worker's analytics-sync.processor.ts). `.remove()` first
 * for the same reuse-of-id reason as enqueuePublishingJob above.
 */
export async function enqueueAnalyticsSync(contentTargetId: string): Promise<void> {
  if (!analyticsSyncQueue) {
    logger.warn({ contentTargetId }, "enqueueAnalyticsSync: no-op, Redis not configured");
    return;
  }
  await analyticsSyncQueue.remove(contentTargetId);
  await analyticsSyncQueue.add(QUEUE_NAMES.ANALYTICS_SYNC, { contentTargetId }, { jobId: contentTargetId });
}

export async function closeQueues(): Promise<void> {
  await Promise.allSettled([
    contentSchedulingQueue?.close(),
    contentGenerationQueue?.close(),
    videoRenderQueue?.close(),
    publishingQueue?.close(),
    analyticsSyncQueue?.close(),
    connection?.quit(),
  ]);
}
