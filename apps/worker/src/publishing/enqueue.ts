import Redis from "ioredis";
import { Queue } from "bullmq";
import { loadEnv } from "@socialith/config";
import { QUEUE_NAMES, type PublishingJobData, type PublishStatusPollJobData } from "@socialith/types";
import { logger } from "../logger.js";

/**
 * A small dedicated producer, symmetric with apps/api/src/lib/queue.ts —
 * here because the *enqueuer* of a publishing job is
 * content-scheduling.processor.ts, running inside apps/worker itself
 * (Content → ContentTarget transitions to PUBLISHING, then one publishing
 * job per target is queued), not apps/api. Its own Redis connection,
 * `maxRetriesPerRequest: null`, same reasoning as every other BullMQ
 * connection in this codebase. REDIS_URL is optional at the config-schema
 * level (the shared-hosting API tier boots without it — see
 * apps/api/src/index.ts), but apps/worker itself still requires it
 * (index.ts throws fast at boot if it's missing), so the non-null
 * assertion here just reflects that already-enforced invariant.
 */
const connection = new Redis(loadEnv().REDIS_URL!, { maxRetriesPerRequest: null });

connection.on("error", (err) => {
  logger.error({ err }, "Publishing queue producer Redis connection error");
});

const publishingQueue = new Queue<PublishingJobData>(QUEUE_NAMES.PUBLISHING, { connection });
const publishStatusPollQueue = new Queue<PublishStatusPollJobData>(QUEUE_NAMES.PUBLISH_STATUS_POLL, { connection });

const PUBLISH_JOB_OPTIONS = { attempts: 4, backoff: { type: "exponential", delay: 10_000 } } as const;

/**
 * Deterministic `jobId: contentTargetId` — this is the idempotency
 * guarantee that a given ContentTarget can never have two competing
 * publish jobs in flight at once (BullMQ refuses to re-add a job whose id
 * is already present), on top of the processor's own DB-status guard.
 * `.remove()` first: a target's id can be reused by a later retry after
 * its first (completed/failed) job already exists under that same id in
 * Redis — without removing it first, re-adding would silently no-op
 * instead of running a new attempt. Mirrors
 * apps/api/src/lib/queue.ts's identically-named producer, which the
 * manual-retry endpoint calls instead of this one (this one is only for
 * the scheduled-publish path, running inside the worker itself).
 */
export async function enqueuePublishingJob(contentTargetId: string): Promise<void> {
  await publishingQueue.remove(contentTargetId);
  await publishingQueue.add(
    QUEUE_NAMES.PUBLISHING,
    { contentTargetId },
    { jobId: contentTargetId, ...PUBLISH_JOB_OPTIONS },
  );
}

/** First poll delay and the fixed interval between subsequent polls — TikTok allows 30 status-fetch requests/minute per user token; 15s keeps this comfortably under that even with several targets polling the same account. */
const PUBLISH_STATUS_POLL_INTERVAL_MS = 15_000;

/**
 * Deterministic `jobId: contentTargetId`, same reasoning as
 * enqueuePublishingJob — a target can only ever have one poll in flight.
 * `.remove()` first since a target's id is reused across polls (each
 * poll re-adds under the same id with the next attempt number).
 */
export async function enqueuePublishStatusPoll(contentTargetId: string, attempt: number): Promise<void> {
  await publishStatusPollQueue.remove(contentTargetId);
  await publishStatusPollQueue.add(
    QUEUE_NAMES.PUBLISH_STATUS_POLL,
    { contentTargetId, attempt },
    {
      jobId: contentTargetId,
      delay: PUBLISH_STATUS_POLL_INTERVAL_MS,
      // A real transient error (network blip, TikTok rate-limited/5xx)
      // during one poll gets BullMQ's own retry before the processor's
      // own attempt-counter logic (up to MAX_POLL_ATTEMPTS re-enqueues
      // for "still processing") ever comes into play — the two are
      // orthogonal: this is retrying one HTTP call, attempt/MAX_POLL_ATTEMPTS
      // is spacing out repeated real status checks over time.
      attempts: 3,
      backoff: { type: "exponential", delay: 5_000 },
    },
  );
}

export async function closePublishingQueueProducer(): Promise<void> {
  await Promise.allSettled([publishingQueue.close(), publishStatusPollQueue.close(), connection.quit()]);
}
