import { describe, expect, it, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const { prismaMock, seedUser, seedInvitation, resetFixtures, auditLogCreateMock } = vi.hoisted(() => {
  const users = new Map<string, Record<string, unknown>>();
  const invitations = new Map<string, Record<string, unknown>>();
  const auditLogCreateMock = vi.fn().mockResolvedValue({});

  function seedUser(overrides: Record<string, unknown> = {}) {
    const user = {
      id: "user_1",
      organizationId: "org_1",
      name: "Test User",
      email: "user1@example.com",
      passwordHash: "hashed:correct-password",
      role: "VIEWER",
      status: "ACTIVE",
      lastLoginAt: null,
      sessionVersion: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
    users.set(user.id as string, user);
    return user;
  }

  function seedInvitation(overrides: Record<string, unknown> = {}) {
    const invitation = {
      id: "inv_1",
      organizationId: "org_1",
      email: "invitee@example.com",
      role: "EDITOR",
      tokenHash: "",
      expiresAt: new Date(Date.now() + 100000),
      acceptedAt: null,
      invitedById: "user_1",
      createdAt: new Date(),
      ...overrides,
    };
    invitations.set(invitation.id as string, invitation);
    return invitation;
  }

  function resetFixtures() {
    users.clear();
    invitations.clear();
    auditLogCreateMock.mockClear();
  }

  const prismaMock = {
    user: {
      findUnique: async ({ where }: { where: { email?: string; id?: string } }) => {
        if (where.email) return [...users.values()].find((u) => u.email === where.email) ?? null;
        if (where.id) return users.get(where.id) ?? null;
        return null;
      },
      findFirst: async ({ where }: { where: { id: string; organizationId: string } }) => {
        const user = users.get(where.id);
        return user && user.organizationId === where.organizationId ? user : null;
      },
      findMany: async ({ where }: { where: { organizationId: string } }) =>
        [...users.values()].filter((u) => u.organizationId === where.organizationId && u.status !== "REMOVED"),
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const user = users.get(where.id);
        if (!user) throw new Error("user not found");
        Object.assign(user, data);
        return user;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const user = { id: `user_${users.size + 1}`, sessionVersion: 0, createdAt: new Date(), ...data };
        users.set(user.id as string, user);
        return user;
      },
      count: async ({
        where,
      }: {
        where: { organizationId: string; role: string; status: string; id?: { not: string } };
      }) =>
        [...users.values()].filter(
          (u) =>
            u.organizationId === where.organizationId &&
            u.role === where.role &&
            u.status === where.status &&
            (!where.id?.not || u.id !== where.id.not),
        ).length,
    },
    invitation: {
      findUnique: async ({
        where,
        include,
      }: {
        where: { tokenHash: string };
        include?: { organization?: unknown };
      }) => {
        const invitation = [...invitations.values()].find((i) => i.tokenHash === where.tokenHash);
        if (!invitation) return null;
        if (include?.organization) return { ...invitation, organization: { name: "Acme Org" } };
        return invitation;
      },
      findFirst: async ({ where }: { where: { organizationId: string; email: string; acceptedAt: null } }) =>
        [...invitations.values()].find(
          (i) =>
            i.organizationId === where.organizationId &&
            i.email === where.email &&
            i.acceptedAt === null &&
            (i.expiresAt as Date).getTime() > Date.now(),
        ) ?? null,
      findMany: async ({ where }: { where: { organizationId: string } }) =>
        [...invitations.values()].filter(
          (i) =>
            i.organizationId === where.organizationId &&
            i.acceptedAt === null &&
            (i.expiresAt as Date).getTime() > Date.now(),
        ),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const invitation = { id: `inv_${invitations.size + 1}`, createdAt: new Date(), ...data };
        invitations.set(invitation.id as string, invitation);
        return invitation;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const invitation = invitations.get(where.id);
        if (!invitation) throw new Error("invitation not found");
        Object.assign(invitation, data);
        return invitation;
      },
    },
    organization: {
      findUnique: async () => ({ name: "Acme Org" }),
    },
    auditLog: { create: auditLogCreateMock },
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(prismaMock),
  };

  return { prismaMock, seedUser, seedInvitation, resetFixtures, auditLogCreateMock };
});

vi.mock("@socialith/database", () => ({ prisma: prismaMock }));

vi.mock("@socialith/auth", () => ({
  hashPassword: vi.fn(async (pwd: string) => `hashed:${pwd}`),
  verifyPassword: vi.fn(async (hash: string, pwd: string) => hash === `hashed:${pwd}`),
  generateSecureToken: vi.fn(() => "raw-test-token"),
  hashToken: vi.fn((raw: string) => `hashed-token:${raw}`),
  hasMinimumRole: (role: string, min: string) => {
    const rank: Record<string, number> = { VIEWER: 0, EDITOR: 1, ADMIN: 2, OWNER: 3 };
    return rank[role] >= rank[min];
  },
  canManageTeam: (role: string) => role === "ADMIN" || role === "OWNER",
  canAssignRole: (actorRole: string, targetRole: string) =>
    targetRole === "OWNER" ? actorRole === "OWNER" : actorRole === "ADMIN" || actorRole === "OWNER",
  canActOnMember: (actorRole: string, targetRole: string) =>
    targetRole === "OWNER" ? actorRole === "OWNER" : actorRole === "ADMIN" || actorRole === "OWNER",
}));

vi.mock("@socialith/config", () => ({
  loadEnv: vi.fn(() => ({ NODE_ENV: "test", NEXT_PUBLIC_APP_URL: "http://localhost:3000" })),
  resolveAppOrigin: vi.fn(() => "http://localhost:3000"),
}));

const { createTeamRouter } = await import("./team.js");
const { createSessionMiddleware, establishSession, regenerateSession } = await import("../lib/session.js");
const { errorHandler, notFoundHandler } = await import("../middleware/error-handler.js");

/**
 * The team router has no login route of its own (that's routes/auth.ts,
 * a separate router this file doesn't need). To test real RBAC
 * middleware behavior end-to-end, this mounts one test-only route that
 * establishes a session using the exact same helpers login/invitation
 * acceptance use (lib/session.ts) — not a shortcut around the real
 * session machinery, just skipping the password check, which is
 * covered by apps/api/src/routes/auth.test.ts.
 */
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(createSessionMiddleware({ SESSION_SECRET: "a-long-enough-test-only-secret", NODE_ENV: "test" }));

  app.post("/test/login-as", async (req, res) => {
    await regenerateSession(req);
    establishSession(req, req.body);
    res.status(200).json({ ok: true });
  });

  app.use("/api", createTeamRouter());
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

async function loginAs(
  app: express.Express,
  user: { id: string; organizationId: string; role: string; sessionVersion?: number },
) {
  const agent = request.agent(app);
  await agent.post("/test/login-as").send({ ...user, sessionVersion: user.sessionVersion ?? 0 });
  return agent;
}

beforeEach(() => {
  resetFixtures();
});

describe("GET /api/team", () => {
  it("requires authentication", async () => {
    const res = await request(buildApp()).get("/api/team");
    expect(res.status).toBe(401);
  });

  it("allows a VIEWER to view the team (view-only, no mutation)", async () => {
    seedUser({ id: "viewer_1", role: "VIEWER" });
    const app = buildApp();
    const agent = await loginAs(app, { id: "viewer_1", organizationId: "org_1", role: "VIEWER" });

    const res = await agent.get("/api/team");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.members)).toBe(true);
  });
});

describe("POST /api/team/invitations — RBAC", () => {
  it("blocks a VIEWER (403)", async () => {
    seedUser({ id: "viewer_1", role: "VIEWER" });
    const app = buildApp();
    const agent = await loginAs(app, { id: "viewer_1", organizationId: "org_1", role: "VIEWER" });

    const res = await agent.post("/api/team/invitations").send({ email: "new@example.com", role: "EDITOR" });
    expect(res.status).toBe(403);
  });

  it("blocks an EDITOR (403)", async () => {
    seedUser({ id: "editor_1", role: "EDITOR" });
    const app = buildApp();
    const agent = await loginAs(app, { id: "editor_1", organizationId: "org_1", role: "EDITOR" });

    const res = await agent.post("/api/team/invitations").send({ email: "new@example.com", role: "EDITOR" });
    expect(res.status).toBe(403);
  });

  it("allows an ADMIN to invite (201) and rejects OWNER in the body (400)", async () => {
    seedUser({ id: "admin_1", role: "ADMIN" });
    const app = buildApp();
    const agent = await loginAs(app, { id: "admin_1", organizationId: "org_1", role: "ADMIN" });

    const ownerAttempt = await agent.post("/api/team/invitations").send({ email: "new@example.com", role: "OWNER" });
    expect(ownerAttempt.status).toBe(400);

    const ok = await agent.post("/api/team/invitations").send({ email: "new@example.com", role: "EDITOR" });
    expect(ok.status).toBe(201);
    expect(ok.body.data.invitation.role).toBe("EDITOR");
    expect(auditLogCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: "INVITATION_CREATED" }) }),
    );
  });
});

describe("GET /api/team/invitations/:token (preview)", () => {
  it("does not require authentication", async () => {
    const invitation = seedInvitation({ tokenHash: "hashed-token:raw-test-token" });
    const res = await request(buildApp()).get("/api/team/invitations/raw-test-token");
    expect(res.status).toBe(200);
    expect(res.body.data.email).toBe(invitation.email);
    expect(res.body.data.organizationName).toBe("Acme Org");
  });

  it("returns 400 for an unknown token", async () => {
    const res = await request(buildApp()).get("/api/team/invitations/not-a-real-token");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_INVITATION");
  });
});

describe("POST /api/team/invitations/:token (accept)", () => {
  it("creates the user, marks the invitation accepted, and sets a session cookie", async () => {
    seedInvitation({ tokenHash: "hashed-token:raw-test-token", email: "invitee@example.com", role: "EDITOR" });

    const res = await request(buildApp())
      .post("/api/team/invitations/raw-test-token")
      .send({ name: "New Person", password: "correct-horse-battery" });

    expect(res.status).toBe(200);
    expect(res.body.data.email).toBe("invitee@example.com");
    expect(res.body.data.role).toBe("EDITOR");
    expect(res.body.data.passwordHash).toBeUndefined();
    expect(res.headers["set-cookie"]?.[0]).toMatch(/^socialith\.sid=/);
    expect(auditLogCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: "INVITATION_ACCEPTED" }) }),
    );
  });

  it("rejects re-accepting an already-accepted invitation", async () => {
    seedInvitation({
      tokenHash: "hashed-token:raw-test-token",
      email: "invitee@example.com",
      role: "EDITOR",
      acceptedAt: new Date(),
    });

    const res = await request(buildApp())
      .post("/api/team/invitations/raw-test-token")
      .send({ name: "New Person", password: "correct-horse-battery" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_INVITATION");
  });

  it("rejects a password shorter than 12 characters", async () => {
    seedInvitation({ tokenHash: "hashed-token:raw-test-token" });
    const res = await request(buildApp())
      .post("/api/team/invitations/raw-test-token")
      .send({ name: "New Person", password: "short" });
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/team/:userId/role — RBAC and self-action", () => {
  it("requires authentication", async () => {
    const res = await request(buildApp()).patch("/api/team/user_2/role").send({ role: "EDITOR" });
    expect(res.status).toBe(401);
  });

  it("blocks an ADMIN from changing an OWNER's role (403)", async () => {
    seedUser({ id: "admin_1", role: "ADMIN" });
    seedUser({ id: "owner_1", role: "OWNER" });
    const app = buildApp();
    const agent = await loginAs(app, { id: "admin_1", organizationId: "org_1", role: "ADMIN" });

    const res = await agent.patch("/api/team/owner_1/role").send({ role: "EDITOR" });
    expect(res.status).toBe(403);
  });

  it("blocks an ADMIN from promoting anyone to OWNER (403)", async () => {
    seedUser({ id: "admin_1", role: "ADMIN" });
    seedUser({ id: "editor_1", role: "EDITOR" });
    const app = buildApp();
    const agent = await loginAs(app, { id: "admin_1", organizationId: "org_1", role: "ADMIN" });

    const res = await agent.patch("/api/team/editor_1/role").send({ role: "OWNER" });
    expect(res.status).toBe(403);
  });

  it("lets an OWNER change any member's role, including granting OWNER", async () => {
    seedUser({ id: "owner_1", role: "OWNER" });
    seedUser({ id: "editor_1", role: "EDITOR" });
    const app = buildApp();
    const agent = await loginAs(app, { id: "owner_1", organizationId: "org_1", role: "OWNER" });

    const res = await agent.patch("/api/team/editor_1/role").send({ role: "OWNER" });
    expect(res.status).toBe(200);
    expect(res.body.data.role).toBe("OWNER");
  });

  it("rejects an OWNER changing their own role (400)", async () => {
    seedUser({ id: "owner_1", role: "OWNER" });
    const app = buildApp();
    const agent = await loginAs(app, { id: "owner_1", organizationId: "org_1", role: "OWNER" });

    const res = await agent.patch("/api/team/owner_1/role").send({ role: "ADMIN" });
    expect(res.status).toBe(400);
  });

  // NOTE on last-owner protection at the route level: reaching
  // changeMemberRole's "target is the sole active OWNER" branch through
  // a real HTTP request requires an authenticated actor who (a) passed
  // requireAuth, so the actor is themselves ACTIVE, and (b) passed
  // canActOnMember on an OWNER target, which only an OWNER satisfies —
  // so the actor must be a *different*, active OWNER (self-changes are
  // already rejected above). But if such an actor exists, they
  // themselves count as "another active owner" for the target, so the
  // safeguard's condition (zero other active owners) can never be true
  // at the same time a valid distinct actor exists to trigger it. This
  // makes the 409 branch a genuine defense-in-depth backstop — not
  // reachable through today's legitimate request flow, only relevant if
  // the self-check or canActOnMember guard ever regresses. It's
  // exercised directly, with a constructed actor/mock, in
  // services/team.service.test.ts ("rejects demoting the last remaining
  // active OWNER"), which is the correct place to test a safeguard
  // whose triggering condition the route-level RBAC chain itself
  // prevents from occurring.

  it("allows an OWNER to change another OWNER's role when another active OWNER remains", async () => {
    seedUser({ id: "owner_1", role: "OWNER" });
    seedUser({ id: "owner_2", role: "OWNER" });
    const app = buildApp();
    const agent = await loginAs(app, { id: "owner_1", organizationId: "org_1", role: "OWNER" });

    const res = await agent.patch("/api/team/owner_2/role").send({ role: "ADMIN" });
    expect(res.status).toBe(200);
    expect(res.body.data.role).toBe("ADMIN");
  });

  it("returns 404 for a userId in a different organization (not 403 — no cross-org existence leak)", async () => {
    seedUser({ id: "owner_1", role: "OWNER", organizationId: "org_1" });
    seedUser({ id: "other_org_user", role: "VIEWER", organizationId: "org_2" });
    const app = buildApp();
    const agent = await loginAs(app, { id: "owner_1", organizationId: "org_1", role: "OWNER" });

    const res = await agent.patch("/api/team/other_org_user/role").send({ role: "EDITOR" });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/team/:userId/disable — self-action guard", () => {
  it("rejects disabling your own account (400)", async () => {
    seedUser({ id: "owner_1", role: "OWNER" });
    const app = buildApp();
    const agent = await loginAs(app, { id: "owner_1", organizationId: "org_1", role: "OWNER" });

    const res = await agent.post("/api/team/owner_1/disable");
    expect(res.status).toBe(400);
  });

  it("lets an OWNER disable a VIEWER and logs USER_DISABLED", async () => {
    seedUser({ id: "owner_1", role: "OWNER" });
    seedUser({ id: "viewer_1", role: "VIEWER" });
    const app = buildApp();
    const agent = await loginAs(app, { id: "owner_1", organizationId: "org_1", role: "OWNER" });

    const res = await agent.post("/api/team/viewer_1/disable");
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("DISABLED");
    expect(auditLogCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: "USER_DISABLED" }) }),
    );
  });
});

describe("DELETE /api/team/:userId — self-action guard and soft-remove", () => {
  it("rejects removing your own account (400)", async () => {
    seedUser({ id: "admin_1", role: "ADMIN" });
    const app = buildApp();
    const agent = await loginAs(app, { id: "admin_1", organizationId: "org_1", role: "ADMIN" });

    const res = await agent.delete("/api/team/admin_1");
    expect(res.status).toBe(400);
  });

  it("blocks an ADMIN from removing an OWNER (403)", async () => {
    seedUser({ id: "admin_1", role: "ADMIN" });
    seedUser({ id: "owner_1", role: "OWNER" });
    const app = buildApp();
    const agent = await loginAs(app, { id: "admin_1", organizationId: "org_1", role: "ADMIN" });

    const res = await agent.delete("/api/team/owner_1");
    expect(res.status).toBe(403);
  });

  it("soft-removes a VIEWER (status REMOVED) and logs USER_REMOVED", async () => {
    seedUser({ id: "owner_1", role: "OWNER" });
    seedUser({ id: "viewer_1", role: "VIEWER" });
    const app = buildApp();
    const agent = await loginAs(app, { id: "owner_1", organizationId: "org_1", role: "OWNER" });

    const res = await agent.delete("/api/team/viewer_1");
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("REMOVED");
    expect(auditLogCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: "USER_REMOVED" }) }),
    );
  });

  it("a removed member no longer appears in GET /api/team", async () => {
    seedUser({ id: "owner_1", role: "OWNER" });
    seedUser({ id: "viewer_1", role: "VIEWER" });
    const app = buildApp();
    const agent = await loginAs(app, { id: "owner_1", organizationId: "org_1", role: "OWNER" });

    await agent.delete("/api/team/viewer_1");
    const res = await agent.get("/api/team");
    const ids = res.body.data.members.map((m: { id: string }) => m.id);
    expect(ids).not.toContain("viewer_1");
  });
});
