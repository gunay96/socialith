import type { PrismaClient } from "@socialith/database";
import { PROVIDER_OWNED, SOCIALITH_OWNED } from "./ownership.js";
import { staleHoldMessage } from "./policy.js";
import { rollUpContent } from "./rollup.js";

export interface StaleContent {
  id: string;
  organizationId: string;
  /** Content.scheduledAt: the fallback time of a target that has none of its own. */
  scheduledAt: Date;
}

/**
 * Holds (never publishes) the scheduled targets of a content item that missed their time by more than the stale
 * window: each such target becomes FAILED carrying the STALE marker and an explanatory message the dashboard already
 * renders, an audit-log row and a publication event record why. "Retry" on a target still publishes it
 * immediately, so a human stays in control.
 *
 * Targets are judged by THEIR OWN scheduled time (Phase 3: they can be scheduled independently), so a target due
 * tomorrow is never touched because a sibling is overdue. The content itself becomes FAILED (legacy behaviour) only
 * when nothing is left scheduled; otherwise it stays SCHEDULED and its time moves to the earliest remaining target.
 * Targets the Upload-Post scheduler owns are never held by Socialith (scheduling/ownership.ts).
 *
 * Compare-and-set on `status = SCHEDULED` inside one transaction: safe to call from the reconciler and from the
 * scheduling processor at the same time (exactly one of them wins; the loser returns false and writes nothing).
 * Returns true only when this call held at least one target.
 */
export async function holdStaleContent(
  db: PrismaClient,
  content: StaleContent,
  staleAfterMinutes: number,
  heldAt: Date,
): Promise<boolean> {
  const cutoff = new Date(heldAt.getTime() - staleAfterMinutes * 60_000);
  const contentIsStale = content.scheduledAt.getTime() < cutoff.getTime();

  return db.$transaction(async (tx) => {
    const candidates = await tx.contentTarget.findMany({
      where: {
        contentId: content.id,
        status: "SCHEDULED",
        ...SOCIALITH_OWNED,
        OR: [{ scheduledAt: { lt: cutoff } }, ...(contentIsStale ? [{ scheduledAt: null }] : [])],
      },
      select: { id: true, scheduledAt: true },
    });
    const heldIds: string[] = [];
    for (const target of candidates) {
      const at = target.scheduledAt ?? content.scheduledAt;
      const changed = await tx.contentTarget.updateMany({
        where: { id: target.id, status: "SCHEDULED" },
        data: { status: "FAILED", exception: "STALE", errorMessage: staleHoldMessage(at, staleAfterMinutes) },
      });
      if (changed.count === 1) {
        heldIds.push(target.id);
        await tx.publicationEvent.create({
          data: {
            organizationId: content.organizationId,
            contentTargetId: target.id,
            type: "MARKED_STALE",
            fromState: "SCHEDULED",
            toState: "STALE",
            actorId: null,
            reason: staleHoldMessage(at, staleAfterMinutes),
            metadata: { scheduledAt: at.toISOString(), heldAt: heldAt.toISOString(), staleAfterMinutes },
          },
        });
      }
    }
    if (heldIds.length === 0) return false;

    const providerOwned = await tx.contentTarget.count({ where: { contentId: content.id, status: "SCHEDULED", ...PROVIDER_OWNED } });
    const stillScheduled = await tx.contentTarget.count({ where: { contentId: content.id, status: "SCHEDULED" } });
    await rollUpContent(tx, content.id); // SCHEDULED at the next time while something is left, FAILED when nothing is (legacy outcome)

    await tx.auditLog.create({
      data: {
        organizationId: content.organizationId,
        action: "SCHEDULE_HELD_STALE",
        targetType: "Content",
        targetId: content.id,
        metadataJson: {
          scheduledAt: content.scheduledAt.toISOString(),
          heldAt: heldAt.toISOString(),
          staleAfterMinutes,
          heldTargets: heldIds.length,
          ...(stillScheduled > 0 ? { partial: true, remainingScheduledTargets: stillScheduled, providerOwnedTargets: providerOwned } : {}),
        },
      },
    });
    return true;
  });
}
