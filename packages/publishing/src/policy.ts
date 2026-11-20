/**
 * Approval policy — who may approve, and when approving your own submission is allowed.
 *
 * Product decisions (Phase 3 final):
 *  - approval is REQUIRED by default, for new organizations and for organizations that never saved a preference;
 *    an explicitly saved preference is always honoured and never silently changed;
 *  - the OWNER may approve their own submissions; every other approver (ADMIN) only if the organization allows it;
 *  - a CREATOR can never approve anything, least of all their own submission (the Creator role arrives in Phase 8 —
 *    the rule is already enforced here, so it holds the day the role exists);
 *  - EDITOR / VIEWER cannot approve at all;
 *  - a self-approval is always recorded as such (audit event + publication event), whatever the policy says.
 */

export const DEFAULT_PUBLISHING_POLICY = {
  /** Approval before scheduling/publishing. On unless an organization explicitly saved otherwise. */
  requireApproval: true,
  /** OWNER may approve what they submitted themselves. */
  ownerSelfApproval: true,
  /** ADMIN may approve what they submitted themselves. Off: a second person is needed. */
  adminSelfApproval: false,
} as const;

export interface ApproverInput {
  /** Role of the person approving: OWNER | ADMIN | EDITOR | VIEWER | CREATOR (case-insensitive). */
  role: string;
  actorId: string;
  /** Who submitted the publication for review (null when unknown). */
  submitterId: string | null;
  ownerSelfApproval: boolean;
  adminSelfApproval: boolean;
}

export type ApproverVerdict =
  | { allowed: true; selfApproval: boolean }
  | { allowed: false; selfApproval: boolean; code: "ROLE_CANNOT_APPROVE" | "CREATOR_CANNOT_APPROVE" | "SELF_APPROVAL_NOT_ALLOWED"; message: string };

export function evaluateApprover(i: ApproverInput): ApproverVerdict {
  const role = i.role.toUpperCase();
  const selfApproval = i.submitterId !== null && i.submitterId === i.actorId;

  if (role === "CREATOR") {
    return {
      allowed: false,
      selfApproval,
      code: "CREATOR_CANNOT_APPROVE",
      message: "Creators cannot approve content — a creator's own submission always needs someone else's approval.",
    };
  }
  if (role !== "OWNER" && role !== "ADMIN") {
    return { allowed: false, selfApproval, code: "ROLE_CANNOT_APPROVE", message: "Only an owner or an admin can approve a publication." };
  }
  if (selfApproval) {
    const allowed = role === "OWNER" ? i.ownerSelfApproval : i.adminSelfApproval;
    if (!allowed) {
      return {
        allowed: false,
        selfApproval,
        code: "SELF_APPROVAL_NOT_ALLOWED",
        message:
          role === "OWNER"
            ? "Publishing Settings do not allow the owner to approve their own submission: another approver is needed."
            : "Admins cannot approve what they submitted themselves under the current Publishing Settings: the owner or another admin must approve it.",
      };
    }
  }
  return { allowed: true, selfApproval };
}
