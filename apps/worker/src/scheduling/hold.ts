import type { PrismaClient } from "@socialith/database";
import { PROVIDER_OWNED, SOCIALITH_OWNED } from "./ownership.js";
import { staleHoldMessage } from "./policy.js";

export interface StaleContent {
  id: string;
  organizationId: string;
  scheduledAt: Date;
}

/**
 * Holds (never publishes) a scheduled content item whose time is long past:
 * content + its still-SCHEDULED targets become FAILED with an explanatory
 * message the dashboard already renders, and an audit-log row records why.
 * "Retry" on a target still publishes it immediately, so a human stays in
 * control.
 *
 * Compare-and-set on `status = SCHEDULED` inside one transaction: safe to
 * call from the reconciler and from the scheduling processor at the same
 * time (exactly one of them wins; the loser returns false and writes
 * nothing). Returns true only when this call performed the hold.
 */
export async function holdStaleContent(
  db: PrismaClient,
  content: StaleContent,
  staleAfterMinutes: number,
  heldAt: Date,
): Promise<boolean> {
  const message = staleHoldMessage(content.scheduledAt, staleAfterMinutes);

  return db.$transaction(async (tx) => {
    // Targets the Upload-Post scheduler owns are never held or failed by Socialith. If some targets are
    // provider-owned, only the Socialith-owned ones are held and the content itself stays SCHEDULED until
    // the provider reports (the roll-up then finalizes it).
    const providerOwned = await tx.contentTarget.count({ where: { contentId: content.id, status: "SCHEDULED", ...PROVIDER_OWNED } });
    if (providerOwned > 0) {
      const heldTargets = await tx.contentTarget.updateMany({
        where: { contentId: content.id, status: "SCHEDULED", ...SOCIALITH_OWNED },
        data: { status: "FAILED", errorMessage: message },
      });
      if (heldTargets.count === 0) return false;
      await tx.auditLog.create({
        data: {
          organizationId: content.organizationId,
          action: "SCHEDULE_HELD_STALE",
          targetType: "Content",
          targetId: content.id,
          metadataJson: { scheduledAt: content.scheduledAt.toISOString(), heldAt: heldAt.toISOString(), staleAfterMinutes, partial: true, providerOwnedTargets: providerOwned },
        },
      });
      return true;
    }

    const changed = await tx.content.updateMany({
      where: { id: content.id, status: "SCHEDULED" },
      data: { status: "FAILED" },
    });
    if (changed.count === 0) return false;

    await tx.contentTarget.updateMany({
      where: { contentId: content.id, status: "SCHEDULED" },
      data: { status: "FAILED", errorMessage: message },
    });
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
        },
      },
    });
    return true;
  });
}
