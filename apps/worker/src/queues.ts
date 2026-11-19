/**
 * Relocated to packages/types/src/queues.ts in Phase 06 so apps/api can
 * import the same queue names (apps/api has no dependency path to
 * apps/worker/src, only to workspace packages). This file stays as a
 * thin re-export so apps/worker/src/index.ts's existing
 * `import { QUEUE_NAMES } from "./queues.js"` keeps working unchanged.
 */
export * from "@socialith/types";
