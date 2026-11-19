import { describe, expect, it, vi, beforeEach } from "vitest";

const { txMock, invitationRepoMocks, userRepoMocks, auditLogCreateMock, emailSendMock, orgNameMock } = vi.hoisted(
  () => {
    const invitationRepoMocks = {
      findOutstandingInvitation: vi.fn(),
      revokeInvitation: vi.fn(),
      createInvitationRecord: vi.fn(),
      findInvitationByTokenHash: vi.fn(),
      findInvitationWithOrganizationByTokenHash: vi.fn(),
      markInvitationAccepted: vi.fn(),
    };
    const userRepoMocks = {
      findUserByEmail: vi.fn(),
      createUser: vi.fn(),
      reactivateUser: vi.fn(),
    };
    const auditLogCreateMock = vi.fn().mockResolvedValue(undefined);
    const emailSendMock = vi.fn().mockResolvedValue(undefined);
    const orgNameMock = vi.fn().mockResolvedValue("Acme Org");

    // A fake transaction: just invokes the callback with a placeholder
    // value. The repository functions below are fully mocked (they
    // resolve their pre-configured mockResolvedValue regardless of
    // what "db"/"tx" argument they're called with), so what's passed
    // as `tx` here is never actually inspected — it only needs to
    // exist so `prisma.$transaction(async (tx) => ...)` has something
    // to call the callback with. This tests invitation.service.ts's
    // branching logic (what it does with each repository result), not
    // real transactional atomicity, which needs a real database.
    const txMock = vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback({}));

    return { txMock, invitationRepoMocks, userRepoMocks, auditLogCreateMock, emailSendMock, orgNameMock };
  },
);

vi.mock("@socialith/database", () => ({
  prisma: { $transaction: txMock },
}));

vi.mock("@socialith/auth", () => ({
  generateSecureToken: vi.fn(() => "raw-test-token"),
  hashToken: vi.fn((raw: string) => `hashed:${raw}`),
  hashPassword: vi.fn(async (pwd: string) => `hashed-pw:${pwd}`),
}));

vi.mock("@socialith/config", () => ({
  loadEnv: vi.fn(() => ({ NODE_ENV: "development", NEXT_PUBLIC_APP_URL: "http://localhost:3000" })),
  resolveAppOrigin: vi.fn(() => "http://localhost:3000"),
}));

vi.mock("../repositories/user.repository.js", () => userRepoMocks);
vi.mock("../repositories/invitation.repository.js", () => invitationRepoMocks);
vi.mock("../repositories/organization.repository.js", () => ({ findOrganizationName: orgNameMock }));
vi.mock("../repositories/audit-log.repository.js", () => ({ createAuditLog: auditLogCreateMock }));
vi.mock("../lib/email/email.service.js", () => ({
  getEmailService: () => ({ sendInvitation: emailSendMock }),
}));

const { createInvitation, previewInvitation, acceptInvitation } = await import("./invitation.service.js");

function actor(overrides: Record<string, unknown> = {}) {
  return {
    id: "actor_1",
    organizationId: "org_1",
    name: "Actor",
    email: "actor@example.com",
    role: "ADMIN" as const,
    status: "ACTIVE" as const,
    lastLoginAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  txMock.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback({}));
});

describe("createInvitation", () => {
  it("rejects an email that already belongs to a member of this organization", async () => {
    userRepoMocks.findUserByEmail.mockResolvedValue({ organizationId: "org_1", status: "ACTIVE" });

    await expect(
      createInvitation(actor(), { email: "existing@example.com", role: "EDITOR" }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(invitationRepoMocks.createInvitationRecord).not.toHaveBeenCalled();
  });

  it("rejects an email that belongs to an account in a different organization", async () => {
    userRepoMocks.findUserByEmail.mockResolvedValue({ organizationId: "org_2", status: "ACTIVE" });

    await expect(
      createInvitation(actor(), { email: "existing@example.com", role: "EDITOR" }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("allows inviting an email that belongs to a REMOVED user (their email is free again)", async () => {
    userRepoMocks.findUserByEmail.mockResolvedValue({ organizationId: "org_1", status: "REMOVED" });
    invitationRepoMocks.findOutstandingInvitation.mockResolvedValue(null);
    invitationRepoMocks.createInvitationRecord.mockResolvedValue({
      id: "inv_1",
      email: "removed@example.com",
      role: "EDITOR",
      expiresAt: new Date(),
      createdAt: new Date(),
    });

    const result = await createInvitation(actor(), { email: "removed@example.com", role: "EDITOR" });
    expect(result.invitation.id).toBe("inv_1");
  });

  it("revokes an existing outstanding invitation before creating a fresh one (no stacking)", async () => {
    userRepoMocks.findUserByEmail.mockResolvedValue(null);
    invitationRepoMocks.findOutstandingInvitation.mockResolvedValue({ id: "old_inv" });
    invitationRepoMocks.createInvitationRecord.mockResolvedValue({
      id: "new_inv",
      email: "fresh@example.com",
      role: "VIEWER",
      expiresAt: new Date(),
      createdAt: new Date(),
    });

    await createInvitation(actor(), { email: "fresh@example.com", role: "VIEWER" });

    expect(invitationRepoMocks.revokeInvitation).toHaveBeenCalledWith("old_inv");
    expect(invitationRepoMocks.createInvitationRecord).toHaveBeenCalled();
  });

  it("stores only the token hash, never the raw token, and never puts the token in audit metadata", async () => {
    userRepoMocks.findUserByEmail.mockResolvedValue(null);
    invitationRepoMocks.findOutstandingInvitation.mockResolvedValue(null);
    invitationRepoMocks.createInvitationRecord.mockResolvedValue({
      id: "inv_2",
      email: "fresh2@example.com",
      role: "VIEWER",
      expiresAt: new Date(),
      createdAt: new Date(),
    });

    await createInvitation(actor(), { email: "fresh2@example.com", role: "VIEWER" });

    const createArgs = invitationRepoMocks.createInvitationRecord.mock.calls[0][0];
    expect(createArgs.tokenHash).toBe("hashed:raw-test-token");
    expect(createArgs).not.toHaveProperty("token");
    expect(createArgs).not.toHaveProperty("rawToken");

    const auditArgs = auditLogCreateMock.mock.calls[0][0];
    expect(JSON.stringify(auditArgs)).not.toContain("raw-test-token");
    expect(auditArgs.action).toBe("INVITATION_CREATED");
  });

  it("includes a dev-only accept URL outside production, containing the raw token", async () => {
    userRepoMocks.findUserByEmail.mockResolvedValue(null);
    invitationRepoMocks.findOutstandingInvitation.mockResolvedValue(null);
    invitationRepoMocks.createInvitationRecord.mockResolvedValue({
      id: "inv_3",
      email: "fresh3@example.com",
      role: "VIEWER",
      expiresAt: new Date(),
      createdAt: new Date(),
    });

    const result = await createInvitation(actor(), { email: "fresh3@example.com", role: "VIEWER" });
    expect(result.devAcceptUrl).toContain("raw-test-token");
    expect(emailSendMock).toHaveBeenCalledWith(expect.objectContaining({ acceptUrl: result.devAcceptUrl }));
  });
});

describe("previewInvitation", () => {
  it("rejects a token that matches nothing", async () => {
    invitationRepoMocks.findInvitationWithOrganizationByTokenHash.mockResolvedValue(null);
    await expect(previewInvitation("garbage")).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects an expired invitation", async () => {
    invitationRepoMocks.findInvitationWithOrganizationByTokenHash.mockResolvedValue({
      email: "a@example.com",
      role: "VIEWER",
      acceptedAt: null,
      expiresAt: new Date(Date.now() - 1000),
      organization: { name: "Acme" },
    });
    await expect(previewInvitation("expired-token")).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects an already-accepted invitation", async () => {
    invitationRepoMocks.findInvitationWithOrganizationByTokenHash.mockResolvedValue({
      email: "a@example.com",
      role: "VIEWER",
      acceptedAt: new Date(),
      expiresAt: new Date(Date.now() + 100000),
      organization: { name: "Acme" },
    });
    await expect(previewInvitation("used-token")).rejects.toMatchObject({ statusCode: 400 });
  });

  it("returns email/role/organizationName/expiresAt for a valid outstanding invitation", async () => {
    const expiresAt = new Date(Date.now() + 100000);
    invitationRepoMocks.findInvitationWithOrganizationByTokenHash.mockResolvedValue({
      email: "a@example.com",
      role: "VIEWER",
      acceptedAt: null,
      expiresAt,
      organization: { name: "Acme" },
    });

    const result = await previewInvitation("good-token");
    expect(result).toEqual({ email: "a@example.com", role: "VIEWER", organizationName: "Acme", expiresAt });
  });
});

describe("acceptInvitation", () => {
  it("rejects a token that matches nothing", async () => {
    invitationRepoMocks.findInvitationByTokenHash.mockResolvedValue(null);
    await expect(acceptInvitation("garbage", { name: "A", password: "correct-horse-battery" })).rejects.toMatchObject(
      { statusCode: 400 },
    );
  });

  it("rejects an already-accepted invitation (single-use enforcement)", async () => {
    invitationRepoMocks.findInvitationByTokenHash.mockResolvedValue({
      id: "inv_1",
      email: "a@example.com",
      role: "VIEWER",
      organizationId: "org_1",
      acceptedAt: new Date(),
      expiresAt: new Date(Date.now() + 100000),
    });
    await expect(
      acceptInvitation("used-token", { name: "A", password: "correct-horse-battery" }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(userRepoMocks.createUser).not.toHaveBeenCalled();
  });

  it("creates a new user for a brand-new email and marks the invitation accepted", async () => {
    invitationRepoMocks.findInvitationByTokenHash.mockResolvedValue({
      id: "inv_1",
      email: "new@example.com",
      role: "EDITOR",
      organizationId: "org_1",
      acceptedAt: null,
      expiresAt: new Date(Date.now() + 100000),
    });
    userRepoMocks.findUserByEmail.mockResolvedValue(null);
    userRepoMocks.createUser.mockResolvedValue({
      id: "user_new",
      organizationId: "org_1",
      name: "New Person",
      email: "new@example.com",
      role: "EDITOR",
      status: "ACTIVE",
      lastLoginAt: null,
      sessionVersion: 0,
      createdAt: new Date(),
    });

    const result = await acceptInvitation("good-token", { name: "New Person", password: "correct-horse-battery" });

    expect(userRepoMocks.createUser).toHaveBeenCalledWith(
      expect.objectContaining({ email: "new@example.com", role: "EDITOR", organizationId: "org_1" }),
      expect.anything(),
    );
    expect(invitationRepoMocks.markInvitationAccepted).toHaveBeenCalledWith("inv_1", expect.anything());
    expect(result.safeUser.email).toBe("new@example.com");
    expect(result.sessionVersion).toBe(0);
    expect(auditLogCreateMock).toHaveBeenCalledWith(expect.objectContaining({ action: "INVITATION_ACCEPTED" }));
  });

  it("rejects when the email already belongs to an active account in a DIFFERENT organization", async () => {
    invitationRepoMocks.findInvitationByTokenHash.mockResolvedValue({
      id: "inv_1",
      email: "cross-org@example.com",
      role: "EDITOR",
      organizationId: "org_1",
      acceptedAt: null,
      expiresAt: new Date(Date.now() + 100000),
    });
    userRepoMocks.findUserByEmail.mockResolvedValue({ id: "user_x", organizationId: "org_2", status: "ACTIVE" });

    await expect(
      acceptInvitation("good-token", { name: "X", password: "correct-horse-battery" }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(userRepoMocks.createUser).not.toHaveBeenCalled();
  });

  it("rejects when an active account already exists for this email in the SAME organization", async () => {
    invitationRepoMocks.findInvitationByTokenHash.mockResolvedValue({
      id: "inv_1",
      email: "already@example.com",
      role: "EDITOR",
      organizationId: "org_1",
      acceptedAt: null,
      expiresAt: new Date(Date.now() + 100000),
    });
    userRepoMocks.findUserByEmail.mockResolvedValue({ id: "user_y", organizationId: "org_1", status: "ACTIVE" });

    await expect(
      acceptInvitation("good-token", { name: "Y", password: "correct-horse-battery" }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("reactivates a REMOVED user in the same organization instead of creating a duplicate", async () => {
    invitationRepoMocks.findInvitationByTokenHash.mockResolvedValue({
      id: "inv_1",
      email: "returning@example.com",
      role: "ADMIN",
      organizationId: "org_1",
      acceptedAt: null,
      expiresAt: new Date(Date.now() + 100000),
    });
    userRepoMocks.findUserByEmail.mockResolvedValue({
      id: "user_returning",
      organizationId: "org_1",
      status: "REMOVED",
    });
    userRepoMocks.reactivateUser.mockResolvedValue({
      id: "user_returning",
      organizationId: "org_1",
      name: "Returning Person",
      email: "returning@example.com",
      role: "ADMIN",
      status: "ACTIVE",
      lastLoginAt: null,
      sessionVersion: 0,
      createdAt: new Date(),
    });

    const result = await acceptInvitation("good-token", { name: "Returning Person", password: "correct-horse-battery" });

    expect(userRepoMocks.reactivateUser).toHaveBeenCalledWith(
      "user_returning",
      expect.objectContaining({ role: "ADMIN" }),
      expect.anything(),
    );
    expect(userRepoMocks.createUser).not.toHaveBeenCalled();
    expect(result.safeUser.status).toBe("ACTIVE");
  });
});
