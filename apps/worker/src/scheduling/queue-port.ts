import Redis from "ioredis";
import { Queue } from "bullmq";
import {
  QUEUE_NAMES,
  contentSchedulingJobId,
  type ContentSchedulingJobData,
  type PublishingJobData,
  type PublishStatusPollJobData,
} from "@socialith/types";
import {
  PUBLISH_JOB_OPTIONS,
  PUBLISH_STATUS_POLL_INTERVAL_MS,
  PUBLISH_STATUS_POLL_JOB_OPTIONS,
} from "../publishing/job-options.js";

/** "live" = BullMQ will still run it; "finished" = completed/failed (kept in Redis, will never run again); "absent" = no such job. */
export type JobLiveness = "live" | "finished" | "absent";

/**
 * Everything the reconciler needs from Redis, as a narrow interface — keeps
 * reconcile.ts testable against a fake and keeps BullMQ details in one file.
 */
export interface SchedulingQueuePort {
  contentSchedulingLiveness(contentId: string): Promise<JobLiveness>;
  /** No-op when a live job already exists; replaces a finished one; otherwise adds a delayed job. */
  enqueueContentScheduling(contentId: string, delayMs: number): Promise<void>;
  /** Best-effort removal of a not-yet-running job (used when content is held as stale). */
  removeContentScheduling(contentId: string): Promise<void>;
  publishingLiveness(contentTargetId: string): Promise<JobLiveness>;
  enqueuePublishing(contentTargetId: string): Promise<void>;
  publishStatusPollLiveness(contentTargetId: string): Promise<JobLiveness>;
  enqueuePublishStatusPoll(contentTargetId: string, attempt: number): Promise<void>;
  close(): Promise<void>;
}

/**
 * BullMQ job states → liveness. An unrecognized state is treated as live on
 * purpose: leaving a job alone is the safe error, creating a competing one
 * is not.
 */
export function classifyJobState(state: string): JobLiveness {
  if (state === "completed" || state === "failed") return "finished";
  return "live";
}

export interface SchedulingPortOptions {
  /** BullMQ key prefix — only for test isolation; production uses BullMQ's default ("bull"), which the API and workers share. */
  prefix?: string;
}

export function createBullMqSchedulingPort(redisUrl: string, options: SchedulingPortOptions = {}): SchedulingQueuePort {
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const queueOptions = { connection, ...(options.prefix ? { prefix: options.prefix } : {}) };
  const contentScheduling = new Queue<ContentSchedulingJobData>(QUEUE_NAMES.CONTENT_SCHEDULING, queueOptions);
  const publishing = new Queue<PublishingJobData>(QUEUE_NAMES.PUBLISHING, queueOptions);
  const publishStatusPoll = new Queue<PublishStatusPollJobData>(QUEUE_NAMES.PUBLISH_STATUS_POLL, queueOptions);

  async function liveness(queue: Queue, jobId: string): Promise<JobLiveness> {
    const job = await queue.getJob(jobId);
    if (!job) return "absent";
    return classifyJobState(await job.getState());
  }

  /** Removes a finished job (so its id can be reused); returns false if a live job is in the way. */
  async function clearFinished(queue: Queue, jobId: string): Promise<boolean> {
    const job = await queue.getJob(jobId);
    if (!job) return true;
    if (classifyJobState(await job.getState()) === "live") return false;
    await job.remove();
    return true;
  }

  return {
    contentSchedulingLiveness: (contentId) => liveness(contentScheduling, contentSchedulingJobId(contentId)),

    async enqueueContentScheduling(contentId, delayMs) {
      const jobId = contentSchedulingJobId(contentId);
      if (!(await clearFinished(contentScheduling, jobId))) return;
      await contentScheduling.add(QUEUE_NAMES.CONTENT_SCHEDULING, { contentId }, { jobId, delay: Math.max(0, delayMs) });
    },

    async removeContentScheduling(contentId) {
      const job = await contentScheduling.getJob(contentSchedulingJobId(contentId));
      if (!job) return;
      try {
        await job.remove();
      } catch {
        // Locked because it is running right now: the processor's own stale
        // guard (processContentScheduling) holds it instead.
      }
    },

    publishingLiveness: (id) => liveness(publishing, id),

    async enqueuePublishing(contentTargetId) {
      if (!(await clearFinished(publishing, contentTargetId))) return;
      await publishing.add(
        QUEUE_NAMES.PUBLISHING,
        { contentTargetId },
        { jobId: contentTargetId, ...PUBLISH_JOB_OPTIONS },
      );
    },

    publishStatusPollLiveness: (id) => liveness(publishStatusPoll, id),

    async enqueuePublishStatusPoll(contentTargetId, attempt) {
      if (!(await clearFinished(publishStatusPoll, contentTargetId))) return;
      await publishStatusPoll.add(
        QUEUE_NAMES.PUBLISH_STATUS_POLL,
        { contentTargetId, attempt },
        { jobId: contentTargetId, delay: PUBLISH_STATUS_POLL_INTERVAL_MS, ...PUBLISH_STATUS_POLL_JOB_OPTIONS },
      );
    },

    async close() {
      await Promise.allSettled([contentScheduling.close(), publishing.close(), publishStatusPoll.close(), connection.quit()]);
    },
  };
}
