import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { requireMinimumRole } from "./rbac.js";
import type { SafeUser } from "../types/auth.js";

function fakeUser(role: SafeUser["role"]): SafeUser {
  return {
    id: "user_1",
    organizationId: "org_1",
    name: "Test User",
    email: "test@example.com",
    role,
    status: "ACTIVE",
    lastLoginAt: null,
    createdAt: new Date(),
  };
}

function runMiddleware(minimumRole: SafeUser["role"], user: SafeUser | undefined) {
  const req = { user } as unknown as Request;
  const res = {} as Response;
  const next = vi.fn();

  requireMinimumRole(minimumRole)(req, res, next);
  return next;
}

describe("requireMinimumRole", () => {
  it("rejects unauthenticated requests with AUTH_REQUIRED (401), not FORBIDDEN", () => {
    const next = runMiddleware("VIEWER", undefined);
    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err.statusCode).toBe(401);
    expect(err.code).toBe("AUTH_REQUIRED");
  });

  it("allows OWNER through a requirement of ADMIN", () => {
    const next = runMiddleware("ADMIN", fakeUser("OWNER"));
    expect(next).toHaveBeenCalledWith(); // called with no error
  });

  it("allows ADMIN through a requirement of ADMIN", () => {
    const next = runMiddleware("ADMIN", fakeUser("ADMIN"));
    expect(next).toHaveBeenCalledWith();
  });

  it("blocks EDITOR from a requirement of ADMIN with FORBIDDEN (403)", () => {
    const next = runMiddleware("ADMIN", fakeUser("EDITOR"));
    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe("FORBIDDEN");
  });

  it("blocks VIEWER from a requirement of EDITOR with FORBIDDEN (403)", () => {
    const next = runMiddleware("EDITOR", fakeUser("VIEWER"));
    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe("FORBIDDEN");
  });

  it("allows any role through a requirement of VIEWER", () => {
    for (const role of ["OWNER", "ADMIN", "EDITOR", "VIEWER"] as const) {
      const next = runMiddleware("VIEWER", fakeUser(role));
      expect(next).toHaveBeenCalledWith();
    }
  });
});
