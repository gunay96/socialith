import { describe, expect, it } from "vitest";
import { createInvitationSchema, changeRoleSchema, acceptInvitationSchema } from "./team.validation.js";

describe("createInvitationSchema", () => {
  it("accepts ADMIN, EDITOR, VIEWER", () => {
    for (const role of ["ADMIN", "EDITOR", "VIEWER"]) {
      expect(createInvitationSchema.safeParse({ email: "a@example.com", role }).success).toBe(true);
    }
  });

  it("rejects OWNER — spec: OWNER cannot be assigned through invitation", () => {
    const result = createInvitationSchema.safeParse({ email: "a@example.com", role: "OWNER" });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid email", () => {
    expect(createInvitationSchema.safeParse({ email: "not-an-email", role: "VIEWER" }).success).toBe(false);
  });

  it("rejects a missing role", () => {
    expect(createInvitationSchema.safeParse({ email: "a@example.com" }).success).toBe(false);
  });
});

describe("changeRoleSchema", () => {
  it("accepts all four roles, including OWNER (gated later by canAssignRole, not here)", () => {
    for (const role of ["OWNER", "ADMIN", "EDITOR", "VIEWER"]) {
      expect(changeRoleSchema.safeParse({ role }).success).toBe(true);
    }
  });

  it("rejects an unknown role string", () => {
    expect(changeRoleSchema.safeParse({ role: "SUPERADMIN" }).success).toBe(false);
  });
});

describe("acceptInvitationSchema", () => {
  it("accepts a valid name and a 12+ character password", () => {
    expect(acceptInvitationSchema.safeParse({ name: "Ada Lovelace", password: "correct-horse-battery" }).success).toBe(
      true,
    );
  });

  it("rejects a password shorter than 12 characters", () => {
    expect(acceptInvitationSchema.safeParse({ name: "Ada", password: "short" }).success).toBe(false);
  });

  it("rejects an empty name", () => {
    expect(acceptInvitationSchema.safeParse({ name: "  ", password: "correct-horse-battery" }).success).toBe(false);
  });
});
