/**
 * The publication lifecycle, derived from what is stored.
 *
 * A "publication" is one ContentTarget (one content item for ONE destination). Its stored columns are:
 *   status          PENDING | SCHEDULED | PUBLISHING | PUBLISHED | FAILED   (execution — unchanged from before Phase 3)
 *   approvalStatus  DRAFT | READY_FOR_REVIEW | APPROVED | REJECTED           (human workflow — Phase 3)
 *   exception       HELD | CANCELLED | STALE | null                         (operator / stale-guard markers — Phase 3)
 * The twelve states an operator sees are a pure function of those (plus two facts about publishing progress), so
 * the two never disagree and no existing enum had to change.
 */

export const PUBLICATION_STATES = [
  "DRAFT",
  "READY_FOR_REVIEW",
  "APPROVED",
  "SCHEDULED",
  "QUEUED",
  "PUBLISHING",
  "PUBLISHED",
  "REJECTED",
  "FAILED",
  "CANCELLED",
  "STALE",
  "HELD",
] as const;
export type PublicationState = (typeof PUBLICATION_STATES)[number];

export type TargetStatus = "PENDING" | "SCHEDULED" | "PUBLISHING" | "PUBLISHED" | "FAILED";
export type ApprovalStatus = "DRAFT" | "READY_FOR_REVIEW" | "APPROVED" | "REJECTED";
export type PublicationException = "HELD" | "CANCELLED" | "STALE";

export interface PublicationStateInput {
  status: TargetStatus;
  approvalStatus: ApprovalStatus;
  exception: PublicationException | null;
  /** ContentTarget.attemptCount */
  attemptCount: number;
  /** An UploadPostPublication row exists (the provider has been, or is being, asked). */
  hasProviderPublication: boolean;
}

/**
 * - PUBLISHED / FAILED come from execution; a FAILED target carrying the STALE marker is a missed slot, not a failure.
 * - PUBLISHING with no attempt yet and no provider row is QUEUED (a publishing job is waiting for the worker); the
 *   first attempt (or the first provider request) makes it PUBLISHING.
 * - PENDING is the "not scheduled" bucket: an operator marker (HELD / CANCELLED) wins, otherwise the approval state.
 */
export function derivePublicationState(i: PublicationStateInput): PublicationState {
  switch (i.status) {
    case "PUBLISHED":
      return "PUBLISHED";
    case "FAILED":
      return i.exception === "STALE" ? "STALE" : "FAILED";
    case "PUBLISHING":
      return i.attemptCount === 0 && !i.hasProviderPublication ? "QUEUED" : "PUBLISHING";
    case "SCHEDULED":
      return "SCHEDULED";
    case "PENDING":
      if (i.exception === "HELD") return "HELD";
      if (i.exception === "CANCELLED") return "CANCELLED";
      return i.approvalStatus;
  }
}

/** Where the clock for a SCHEDULED publication runs. Mirrors apps/worker/src/scheduling/ownership.ts. */
export type SchedulingOwner = "SOCIALITH" | "PROVIDER" | "NONE";

export function schedulingOwner(state: PublicationState, providerScheduled: boolean): SchedulingOwner {
  if (state !== "SCHEDULED") return "NONE";
  return providerScheduled ? "PROVIDER" : "SOCIALITH";
}

export type PublicationAction =
  | "EDIT"
  | "SUBMIT"
  | "WITHDRAW"
  | "APPROVE"
  | "REJECT"
  | "SCHEDULE"
  | "RESCHEDULE"
  | "UNSCHEDULE"
  | "HOLD"
  | "RELEASE"
  | "CANCEL"
  | "REOPEN"
  | "RETRY";

/**
 * Which operator actions make sense in a state. The API enforces the same table (and re-checks atomically with a
 * compare-and-set), the dashboard uses it to show only what is possible. Nothing is allowed while a publication is
 * in flight (QUEUED/PUBLISHING) or finished (PUBLISHED).
 */
export function allowedActions(state: PublicationState, approvalRequired: boolean): PublicationAction[] {
  switch (state) {
    case "DRAFT":
      return approvalRequired ? ["EDIT", "SUBMIT", "CANCEL"] : ["EDIT", "SUBMIT", "SCHEDULE", "CANCEL"];
    case "READY_FOR_REVIEW":
      return ["APPROVE", "REJECT", "WITHDRAW", "EDIT", "CANCEL"];
    case "APPROVED":
      return ["SCHEDULE", "EDIT", "CANCEL"];
    case "REJECTED":
      return ["EDIT", "SUBMIT", "CANCEL"];
    case "SCHEDULED":
      return ["RESCHEDULE", "UNSCHEDULE", "HOLD", "CANCEL"];
    case "HELD":
      return ["RELEASE", "RESCHEDULE", "CANCEL"];
    case "FAILED":
      return ["RETRY", "CANCEL"];
    case "STALE":
      return ["RETRY", "RESCHEDULE", "CANCEL"];
    case "CANCELLED":
      return ["REOPEN"];
    case "QUEUED":
    case "PUBLISHING":
    case "PUBLISHED":
      return [];
  }
}

export function isTerminal(state: PublicationState): boolean {
  return state === "PUBLISHED" || state === "CANCELLED";
}

/** States in which the target will still be fired (or is being fired) by a scheduler or worker. */
export function isActive(state: PublicationState): boolean {
  return state === "SCHEDULED" || state === "QUEUED" || state === "PUBLISHING";
}

export const STATE_LABELS: Record<PublicationState, string> = {
  DRAFT: "Draft",
  READY_FOR_REVIEW: "Ready for review",
  APPROVED: "Approved",
  SCHEDULED: "Scheduled",
  QUEUED: "Queued",
  PUBLISHING: "Publishing",
  PUBLISHED: "Published",
  REJECTED: "Rejected",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
  STALE: "Stale (missed its slot)",
  HELD: "Held",
};
