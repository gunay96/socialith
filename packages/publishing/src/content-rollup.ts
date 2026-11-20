import type { PublicationException, TargetStatus } from "./state.js";

/**
 * Content.status is a roll-up of its targets. Targets can now be scheduled, held, cancelled and published
 * independently, so the roll-up is one pure function used by the API (after an operator action) and the worker
 * (after firing or holding targets), keeping both in agreement.
 *
 * Rules, in order:
 *   any target SCHEDULED                      → SCHEDULED, and Content.scheduledAt = the earliest of them
 *   else any target PUBLISHING                → PUBLISHING
 *   else any live PENDING target (a draft, an approved item not scheduled yet; HELD/CANCELLED do not count)
 *                                             → READY when nothing has run yet, otherwise PUBLISHING (work remains)
 *   else everything has settled               → FAILED if any failed, PUBLISHED if any published, otherwise READY
 */
export interface TargetGroup {
  status: TargetStatus;
  exception: PublicationException | null;
  count: number;
  /** earliest scheduledAt within the group */
  minScheduledAt: Date | null;
}

export type ContentRollupStatus = "READY" | "SCHEDULED" | "PUBLISHING" | "PUBLISHED" | "FAILED";

export function computeContentRollup(groups: TargetGroup[]): { status: ContentRollupStatus; scheduledAt: Date | null } {
  const sum = (pred: (g: TargetGroup) => boolean) => groups.filter(pred).reduce((n, g) => n + g.count, 0);
  const scheduled = groups.filter((g) => g.status === "SCHEDULED" && g.count > 0);
  if (scheduled.length > 0) {
    const times = scheduled.map((g) => g.minScheduledAt).filter((d): d is Date => d !== null);
    const earliest = times.length ? new Date(Math.min(...times.map((d) => d.getTime()))) : null;
    return { status: "SCHEDULED", scheduledAt: earliest };
  }
  if (sum((g) => g.status === "PUBLISHING") > 0) return { status: "PUBLISHING", scheduledAt: null };
  const published = sum((g) => g.status === "PUBLISHED");
  const failed = sum((g) => g.status === "FAILED");
  const livePending = sum((g) => g.status === "PENDING" && g.exception === null);
  if (livePending > 0) return { status: published + failed > 0 ? "PUBLISHING" : "READY", scheduledAt: null };
  if (failed > 0) return { status: "FAILED", scheduledAt: null };
  if (published > 0) return { status: "PUBLISHED", scheduledAt: null };
  return { status: "READY", scheduledAt: null };
}