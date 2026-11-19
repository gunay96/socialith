/**
 * BullMQ options for the publishing / status-poll queues, in a module with
 * NO import-time side effects (publishing/enqueue.ts opens a Redis
 * connection when imported). Shared by enqueue.ts and the scheduling
 * reconciler's queue port so a recovered job is created with exactly the
 * same retry behavior as a normally-enqueued one.
 */
export const PUBLISH_JOB_OPTIONS = { attempts: 4, backoff: { type: "exponential", delay: 10_000 } } as const;

/** First poll delay and the fixed interval between subsequent polls — TikTok allows 30 status-fetch requests/minute per user token; 15s keeps this comfortably under that even with several targets polling the same account. */
export const PUBLISH_STATUS_POLL_INTERVAL_MS = 15_000;

export const PUBLISH_STATUS_POLL_JOB_OPTIONS = {
  // A real transient error (network blip, TikTok rate-limited/5xx) during
  // one poll gets BullMQ's own retry before the processor's own
  // attempt-counter logic (up to MAX_POLL_ATTEMPTS re-enqueues for "still
  // processing") ever comes into play — the two are orthogonal: this is
  // retrying one HTTP call, attempt/MAX_POLL_ATTEMPTS is spacing out
  // repeated real status checks over time.
  attempts: 3,
  backoff: { type: "exponential", delay: 5_000 },
} as const;
