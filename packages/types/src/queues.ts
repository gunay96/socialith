/**
 * Queue names shared by API (enqueue side) and worker (process side).
 * Lives in @socialith/types (not apps/worker/src, where it originated in
 * Phase 01) specifically so apps/api can import it too — apps/api has no
 * dependency path to apps/worker's src, only to workspace packages.
 * apps/worker/src/queues.ts now just re-exports this for its existing
 * call sites.
 *
 * Processors for each queue are implemented in the phase that owns them:
 *   content-generation → Phase 07
 *   video-render        → Phase 07
 *   publishing          → Phase 08 (this phase — one job per ContentTarget,
 *                          enqueued by apps/worker's content-scheduling
 *                          processor once a target reaches PUBLISHING)
 *   publish-status-poll → Phase 10 TikTok hardening — one job per
 *                          ContentTarget whose provider only *initiated*
 *                          an async publish (TikTok's real Direct Post
 *                          flow). Re-enqueues itself with a bounded
 *                          attempt counter until TikTok's status-fetch
 *                          endpoint reports a terminal state.
 *   analytics-sync      → Phase 09, automated in Phase 10: still one job
 *                          per ContentTarget, but now also enqueued by a
 *                          repeatable analytics-sync-scan job (below) on
 *                          top of the manual "sync now" trigger — both
 *                          paths converge on the same queue/processor.
 *   analytics-sync-scan → Phase 10 (this phase) — a single BullMQ
 *                          *repeatable* job (native BullMQ feature, not a
 *                          new scheduler system) that finds PUBLISHED
 *                          targets due for a refresh and fans out
 *                          analytics-sync jobs for them.
 *   content-scheduling  → Phase 06 (this phase — see apps/worker/src's
 *                          content-scheduling processor; transitions due
 *                          SCHEDULED content to PUBLISHING, never calls a
 *                          real platform API)
 *   token-refresh       → Phase 10 (this phase) — one job per
 *                          PlatformConnection nearing expiry; calls the
 *                          same centralized resolveAccessToken() the
 *                          publishing/analytics processors already use.
 *   token-refresh-scan  → Phase 10 (this phase) — repeatable scan,
 *                          mirrors analytics-sync-scan's role for
 *                          token-refresh.
 *   notifications       → originally attributed to Phase 03 in this
 *                          comment, but Phase 03's actual scope (as
 *                          built) was the dashboard shell/nav only — no
 *                          notifications processor exists yet. Left
 *                          unowned/unclaimed rather than silently
 *                          "corrected" to a guessed phase number.
 *   cleanup              → Phase 10
 */
export const QUEUE_NAMES = {
  CONTENT_GENERATION: "content-generation",
  VIDEO_RENDER: "video-render",
  PUBLISHING: "publishing",
  PUBLISH_STATUS_POLL: "publish-status-poll",
  ANALYTICS_SYNC: "analytics-sync",
  ANALYTICS_SYNC_SCAN: "analytics-sync-scan",
  CONTENT_SCHEDULING: "content-scheduling",
  // Phase 1: repeatable DB↔Redis reconciler — re-creates missing scheduling
  // jobs, holds stale scheduled content, recovers stuck PUBLISHING targets
  // (apps/worker/src/scheduling).
  SCHEDULING_RECONCILE: "scheduling-reconcile",
  // Phase 2: Upload-Post provider work (profile sync, hand-off/drift/status sweep,
  // webhook-triggered reconciliation) - apps/worker/src/upload-post.
  UPLOAD_POST: "upload-post",
  // Phase 5A: ZIP extraction and media analysis (apps/worker/src/media).
  MEDIA_PROCESSING: "media-processing",
  TOKEN_REFRESH: "token-refresh",
  TOKEN_REFRESH_SCAN: "token-refresh-scan",
  NOTIFICATIONS: "notifications",
  CLEANUP: "cleanup",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export const JOB_PRIORITY = {
  HIGH: 1,
  NORMAL: 5,
  LOW: 10,
} as const;

/** Payload shape for QUEUE_NAMES.CONTENT_SCHEDULING jobs — shared by the
 * producer (apps/api/src/lib/queue.ts) and consumer
 * (apps/worker/src/processors/content-scheduling.processor.ts) so the two
 * can't drift out of sync. */
export interface ContentSchedulingJobData {
  contentId: string;
}

/**
 * The one deterministic BullMQ job id for a content item's scheduling job.
 * Shared by the producer in apps/api (scheduleContent) and by the worker's
 * reconciler so both always agree on which job "belongs" to a content item
 * — a mismatch here would let the reconciler create a second, competing
 * job.
 */
export function contentSchedulingJobId(contentId: string): string {
  return `content-scheduling-${contentId}`;
}

/**
 * Payload shapes for the Phase 07 pipeline's two queues. Both carry only
 * the DB row's id — the row itself (ContentGenerationJob/VideoRenderJob)
 * is the single source of truth for everything else (contentId,
 * organizationId, platform/operation, ...), so the job payload can't
 * drift out of sync with what's actually in Postgres.
 */
export interface ContentGenerationJobData {
  jobRowId: string;
}

export interface VideoRenderJobData {
  jobRowId: string;
}

/** Payload for QUEUE_NAMES.PUBLISHING jobs — the ContentTarget row is the
 * single source of truth (status, attemptCount, socialAccountId, ...),
 * same reasoning as the two job data shapes above. */
export interface PublishingJobData {
  contentTargetId: string;
}

/** Payload for QUEUE_NAMES.ANALYTICS_SYNC jobs — same reasoning as PublishingJobData. */
export interface AnalyticsSyncJobData {
  contentTargetId: string;
}

/** Payload for QUEUE_NAMES.TOKEN_REFRESH jobs. */
export interface TokenRefreshJobData {
  platformConnectionId: string;
}

/**
 * Payload for QUEUE_NAMES.PUBLISH_STATUS_POLL jobs — one per ContentTarget
 * whose provider returned PublishSuccess.pendingConfirmation (today: only
 * TikTok's real async Direct Post flow). `attempt` is carried explicitly
 * (not re-derived from BullMQ's own job.attemptsMade, which counts
 * *failures/retries* of a single job — this queue instead re-enqueues a
 * fresh job per poll, so attempt is this job data's own bounded counter).
 */
export interface PublishStatusPollJobData {
  contentTargetId: string;
  attempt: number;
}

/**
 * Payload for QUEUE_NAMES.UPLOAD_POST jobs. Repeatable jobs carry only `kind`.
 *  - sync       provider profiles/accounts -> database (read-only towards the provider)
 *  - sweep      hand-off to the provider scheduler, drift (cancel/reschedule) and status reconciliation
 *  - reconcile  triggered by a verified webhook: re-read the authoritative provider status for ONE
 *               publication (the webhook payload is only a hint, never trusted for state changes)
 */
export type UploadPostJobData =
  | { kind: "sync"; trigger: "SCHEDULED" | "MANUAL" | "STARTUP"; organizationId?: string }
  | { kind: "sweep" }
  | { kind: "reconcile"; requestId?: string; jobId?: string; externalId?: string; deliveryId?: string };

/** Deterministic BullMQ job id for an on-demand Upload-Post sync (one in flight at a time). */
export const UPLOAD_POST_MANUAL_SYNC_JOB_ID = "upload-post-manual-sync";

/**
 * Payload for QUEUE_NAMES.MEDIA_PROCESSING jobs (Phase 5A). The OperationTask row is the source of truth for progress and
 * outcome; the job only says what to do and to what.
 *  - EXTRACT_ZIP     scan + safely extract a pack's archive, then analyze every extracted file
 *  - ANALYZE_ASSET   probe one stored asset and make its thumbnail
 */
export type MediaProcessingJobData =
  | { kind: "EXTRACT_ZIP"; taskId: string; packId: string }
  | { kind: "ANALYZE_ASSET"; taskId: string; assetId: string };

/**
 * One deterministic BullMQ job id per task: enqueuing the same task twice (a double click, a retry of the request, a
 * recovery sweep) is a no-op instead of a second job. Shared by the producer (apps/api) and the worker's recovery.
 */
export function mediaProcessingJobId(taskId: string): string {
  return `media-task-${taskId}`;
}