import { describe, expect, it } from "vitest";
import { DEFAULT_PUBLISHING_POLICY, evaluateApprover } from "./policy.js";

const base = { actorId: "u1", submitterId: "u1", ownerSelfApproval: true, adminSelfApproval: false };
const as = (role: string, over: Partial<typeof base> = {}) => evaluateApprover({ ...base, role, ...over });

describe("defaults (product decision)", () => {
  it("approval is required by default; the owner may approve their own work, an admin may not", () => {
    expect(DEFAULT_PUBLISHING_POLICY).toEqual({ requireApproval: true, ownerSelfApproval: true, adminSelfApproval: false });
  });
});

describe("evaluateApprover", () => {
  it("OWNER can approve their own submission (default) — and it is flagged as a self-approval", () => {
    expect(as("OWNER")).toEqual({ allowed: true, selfApproval: true });
  });
  it("OWNER approving someone else's submission is not a self-approval", () => {
    expect(as("OWNER", { submitterId: "u2" })).toEqual({ allowed: true, selfApproval: false });
  });
  it("the organization can forbid owner self-approval", () => {
    const v = as("OWNER", { ownerSelfApproval: false });
    expect(v).toMatchObject({ allowed: false, selfApproval: true, code: "SELF_APPROVAL_NOT_ALLOWED" });
  });
  it("ADMIN cannot approve their own submission by default, can when the organization allows it, always can approve others'", () => {
    expect(as("ADMIN")).toMatchObject({ allowed: false, code: "SELF_APPROVAL_NOT_ALLOWED" });
    expect(as("ADMIN", { adminSelfApproval: true })).toEqual({ allowed: true, selfApproval: true });
    expect(as("ADMIN", { submitterId: "u2" })).toEqual({ allowed: true, selfApproval: false });
  });
  it("the owner switch and the admin switch are independent", () => {
    expect(as("OWNER", { adminSelfApproval: false }).allowed).toBe(true);
    expect(as("ADMIN", { ownerSelfApproval: true, adminSelfApproval: false }).allowed).toBe(false);
  });
  it("a CREATOR can never approve — not their own submission, not anyone's, whatever the switches say", () => {
    for (const submitterId of ["u1", "u2", null]) {
      const v = as("CREATOR", { submitterId, ownerSelfApproval: true, adminSelfApproval: true });
      expect(v, String(submitterId)).toMatchObject({ allowed: false, code: "CREATOR_CANNOT_APPROVE" });
    }
    expect(as("creator", { submitterId: "u1" })).toMatchObject({ allowed: false, code: "CREATOR_CANNOT_APPROVE" }); // case-insensitive
  });
  it("EDITOR and VIEWER cannot approve at all", () => {
    for (const role of ["EDITOR", "VIEWER", "SOMETHING_ELSE"]) expect(as(role, { submitterId: "u2" }), role).toMatchObject({ allowed: false, code: "ROLE_CANNOT_APPROVE" });
  });
  it("an unknown submitter (legacy row) is never treated as a self-approval", () => {
    expect(as("ADMIN", { submitterId: null })).toEqual({ allowed: true, selfApproval: false });
  });
});
