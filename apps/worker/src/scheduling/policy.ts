/**
 * Pure scheduling policy — no I/O, so every rule here is unit-testable.
 *
 * FUTURE  scheduledAt is still ahead            → a delayed job should exist
 * DUE     scheduledAt passed, within the window → publish (late by at most the window)
 * STALE   scheduledAt passed by MORE than the window → never auto-published
 *
 * The window exists because publishing hours-old "scheduled" content after
 * an outage, a restored Redis snapshot or a leftover seed row is worse than
 * not publishing it: a human decides. The boundary is inclusive — exactly
 * `staleAfterMs` late is still DUE.
 */
export type ScheduleKind = "FUTURE" | "DUE" | "STALE";

export interface ScheduleClassification {
  kind: ScheduleKind;
  /** Milliseconds until scheduledAt (0 unless FUTURE). */
  delayMs: number;
  /** Milliseconds past scheduledAt (0 unless DUE/STALE). */
  lateByMs: number;
}

export function classifySchedule(scheduledAt: Date, now: Date, staleAfterMs: number): ScheduleClassification {
  const diff = scheduledAt.getTime() - now.getTime();
  if (diff > 0) return { kind: "FUTURE", delayMs: diff, lateByMs: 0 };
  const lateByMs = Math.max(0, -diff); // max() also normalizes -0 to 0
  return { kind: lateByMs > staleAfterMs ? "STALE" : "DUE", delayMs: 0, lateByMs };
}

/** A scheduling job that fires more than this early is left alone (the reconciler re-enqueues it with the right delay). */
export const EARLY_FIRE_TOLERANCE_MS = 5_000;

export function staleHoldMessage(scheduledAt: Date, staleAfterMinutes: number): string {
  return (
    `Missed its scheduled time (${scheduledAt.toISOString()}) by more than ${staleAfterMinutes} minutes, ` +
    "so it was not published automatically. Review it, then retry the target to publish now."
  );
}

export function stuckFailureMessage(recoveryMaxAgeHours: number): string {
  return (
    `Stuck in PUBLISHING for more than ${recoveryMaxAgeHours} hours without a result; ` +
    "not retried automatically. Check the platform, then retry the target manually."
  );
}
