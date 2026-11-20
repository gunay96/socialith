import { describe, expect, it } from "vitest";
import { PUBLICATION_STATES, allowedActions, derivePublicationState, isActive, isTerminal, schedulingOwner, type PublicationStateInput } from "./state.js";

const base: PublicationStateInput = { status: "PENDING", approvalStatus: "DRAFT", exception: null, attemptCount: 0, hasProviderPublication: false };
const d = (over: Partial<PublicationStateInput>) => derivePublicationState({ ...base, ...over });

describe("derivePublicationState", () => {
  it("walks the happy path DRAFT → READY_FOR_REVIEW → APPROVED → SCHEDULED → QUEUED → PUBLISHING → PUBLISHED", () => {
    expect(d({})).toBe("DRAFT");
    expect(d({ approvalStatus: "READY_FOR_REVIEW" })).toBe("READY_FOR_REVIEW");
    expect(d({ approvalStatus: "APPROVED" })).toBe("APPROVED");
    expect(d({ approvalStatus: "APPROVED", status: "SCHEDULED" })).toBe("SCHEDULED");
    expect(d({ approvalStatus: "APPROVED", status: "PUBLISHING" })).toBe("QUEUED");
    expect(d({ approvalStatus: "APPROVED", status: "PUBLISHING", attemptCount: 1 })).toBe("PUBLISHING");
    expect(d({ approvalStatus: "APPROVED", status: "PUBLISHING", hasProviderPublication: true })).toBe("PUBLISHING");
    expect(d({ approvalStatus: "APPROVED", status: "PUBLISHED", attemptCount: 1 })).toBe("PUBLISHED");
  });

  it("exception states: REJECTED, FAILED, CANCELLED, STALE, HELD", () => {
    expect(d({ approvalStatus: "REJECTED" })).toBe("REJECTED");
    expect(d({ status: "FAILED", approvalStatus: "APPROVED" })).toBe("FAILED");
    expect(d({ exception: "CANCELLED" })).toBe("CANCELLED");
    expect(d({ exception: "HELD", approvalStatus: "APPROVED" })).toBe("HELD");
    // a missed slot is STALE, not a platform failure
    expect(d({ status: "FAILED", exception: "STALE" })).toBe("STALE");
  });

  it("operator markers beat the approval state only while PENDING; execution always wins", () => {
    expect(d({ exception: "HELD", approvalStatus: "REJECTED" })).toBe("HELD");
    expect(d({ status: "SCHEDULED", exception: "HELD" })).toBe("SCHEDULED"); // a stale marker on a live row never hides execution
    expect(d({ status: "PUBLISHED", exception: "CANCELLED" })).toBe("PUBLISHED");
    expect(d({ status: "FAILED", exception: "HELD" })).toBe("FAILED");
  });

  it("every combination of the stored columns maps to exactly one of the twelve states", () => {
    const statuses = ["PENDING", "SCHEDULED", "PUBLISHING", "PUBLISHED", "FAILED"] as const;
    const approvals = ["DRAFT", "READY_FOR_REVIEW", "APPROVED", "REJECTED"] as const;
    const exceptions = [null, "HELD", "CANCELLED", "STALE"] as const;
    const seen = new Set<string>();
    for (const status of statuses) for (const approvalStatus of approvals) for (const exception of exceptions) for (const attemptCount of [0, 2]) for (const hasProviderPublication of [false, true]) {
      const s = derivePublicationState({ status, approvalStatus, exception, attemptCount, hasProviderPublication });
      expect(PUBLICATION_STATES).toContain(s);
      seen.add(s);
    }
    expect([...seen].sort()).toEqual([...PUBLICATION_STATES].sort()); // all twelve are reachable
  });
});

describe("allowedActions", () => {
  it("approval-required: DRAFT cannot be scheduled directly; APPROVED can", () => {
    expect(allowedActions("DRAFT", true)).not.toContain("SCHEDULE");
    expect(allowedActions("DRAFT", false)).toContain("SCHEDULE");
    expect(allowedActions("APPROVED", true)).toContain("SCHEDULE");
  });

  it("only a reviewer-visible state offers APPROVE / REJECT, and only READY_FOR_REVIEW does", () => {
    for (const s of PUBLICATION_STATES) {
      const a = allowedActions(s, true);
      expect(a.includes("APPROVE")).toBe(s === "READY_FOR_REVIEW");
      expect(a.includes("REJECT")).toBe(s === "READY_FOR_REVIEW");
    }
  });

  it("nothing can be done to a publication that is in flight or published; a scheduled one cannot be edited in place", () => {
    for (const s of ["QUEUED", "PUBLISHING", "PUBLISHED"] as const) expect(allowedActions(s, true)).toEqual([]);
    expect(allowedActions("SCHEDULED", true)).not.toContain("EDIT");
    expect(allowedActions("SCHEDULED", true)).toEqual(expect.arrayContaining(["RESCHEDULE", "UNSCHEDULE", "HOLD", "CANCEL"]));
  });

  it("recovery paths: FAILED retries, STALE retries or reschedules, HELD releases, CANCELLED reopens", () => {
    expect(allowedActions("FAILED", true)).toContain("RETRY");
    expect(allowedActions("STALE", true)).toEqual(expect.arrayContaining(["RETRY", "RESCHEDULE"]));
    expect(allowedActions("HELD", true)).toContain("RELEASE");
    expect(allowedActions("CANCELLED", true)).toEqual(["REOPEN"]);
  });
});

describe("helpers", () => {
  it("scheduling owner is only defined for SCHEDULED", () => {
    expect(schedulingOwner("SCHEDULED", false)).toBe("SOCIALITH");
    expect(schedulingOwner("SCHEDULED", true)).toBe("PROVIDER");
    expect(schedulingOwner("PUBLISHED", true)).toBe("NONE");
    expect(schedulingOwner("APPROVED", false)).toBe("NONE");
  });
  it("terminal / active", () => {
    expect(isTerminal("PUBLISHED")).toBe(true);
    expect(isTerminal("FAILED")).toBe(false);
    expect(isActive("QUEUED")).toBe(true);
    expect(isActive("HELD")).toBe(false);
  });
});
