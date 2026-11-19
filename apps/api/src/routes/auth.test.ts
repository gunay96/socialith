import { describe, expect, it, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// vi.hoisted: this state must exist before the vi.mock factory below runs
// (vi.mock calls are hoisted above regular imports/consts by Vitest).
const { prismaMock, seedUser, seedPasswordResetToken, resetFixtures, auditLogCreateMock } = vi.hoisted(() => {
  const users = new Map<string, Record<string, unknown>>();
  const passwordResetTokens = new Map<string, Record<string, unknown>>();
  const auditLogCreateMock = vi.fn().mockResolvedValue({});

  function seedUser(overrides: Record<string, unknown> = {}) {
    const user = {
      id: "user_1",
      organizationId: "org_1",
      name: "Test Owner",
      email: "owner@example.com",
      passwordHash: "hashed:correct-password",
      role: "OWNER",
      status: "ACTIVE",
      lastLoginAt: null as Date | null,
      sessionVersion: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
    users.set(user.id as string, user);
    return user;
  }

  function seedPasswordResetToken(overrides: Record<string, unknown> = {}) {
    const token = {
      id: "reset_1",
      userId: "user_1",
      tokenHash: "",
      usedAt: null as Date | null,
      expiresAt: new Date(Date.now() + 100000),
      createdAt: new Date(),
      ...overrides,
    };
    passwordResetTokens.set(token.id as string, token);
    return token;
  }

  function resetFixtures() {
    users.clear();
    passwordResetTokens.clear();
    auditLogCreateMock.mockClear();
  }

  const prismaMock = {
    user: {
      findUnique: async ({ where }: { where: { email?: string; id?: string } }) => {
        if (where.email) {
          return [...users.values()].find((u) => u.email === where.email) ?? null;
        }
        if (where.id) {
          return users.get(where.id) ?? null;
        }
        return null;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const user = users.get(where.id);
        if (!user) throw new Error("user not found");
        // Mirror Prisma's atomic `{ increment: n }` update operator,
        // since repositories/user.repository.ts's
        // updatePasswordAndInvalidateSessions relies on it for the
        // sessionVersion bump.
        const patch = { ...data };
        if (
          patch.sessionVersion &&
          typeof patch.sessionVersion === "object" &&
          "increment" in (patch.sessionVersion as Record<string, unknown>)
        ) {
          const incrementBy = (patch.sessionVersion as { increment: number }).increment;
          patch.sessionVersion = (user.sessionVersion as number) + incrementBy;
        }
        Object.assign(user, patch);
        return user;
      },
    },
    passwordResetToken: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const token = { id: `reset_${passwordResetTokens.size + 1}`, createdAt: new Date(), ...data };
        passwordResetTokens.set(token.id as string, token);
        return token;
      },
      findUnique: async ({ where }: { where: { tokenHash: string } }) =>
        [...passwordResetTokens.values()].find((t) => t.tokenHash === where.tokenHash) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const token = passwordResetTokens.get(where.id);
        if (!token) throw new Error("password reset token not found");
        Object.assign(token, data);
        return token;
      },
    },
    auditLog: {
      create: auditLogCreateMock,
    },
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(prismaMock),
  };

  return { prismaMock, seedUser, seedPasswordResetToken, resetFixtures, auditLogCreateMock };
});

vi.mock("@socialith/database", () => ({ prisma: prismaMock }));

// Mocked with a cheap, deterministic stand-in (real scrypt hashing is
// intentionally slow) so this file tests the auth *flow* (session, audit
// logging, generic errors, sessionVersion invalidation) rather than the
// hashing implementation itself — packages/auth/src/password.test.ts
// covers that separately, against the real node:crypto implementation.
vi.mock("@socialith/auth", () => ({
  hashPassword: vi.fn(async (pwd: string) => `hashed:${pwd}`),
  verifyPassword: vi.fn(async (hash: string, pwd: string) => hash === `hashed:${pwd}`),
  generateSecureToken: vi.fn(() => "fake-token-for-dummy-hash"),
  hashToken: vi.fn((raw: string) => `hashed-token:${raw}`),
}));

vi.mock("@socialith/config", async () => {
  const actual = await vi.importActual<typeof import("@socialith/config")>("@socialith/config");
  return {
    ...actual,
    loadEnv: vi.fn(() => ({
      NODE_ENV: "test",
      NEXT_PUBLIC_APP_URL: "http://localhost:3000",
      DATABASE_URL: "postgresql://test",
      REDIS_URL: "redis://test",
      SESSION_SECRET: "a-long-enough-test-only-secret",
      API_PORT: 4000,
      WORKER_PORT: 4100,
      EMAIL_PROVIDER: "console",
    })),
  };
});

const { createAuthRouter } = await import("./auth.js");
const { createSessionMiddleware } = await import("../lib/session.js");
const { errorHandler, notFoundHandler } = await import("../middleware/error-handler.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(createSessionMiddleware({ SESSION_SECRET: "a-long-enough-test-only-secret", NODE_ENV: "test" }));
  app.use(
    "/api",
    createAuthRouter({
      loginRateLimiter: (_req, _res, next) => next(),
      forgotPasswordRateLimiter: (_req, _res, next) => next(),
      resetPasswordRateLimiter: (_req, _res, next) => next(),
    }),
  );
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  resetFixtures();
});

describe("POST /api/auth/login", () => {
  it("returns 200 with safe user fields and sets a session cookie on success", async () => {
    seedUser();
    const res = await request(buildApp())
      .post("/api/auth/login")
      .send({ email: "owner@example.com", password: "correct-password" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.email).toBe("owner@example.com");
    expect(res.body.data.passwordHash).toBeUndefined();
    expect(res.body.data.sessionVersion).toBeUndefined();
    expect(res.headers["set-cookie"]?.[0]).toMatch(/^socialith\.sid=/);

    expect(auditLogCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "LOGIN_SUCCESS", organizationId: "org_1", userId: "user_1" }),
    });
  });

  it("rejects a wrong password with a generic 401 and logs LOGIN_FAILED", async () => {
    seedUser();
    const res = await request(buildApp())
      .post("/api/auth/login")
      .send({ email: "owner@example.com", password: "wrong-password" });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error.message).toBe("Invalid email or password.");
    expect(auditLogCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "LOGIN_FAILED",
        organizationId: "org_1",
        metadataJson: { reason: "invalid_password" },
      }),
    });
  });

  it("rejects an unknown email with the identical generic 401 body, and writes no audit log", async () => {
    const res = await request(buildApp())
      .post("/api/auth/login")
      .send({ email: "nobody@example.com", password: "anything" });

    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe("Invalid email or password.");
    // No organization to attach a row to for an email that matches no
    // user — see docs/architecture.md "Known limitations".
    expect(auditLogCreateMock).not.toHaveBeenCalled();
  });

  it("gives the unknown-email and wrong-password responses byte-identical bodies (no enumeration signal)", async () => {
    seedUser();
    const wrongPassword = await request(buildApp())
      .post("/api/auth/login")
      .send({ email: "owner@example.com", password: "wrong-password" });
    const unknownEmail = await request(buildApp())
      .post("/api/auth/login")
      .send({ email: "nobody@example.com", password: "anything" });

    expect(wrongPassword.status).toBe(unknownEmail.status);
    expect(wrongPassword.body).toEqual(unknownEmail.body);
  });

  it("rejects a disabled user's correct password with the same generic 401, logging the real reason internally", async () => {
    seedUser({ status: "DISABLED" });
    const res = await request(buildApp())
      .post("/api/auth/login")
      .send({ email: "owner@example.com", password: "correct-password" });

    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe("Invalid email or password.");
    expect(auditLogCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "LOGIN_FAILED", metadataJson: { reason: "disabled" } }),
    });
  });

  it("returns 400 for a missing/malformed body rather than reaching the auth service", async () => {
    const res = await request(buildApp()).post("/api/auth/login").send({ email: "not-an-email" });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});

describe("GET /api/auth/me", () => {
  it("returns 401 AUTH_REQUIRED with no session", async () => {
    const res = await request(buildApp()).get("/api/auth/me");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("AUTH_REQUIRED");
  });

  it("returns the authenticated user, excluding passwordHash/sessionVersion, with a valid session", async () => {
    seedUser();
    const app = buildApp();
    const agent = request.agent(app);
    await agent.post("/api/auth/login").send({ email: "owner@example.com", password: "correct-password" });

    const res = await agent.get("/api/auth/me");
    expect(res.status).toBe(200);
    expect(res.body.data.email).toBe("owner@example.com");
    expect(res.body.data.passwordHash).toBeUndefined();
    expect(res.body.data.sessionVersion).toBeUndefined();
  });

  it("returns 401 for a garbage/tampered session cookie instead of crashing", async () => {
    const res = await request(buildApp())
      .get("/api/auth/me")
      .set("Cookie", "socialith.sid=not-a-real-session-value");
    expect(res.status).toBe(401);
  });

  it("invalidates an existing session when the user's sessionVersion changes elsewhere", async () => {
    const user = seedUser();
    const app = buildApp();
    const agent = request.agent(app);
    await agent.post("/api/auth/login").send({ email: "owner@example.com", password: "correct-password" });

    // Simulates what a future password-reset action does: bump
    // sessionVersion server-side without touching the already-issued
    // session cookie.
    (user as { sessionVersion: number }).sessionVersion += 1;

    const res = await agent.get("/api/auth/me");
    expect(res.status).toBe(401);
  });
});

describe("POST /api/auth/logout", () => {
  it("requires auth (401 with no session)", async () => {
    const res = await request(buildApp()).post("/api/auth/logout");
    expect(res.status).toBe(401);
  });

  it("destroys the session, clears the cookie, logs LOGOUT, and invalidates a subsequent /me", async () => {
    seedUser();
    const app = buildApp();
    const agent = request.agent(app);
    await agent.post("/api/auth/login").send({ email: "owner@example.com", password: "correct-password" });

    const logoutRes = await agent.post("/api/auth/logout");
    expect(logoutRes.status).toBe(200);
    expect(logoutRes.body.data.loggedOut).toBe(true);
    expect(auditLogCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "LOGOUT", organizationId: "org_1", userId: "user_1" }),
    });

    const meRes = await agent.get("/api/auth/me");
    expect(meRes.status).toBe(401);
  });
});

describe("POST /api/auth/forgot-password", () => {
  it("returns the same generic 200 body for an existing eligible email and an unknown email", async () => {
    seedUser();
    const known = await request(buildApp())
      .post("/api/auth/forgot-password")
      .send({ email: "owner@example.com" });
    const unknown = await request(buildApp())
      .post("/api/auth/forgot-password")
      .send({ email: "nobody@example.com" });

    expect(known.status).toBe(unknown.status);
    expect(known.status).toBe(200);
    expect(known.body).toEqual(unknown.body);
  });

  it("returns the identical generic body for a DISABLED user too (no enumeration signal)", async () => {
    seedUser({ status: "DISABLED" });
    const res = await request(buildApp()).post("/api/auth/forgot-password").send({ email: "owner@example.com" });
    expect(res.status).toBe(200);
    expect(res.body.data.message).toMatch(/if an account with that email exists/i);
  });

  it("returns the identical generic body for a REMOVED user too", async () => {
    seedUser({ status: "REMOVED" });
    const res = await request(buildApp()).post("/api/auth/forgot-password").send({ email: "owner@example.com" });
    expect(res.status).toBe(200);
  });

  it("returns 400 for a malformed email (a distinct concern from account eligibility)", async () => {
    const res = await request(buildApp()).post("/api/auth/forgot-password").send({ email: "not-an-email" });
    expect(res.status).toBe(400);
  });

  it("writes PASSWORD_RESET_REQUESTED for an eligible email but no audit row for an unknown one", async () => {
    seedUser();
    await request(buildApp()).post("/api/auth/forgot-password").send({ email: "owner@example.com" });
    expect(auditLogCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "PASSWORD_RESET_REQUESTED", organizationId: "org_1", userId: "user_1" }),
    });

    auditLogCreateMock.mockClear();
    await request(buildApp()).post("/api/auth/forgot-password").send({ email: "nobody@example.com" });
    expect(auditLogCreateMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/auth/reset-password", () => {
  it("returns 400 INVALID_RESET_TOKEN for an unknown token", async () => {
    const res = await request(buildApp())
      .post("/api/auth/reset-password")
      .send({ token: "garbage-token", password: "correct-horse-battery" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_RESET_TOKEN");
  });

  it("returns 400 for an expired token", async () => {
    seedUser();
    seedPasswordResetToken({ tokenHash: "hashed-token:expired-raw-token", expiresAt: new Date(Date.now() - 1000) });

    const res = await request(buildApp())
      .post("/api/auth/reset-password")
      .send({ token: "expired-raw-token", password: "correct-horse-battery" });
    expect(res.status).toBe(400);
  });

  it("returns 400 for an already-used token (single-use enforcement)", async () => {
    seedUser();
    seedPasswordResetToken({ tokenHash: "hashed-token:used-raw-token", usedAt: new Date() });

    const res = await request(buildApp())
      .post("/api/auth/reset-password")
      .send({ token: "used-raw-token", password: "correct-horse-battery" });
    expect(res.status).toBe(400);
  });

  it("returns 400 for a password shorter than 12 characters", async () => {
    seedUser();
    seedPasswordResetToken({ tokenHash: "hashed-token:some-raw-token" });
    const res = await request(buildApp())
      .post("/api/auth/reset-password")
      .send({ token: "some-raw-token", password: "short" });
    expect(res.status).toBe(400);
  });

  it("on success: resets the password, consumes the token, and invalidates every existing session", async () => {
    const user = seedUser();
    seedPasswordResetToken({ tokenHash: "hashed-token:valid-raw-token" });

    const app = buildApp();
    const agent = request.agent(app);
    // Establish a session with the OLD password first.
    await agent.post("/api/auth/login").send({ email: "owner@example.com", password: "correct-password" });
    const meBefore = await agent.get("/api/auth/me");
    expect(meBefore.status).toBe(200);

    const resetRes = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: "valid-raw-token", password: "correct-horse-battery-NEW" });
    expect(resetRes.status).toBe(200);
    expect(resetRes.body.data.passwordReset).toBe(true);
    expect((user as { sessionVersion: number }).sessionVersion).toBe(1);

    // The session established before the reset must now be invalid —
    // this is the actual, end-to-end proof that sessionVersion
    // invalidation works for password reset, not just that the
    // repository function was called.
    const meAfter = await agent.get("/api/auth/me");
    expect(meAfter.status).toBe(401);

    expect(auditLogCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "PASSWORD_RESET_COMPLETED", organizationId: "org_1", userId: "user_1" }),
    });

    // And a fresh login must use the NEW password, not the old one.
    const newLogin = await request(app)
      .post("/api/auth/login")
      .send({ email: "owner@example.com", password: "correct-horse-battery-NEW" });
    expect(newLogin.status).toBe(200);
  });

  it("does not establish a session on success (unlike login/invitation-acceptance)", async () => {
    seedUser();
    seedPasswordResetToken({ tokenHash: "hashed-token:no-session-raw-token" });

    const res = await request(buildApp())
      .post("/api/auth/reset-password")
      .send({ token: "no-session-raw-token", password: "correct-horse-battery" });

    expect(res.status).toBe(200);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });
});
