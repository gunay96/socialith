import { describe, expect, it, vi, beforeEach } from "vitest";

const { txMock, userRepoMocks, tokenRepoMocks, auditLogCreateMock, emailSendPasswordResetMock } = vi.hoisted(() => {
  const userRepoMocks = {
    findUserByEmail: vi.fn(),
    findUserById: vi.fn(),
    updatePasswordAndInvalidateSessions: vi.fn(),
  };
  const tokenRepoMocks = {
    createPasswordResetToken: vi.fn(),
    findPasswordResetTokenByHash: vi.fn(),
    markPasswordResetTokenUsed: vi.fn(),
  };
  const auditLogCreateMock = vi.fn().mockResolvedValue(undefined);
  const emailSendPasswordResetMock = vi.fn().mockResolvedValue(undefined);
  // See services/invitation.service.test.ts for why this fake
  // transaction doesn't need to resemble a real Prisma tx client: every
  // repository call inside it is itself fully mocked below, so none of
  // them actually read the "tx" object passed through.
  const txMock = vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback({}));

  return { txMock, userRepoMocks, tokenRepoMocks, auditLogCreateMock, emailSendPasswordResetMock };
});

vi.mock("@socialith/database", () => ({ prisma: { $transaction: txMock } }));

vi.mock("@socialith/auth", () => ({
  generateSecureToken: vi.fn(() => "raw-test-token"),
  // Deliberately NOT a simple "hashed:${raw}" prefix — that would make the
  // fake hash contain the raw token as a literal substring, which defeats
  // the "never persists the raw token" test below (a real SHA-256 hash
  // never contains its own input as a substring either).
  hashToken: vi.fn((raw: string) => `hashed:${raw.split("").reverse().join("")}`),
  hashPassword: vi.fn(async (pwd: string) => `hashed-pw:${pwd}`),
}));

vi.mock("@socialith/config", () => ({
  loadEnv: vi.fn(() => ({
    NODE_ENV: "development",
    NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    EMAIL_PROVIDER: "console",
  })),
  resolveAppOrigin: vi.fn(() => "http://localhost:3000"),
}));

vi.mock("../repositories/user.repository.js", () => userRepoMocks);
vi.mock("../repositories/password-reset-token.repository.js", () => tokenRepoMocks);
vi.mock("../repositories/audit-log.repository.js", () => ({ createAuditLog: auditLogCreateMock }));
vi.mock("../lib/email/email.service.js", () => ({
  getEmailService: () => ({ sendPasswordReset: emailSendPasswordResetMock }),
}));

const { requestPasswordReset, resetPassword } = await import("./password-reset.service.js");

function fakeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: "user_1",
    organizationId: "org_1",
    name: "Test User",
    email: "user@example.com",
    passwordHash: "hashed-pw:old-password",
    role: "EDITOR",
    status: "ACTIVE",
    lastLoginAt: null,
    sessionVersion: 3,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  txMock.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback({}));
});

describe("requestPasswordReset", () => {
  it("creates a token, writes PASSWORD_RESET_REQUESTED, and sends an email for an ACTIVE user", async () => {
    userRepoMocks.findUserByEmail.mockResolvedValue(fakeUser());

    await requestPasswordReset("user@example.com");

    expect(tokenRepoMocks.createPasswordResetToken).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user_1", tokenHash: "hashed:nekot-tset-war" }),
    );
    expect(auditLogCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "PASSWORD_RESET_REQUESTED", organizationId: "org_1", userId: "user_1" }),
    );
    expect(emailSendPasswordResetMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: "user@example.com", resetUrl: expect.stringContaining("raw-test-token") }),
    );
  });

  it("does nothing observable for an unknown email", async () => {
    userRepoMocks.findUserByEmail.mockResolvedValue(null);

    await requestPasswordReset("nobody@example.com");

    expect(tokenRepoMocks.createPasswordResetToken).not.toHaveBeenCalled();
    expect(auditLogCreateMock).not.toHaveBeenCalled();
    expect(emailSendPasswordResetMock).not.toHaveBeenCalled();
  });

  it("does nothing observable for a DISABLED user", async () => {
    userRepoMocks.findUserByEmail.mockResolvedValue(fakeUser({ status: "DISABLED" }));
    await requestPasswordReset("user@example.com");
    expect(tokenRepoMocks.createPasswordResetToken).not.toHaveBeenCalled();
    expect(emailSendPasswordResetMock).not.toHaveBeenCalled();
  });

  it("does nothing observable for a REMOVED user", async () => {
    userRepoMocks.findUserByEmail.mockResolvedValue(fakeUser({ status: "REMOVED" }));
    await requestPasswordReset("user@example.com");
    expect(tokenRepoMocks.createPasswordResetToken).not.toHaveBeenCalled();
    expect(emailSendPasswordResetMock).not.toHaveBeenCalled();
  });

  it("does nothing observable for an INVITED (not yet activated) user", async () => {
    userRepoMocks.findUserByEmail.mockResolvedValue(fakeUser({ status: "INVITED" }));
    await requestPasswordReset("user@example.com");
    expect(tokenRepoMocks.createPasswordResetToken).not.toHaveBeenCalled();
    expect(emailSendPasswordResetMock).not.toHaveBeenCalled();
  });

  it("always generates a token (pays the same cost) even when it ends up unused — timing-safety by design", async () => {
    const { generateSecureToken } = await import("@socialith/auth");
    userRepoMocks.findUserByEmail.mockResolvedValue(null);

    await requestPasswordReset("nobody@example.com");

    expect(generateSecureToken).toHaveBeenCalled();
  });

  it("never persists the raw token — only its hash", async () => {
    userRepoMocks.findUserByEmail.mockResolvedValue(fakeUser());
    await requestPasswordReset("user@example.com");

    const createArgs = tokenRepoMocks.createPasswordResetToken.mock.calls[0][0];
    expect(createArgs.tokenHash).toBe("hashed:nekot-tset-war");
    expect(JSON.stringify(createArgs)).not.toContain("raw-test-token");
  });

  it("never puts the raw token in audit metadata", async () => {
    userRepoMocks.findUserByEmail.mockResolvedValue(fakeUser());
    await requestPasswordReset("user@example.com");

    const auditArgs = auditLogCreateMock.mock.calls[0][0];
    expect(JSON.stringify(auditArgs)).not.toContain("raw-test-token");
  });
});

describe("resetPassword", () => {
  it("rejects an unknown token (400 INVALID_RESET_TOKEN)", async () => {
    tokenRepoMocks.findPasswordResetTokenByHash.mockResolvedValue(null);

    await expect(resetPassword("garbage-token", "correct-horse-battery")).rejects.toMatchObject({
      statusCode: 400,
      code: "INVALID_RESET_TOKEN",
    });
    expect(userRepoMocks.updatePasswordAndInvalidateSessions).not.toHaveBeenCalled();
  });

  it("rejects an expired token", async () => {
    tokenRepoMocks.findPasswordResetTokenByHash.mockResolvedValue({
      id: "reset_1",
      userId: "user_1",
      usedAt: null,
      expiresAt: new Date(Date.now() - 1000),
    });

    await expect(resetPassword("expired-token", "correct-horse-battery")).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(userRepoMocks.updatePasswordAndInvalidateSessions).not.toHaveBeenCalled();
  });

  it("rejects an already-used token (single-use enforcement)", async () => {
    tokenRepoMocks.findPasswordResetTokenByHash.mockResolvedValue({
      id: "reset_1",
      userId: "user_1",
      usedAt: new Date(),
      expiresAt: new Date(Date.now() + 100000),
    });

    await expect(resetPassword("used-token", "correct-horse-battery")).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(userRepoMocks.updatePasswordAndInvalidateSessions).not.toHaveBeenCalled();
  });

  it("rejects when the user is no longer ACTIVE (disabled/removed after requesting the reset)", async () => {
    tokenRepoMocks.findPasswordResetTokenByHash.mockResolvedValue({
      id: "reset_1",
      userId: "user_1",
      usedAt: null,
      expiresAt: new Date(Date.now() + 100000),
    });
    userRepoMocks.findUserById.mockResolvedValue(fakeUser({ status: "DISABLED" }));

    await expect(resetPassword("valid-token", "correct-horse-battery")).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(userRepoMocks.updatePasswordAndInvalidateSessions).not.toHaveBeenCalled();
  });

  it("on success: updates the password hash, marks the token used, and writes PASSWORD_RESET_COMPLETED", async () => {
    tokenRepoMocks.findPasswordResetTokenByHash.mockResolvedValue({
      id: "reset_1",
      userId: "user_1",
      usedAt: null,
      expiresAt: new Date(Date.now() + 100000),
    });
    userRepoMocks.findUserById.mockResolvedValue(fakeUser());
    userRepoMocks.updatePasswordAndInvalidateSessions.mockResolvedValue(fakeUser({ sessionVersion: 4 }));

    await resetPassword("valid-token", "correct-horse-battery-NEW");

    expect(userRepoMocks.updatePasswordAndInvalidateSessions).toHaveBeenCalledWith(
      "user_1",
      "hashed-pw:correct-horse-battery-NEW",
      expect.anything(),
    );
    expect(tokenRepoMocks.markPasswordResetTokenUsed).toHaveBeenCalledWith("reset_1", expect.anything());
    expect(auditLogCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "PASSWORD_RESET_COMPLETED", organizationId: "org_1", userId: "user_1" }),
    );
  });

  it("relies on updatePasswordAndInvalidateSessions for the sessionVersion bump (verified at the repository level, not re-implemented here)", async () => {
    // This service function trusts the repository's atomic
    // `increment` (see repositories/user.repository.ts) rather than
    // reading-then-writing sessionVersion itself — there is deliberately
    // no sessionVersion arithmetic in password-reset.service.ts to test.
    tokenRepoMocks.findPasswordResetTokenByHash.mockResolvedValue({
      id: "reset_1",
      userId: "user_1",
      usedAt: null,
      expiresAt: new Date(Date.now() + 100000),
    });
    userRepoMocks.findUserById.mockResolvedValue(fakeUser());
    userRepoMocks.updatePasswordAndInvalidateSessions.mockResolvedValue(fakeUser({ sessionVersion: 4 }));

    await resetPassword("valid-token", "correct-horse-battery-NEW");

    expect(userRepoMocks.updatePasswordAndInvalidateSessions).toHaveBeenCalledTimes(1);
  });

  it("never puts the raw token or raw password in audit metadata", async () => {
    tokenRepoMocks.findPasswordResetTokenByHash.mockResolvedValue({
      id: "reset_1",
      userId: "user_1",
      usedAt: null,
      expiresAt: new Date(Date.now() + 100000),
    });
    userRepoMocks.findUserById.mockResolvedValue(fakeUser());
    userRepoMocks.updatePasswordAndInvalidateSessions.mockResolvedValue(fakeUser());

    await resetPassword("valid-token-xyz", "super-secret-new-password");

    const auditArgs = auditLogCreateMock.mock.calls[0][0];
    const serialized = JSON.stringify(auditArgs);
    expect(serialized).not.toContain("valid-token-xyz");
    expect(serialized).not.toContain("super-secret-new-password");
  });
});
