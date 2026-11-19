import { describe, expect, it } from "vitest";
import { canActOnMember, canAssignRole, canManageTeam, hasMinimumRole } from "./rbac.js";

describe("hasMinimumRole", () => {
  it("ranks OWNER above ADMIN above EDITOR above VIEWER", () => {
    expect(hasMinimumRole("OWNER", "ADMIN")).toBe(true);
    expect(hasMinimumRole("ADMIN", "OWNER")).toBe(false);
    expect(hasMinimumRole("EDITOR", "VIEWER")).toBe(true);
    expect(hasMinimumRole("VIEWER", "EDITOR")).toBe(false);
  });

  it("is reflexive", () => {
    for (const role of ["OWNER", "ADMIN", "EDITOR", "VIEWER"] as const) {
      expect(hasMinimumRole(role, role)).toBe(true);
    }
  });
});

describe("canManageTeam", () => {
  it("allows OWNER and ADMIN only", () => {
    expect(canManageTeam("OWNER")).toBe(true);
    expect(canManageTeam("ADMIN")).toBe(true);
    expect(canManageTeam("EDITOR")).toBe(false);
    expect(canManageTeam("VIEWER")).toBe(false);
  });
});

describe("canAssignRole", () => {
  it("only lets an OWNER grant the OWNER role", () => {
    expect(canAssignRole("OWNER", "OWNER")).toBe(true);
    expect(canAssignRole("ADMIN", "OWNER")).toBe(false);
  });

  it("lets ADMIN assign non-OWNER roles", () => {
    expect(canAssignRole("ADMIN", "ADMIN")).toBe(true);
    expect(canAssignRole("ADMIN", "EDITOR")).toBe(true);
    expect(canAssignRole("ADMIN", "VIEWER")).toBe(true);
  });

  it("never lets EDITOR/VIEWER assign any role", () => {
    expect(canAssignRole("EDITOR", "VIEWER")).toBe(false);
    expect(canAssignRole("VIEWER", "VIEWER")).toBe(false);
  });
});

describe("canActOnMember", () => {
  it("prevents ADMIN from acting on an OWNER", () => {
    expect(canActOnMember("ADMIN", "OWNER")).toBe(false);
  });

  it("lets OWNER act on anyone, including other owners", () => {
    expect(canActOnMember("OWNER", "OWNER")).toBe(true);
    expect(canActOnMember("OWNER", "ADMIN")).toBe(true);
  });

  it("lets ADMIN act on non-OWNER members", () => {
    expect(canActOnMember("ADMIN", "ADMIN")).toBe(true);
    expect(canActOnMember("ADMIN", "EDITOR")).toBe(true);
    expect(canActOnMember("ADMIN", "VIEWER")).toBe(true);
  });

  it("never lets EDITOR/VIEWER act on members", () => {
    expect(canActOnMember("EDITOR", "VIEWER")).toBe(false);
    expect(canActOnMember("VIEWER", "VIEWER")).toBe(false);
  });
});
