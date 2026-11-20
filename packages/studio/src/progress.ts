/**
 * Progress rules (docs/SOCIALITH_UX_DESIGN_SYSTEM.md section 6, docs/LIVE_OPERATIONS_ARCHITECTURE.md).
 *
 * The only place that turns a persisted task row into something the interface may draw. The rules are enforced HERE so
 * the API and the web can never disagree:
 *   1. A percentage exists only when both numbers are real: completedUnits and a known totalUnits > 0.
 *      percentage = completedUnits / totalUnits x 100, nothing else, no smoothing, no estimate.
 *   2. Without a total the task is indeterminate (a running task) or has no progress to show (a finished one).
 *   3. A task that says it is running but has not reported for a long time is flagged stalled, not shown as live.
 *   4. Time is only ever measured from real timestamps; there is no ETA.
 */

export type TaskStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";

export interface TaskProgressInput {
  status: TaskStatus;
  completedUnits: number;
  totalUnits: number | null;
  startedAt?: Date | string | null;
  finishedAt?: Date | string | null;
  lastProgressAt?: Date | string | null;
}

export type ProgressMode = "determinate" | "indeterminate" | "none";

export interface ProgressView {
  mode: ProgressMode;
  completedUnits: number;
  totalUnits: number | null;
  /** completed / total x 100, one decimal, clamped to 0-100. null unless mode is "determinate". */
  percentage: number | null;
  /** Real elapsed time from startedAt (to finishedAt, or to `now` while running); null when it never started. */
  elapsedMs: number | null;
  /** RUNNING but silent for longer than the stall window: the worker may be gone. Never drawn as live progress. */
  stalled: boolean;
  /** completedUnits exceeded totalUnits (a bug upstream): the bar is clamped and this says so. */
  inconsistent: boolean;
}

/** A running task that has not reported for this long is considered stalled. */
export const DEFAULT_STALL_AFTER_MS = 2 * 60 * 1000;

const toMs = (value: Date | string | null | undefined): number | null => {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
};

export function computeProgress(task: TaskProgressInput, now: Date = new Date(), stallAfterMs: number = DEFAULT_STALL_AFTER_MS): ProgressView {
  const completed = Number.isFinite(task.completedUnits) && task.completedUnits > 0 ? Math.floor(task.completedUnits) : 0;
  const total = task.totalUnits !== null && Number.isFinite(task.totalUnits) && task.totalUnits > 0 ? Math.floor(task.totalUnits) : null;
  const active = task.status === "QUEUED" || task.status === "RUNNING";

  const startedMs = toMs(task.startedAt);
  const finishedMs = toMs(task.finishedAt);
  const elapsedMs = startedMs === null ? null : Math.max(0, (finishedMs ?? (active ? now.getTime() : startedMs)) - startedMs);

  const lastMs = toMs(task.lastProgressAt) ?? startedMs;
  const stalled = task.status === "RUNNING" && lastMs !== null && now.getTime() - lastMs > stallAfterMs;

  if (total !== null) {
    const raw = (completed / total) * 100;
    return {
      mode: "determinate",
      completedUnits: completed,
      totalUnits: total,
      percentage: Math.round(Math.min(100, Math.max(0, raw)) * 10) / 10,
      elapsedMs,
      stalled,
      inconsistent: completed > total,
    };
  }
  return { mode: active ? "indeterminate" : "none", completedUnits: completed, totalUnits: null, percentage: null, elapsedMs, stalled, inconsistent: false };
}

/** "2 min 05 s" / "45 s" / "1 h 03 min" from a real duration. */
export function formatElapsed(ms: number | null): string {
  if (ms === null) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, "0")} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}
