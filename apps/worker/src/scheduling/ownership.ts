import type { Prisma } from "@socialith/database";

/**
 * Who owns the clock for a SCHEDULED ContentTarget.
 *
 * Socialith owns the master schedule. Hybrid hand-off (UPLOAD_POST_SCHEDULE_HANDOFF_ENABLED) may give an
 * upcoming target to Upload-Post's own scheduler; from then until the provider reports a result, that target
 * is PROVIDER-OWNED and every Socialith mechanism that would fire it (the content-scheduling job, the stale
 * hold, the reconciler's job re-creation) must skip it — a target is never scheduled in both systems.
 *
 * "Owned" includes the not-yet-confirmed states (PENDING, UNKNOWN_OUTCOME): a hand-off request that may or
 * may not have reached the provider must not be raced by a Socialith publish. The Upload-Post sweep resolves
 * those rows (adopts the provider job or releases the target) well before the due time.
 */
export const PROVIDER_OWNED: Prisma.ContentTargetWhereInput = {
  uploadPostPublication: {
    is: { mode: "PROVIDER_SCHEDULED", status: { in: ["PENDING", "UNKNOWN_OUTCOME", "SCHEDULED_AT_PROVIDER"] } },
  },
};

/** Targets Socialith itself must fire (everything that is not provider-owned, including targets with no publication row). */
export const SOCIALITH_OWNED: Prisma.ContentTargetWhereInput = { NOT: PROVIDER_OWNED };
