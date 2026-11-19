import { describe, expect, it, vi, beforeEach } from "vitest";

const { repoMocks, auditLogCreateMock } = vi.hoisted(() => {
  const auditLogCreateMock = vi.fn().mockResolvedValue(undefined);
  const repoMocks = {
    listSocialAccounts: vi.fn(),
    findSocialAccountById: vi.fn(),
    updateSocialAccountStatus: vi.fn(),
    upsertSocialAccount: vi.fn(),
    revokePlatformConnection: vi.fn(),
    upsertPlatformConnection: vi.fn(),
    getConnectionSummary: vi.fn(),
  };
  return { repoMocks, auditLogCreateMock };
});

vi.mock("@socialith/database", () => ({
  prisma: { $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({}) },
}));

vi.mock("@socialith/config", () => ({
  loadEnv: vi.fn(() => ({ TOKEN_ENCRYPTION_KEY: "a".repeat(64) })),
}));

vi.mock("../repositories/social-account.repository.js", () => ({
  listSocialAccounts: repoMocks.listSocialAccounts,
  findSocialAccountById: repoMocks.findSocialAccountById,
  updateSocialAccountStatus: repoMocks.updateSocialAccountStatus,
  upsertSocialAccount: repoMocks.upsertSocialAccount,
}));

vi.mock("../repositories/platform-connection.repository.js", () => ({
  revokePlatformConnection: repoMocks.revokePlatformConnection,
  upsertPlatformConnection: repoMocks.upsertPlatformConnection,
  getConnectionSummary: repoMocks.getConnectionSummary,
}));

vi.mock("../repositories/audit-log.repository.js", () => ({ createAuditLog: auditLogCreateMock }));

const { connectAccount, disconnectAccount, getAccountDetail } = await import("./social-account.service.js");

function actor(overrides: Record<string, unknown> = {}) {
  return {
    id: "actor_1",
    organizationId: "org_1",
    name: "Actor",
    email: "actor@example.com",
    role: "EDITOR" as const,
    status: "ACTIVE" as const,
    lastLoginAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("connectAccount", () => {
  it("encrypts the access/refresh tokens before persisting — never passes plaintext to the repository", async () => {
    repoMocks.upsertSocialAccount.mockResolvedValue({ id: "acct_1", platform: "TIKTOK", handle: "@creator" });
    repoMocks.upsertPlatformConnection.mockResolvedValue({});

    await connectAccount(actor(), {
      platform: "TIKTOK",
      externalAccountId: "tiktok_open_id_1",
      handle: "@creator",
      displayName: "Creator",
      accessToken: "plaintext-access-token",
      refreshToken: "plaintext-refresh-token",
      tokenExpiresAt: new Date(Date.now() + 3600_000),
      scopes: ["user.info.basic", "video.publish"],
    });

    const connectionCall = repoMocks.upsertPlatformConnection.mock.calls[0][0];
    expect(connectionCall.encryptedAccessToken).not.toBe("plaintext-access-token");
    expect(connectionCall.encryptedRefreshToken).not.toBe("plaintext-refresh-token");
    expect(connectionCall.encryptedAccessToken).not.toContain("plaintext");
    expect(typeof connectionCall.encryptedAccessToken).toBe("string");
  });

  it("upserts SocialAccount keyed on the actor's own organization (never a caller-supplied org)", async () => {
    repoMocks.upsertSocialAccount.mockResolvedValue({ id: "acct_1", platform: "TIKTOK", handle: "@creator" });
    repoMocks.upsertPlatformConnection.mockResolvedValue({});

    await connectAccount(actor({ organizationId: "org_real" }), {
      platform: "TIKTOK",
      externalAccountId: "tiktok_open_id_1",
      handle: "@creator",
      displayName: "Creator",
      accessToken: "tok",
      scopes: [],
    });

    expect(repoMocks.upsertSocialAccount).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org_real", platform: "TIKTOK", externalAccountId: "tiktok_open_id_1" }),
      expect.anything(),
    );
  });

  it("writes a SOCIAL_ACCOUNT_CONNECTED audit log with no plaintext token in its metadata", async () => {
    repoMocks.upsertSocialAccount.mockResolvedValue({ id: "acct_1", platform: "TIKTOK", handle: "@creator" });
    repoMocks.upsertPlatformConnection.mockResolvedValue({});

    await connectAccount(actor(), {
      platform: "TIKTOK",
      externalAccountId: "tiktok_open_id_1",
      handle: "@creator",
      displayName: "Creator",
      accessToken: "super-secret-token",
      scopes: ["video.publish"],
    });

    expect(auditLogCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "SOCIAL_ACCOUNT_CONNECTED", organizationId: "org_1" }),
    );
    const metadata = JSON.stringify(auditLogCreateMock.mock.calls[0][0].metadata);
    expect(metadata).not.toContain("super-secret-token");
  });
});

describe("disconnectAccount", () => {
  it("nulls the encrypted credential via revokePlatformConnection and flips status to DISCONNECTED", async () => {
    repoMocks.findSocialAccountById.mockResolvedValue({ id: "acct_1", organizationId: "org_1", status: "CONNECTED", platform: "TIKTOK", handle: "@creator" });
    repoMocks.updateSocialAccountStatus.mockResolvedValue({ id: "acct_1", status: "DISCONNECTED" });
    repoMocks.revokePlatformConnection.mockResolvedValue({});

    const result = await disconnectAccount(actor(), "acct_1");

    expect(repoMocks.updateSocialAccountStatus).toHaveBeenCalledWith("acct_1", { status: "DISCONNECTED" }, expect.anything());
    expect(repoMocks.revokePlatformConnection).toHaveBeenCalledWith("acct_1", expect.anything());
    expect(result.status).toBe("DISCONNECTED");
    expect(auditLogCreateMock).toHaveBeenCalledWith(expect.objectContaining({ action: "SOCIAL_ACCOUNT_DISCONNECTED" }));
  });

  it("rejects an already-DISCONNECTED account with 409 instead of silently no-op'ing", async () => {
    repoMocks.findSocialAccountById.mockResolvedValue({ id: "acct_1", organizationId: "org_1", status: "DISCONNECTED" });

    await expect(disconnectAccount(actor(), "acct_1")).rejects.toMatchObject({ statusCode: 409 });
    expect(repoMocks.updateSocialAccountStatus).not.toHaveBeenCalled();
  });

  it("returns 404 (not found) — never a cross-org account — when the id belongs to a different organization", async () => {
    repoMocks.findSocialAccountById.mockResolvedValue(null); // repository itself is org-scoped and returns null for a cross-org id

    await expect(disconnectAccount(actor({ organizationId: "org_1" }), "acct_in_other_org")).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(repoMocks.findSocialAccountById).toHaveBeenCalledWith("org_1", "acct_in_other_org");
  });
});

describe("getAccountDetail", () => {
  it("404s for an id that doesn't belong to the actor's organization", async () => {
    repoMocks.findSocialAccountById.mockResolvedValue(null);
    await expect(getAccountDetail(actor(), "not-mine")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("never exposes the encrypted token fields — only the credential-free ConnectionSummary", async () => {
    repoMocks.findSocialAccountById.mockResolvedValue({ id: "acct_1", organizationId: "org_1", platform: "TIKTOK" });
    repoMocks.getConnectionSummary.mockResolvedValue({
      scopes: ["video.publish"],
      tokenExpiresAt: new Date(),
      lastRefreshedAt: null,
      hasActiveCredential: true,
    });

    const detail = await getAccountDetail(actor(), "acct_1");
    expect(detail.connection?.hasActiveCredential).toBe(true);
    expect(JSON.stringify(detail)).not.toMatch(/encryptedAccessToken|encryptedRefreshToken/);
  });
});
