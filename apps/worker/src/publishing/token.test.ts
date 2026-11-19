import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { encryptToken, parseEncryptionKey } from "@socialith/auth";

const KEY_HEX = "a".repeat(64);
const KEY = parseEncryptionKey(KEY_HEX);

const { connectionsById, txMock, queryRawMock } = vi.hoisted(() => {
  const connectionsById = new Map<string, Record<string, unknown>>();
  const queryRawMock = vi.fn().mockResolvedValue(undefined); // pg_advisory_xact_lock — no real Postgres in this unit test, just proves it was called
  const txMock = {
    $queryRaw: queryRawMock,
    platformConnection: {
      findUnique: async ({ where }: { where: { id: string } }) => connectionsById.get(where.id) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const existing = connectionsById.get(where.id);
        if (!existing) throw new Error("connection not found");
        Object.assign(existing, data);
        return existing;
      },
    },
  };
  return { connectionsById, txMock, queryRawMock };
});

vi.mock("@socialith/database", () => ({
  prisma: { $transaction: async (callback: (tx: typeof txMock) => Promise<unknown>) => callback(txMock) },
}));

const { resolveAccessToken, forceRefreshAccessToken } = await import("./token.js");

const ENV = {
  TOKEN_ENCRYPTION_KEY: KEY_HEX,
  TIKTOK_CLIENT_KEY: "client-key",
  TIKTOK_CLIENT_SECRET: "client-secret",
} as unknown as Parameters<typeof resolveAccessToken>[0];

function seedConnection(overrides: Record<string, unknown> = {}) {
  const connection = {
    id: "conn_1",
    socialAccountId: "acct_1",
    encryptedAccessToken: encryptToken("old-access-token", KEY),
    encryptedRefreshToken: encryptToken("old-refresh-token", KEY),
    tokenExpiresAt: new Date(Date.now() + 3600_000), // valid for an hour by default
    lastRefreshedAt: null,
    revokedAt: null,
    scopes: ["video.publish"],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
  connectionsById.set(connection.id as string, connection);
  return connection;
}

const TIKTOK_ACCOUNT = { id: "acct_1", platform: "TIKTOK" as const, status: "CONNECTED" as const };

beforeEach(() => {
  connectionsById.clear();
  queryRawMock.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveAccessToken", () => {
  it("returns the decrypted token directly, without refreshing, when it isn't near expiry", async () => {
    seedConnection({ tokenExpiresAt: new Date(Date.now() + 3600_000) });
    global.fetch = vi.fn() as unknown as typeof fetch;

    const token = await resolveAccessToken(ENV, TIKTOK_ACCOUNT, connectionsById.get("conn_1") as never);

    expect(token).toBe("old-access-token");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("refreshes and persists (re-encrypted) when the token is within the expiry buffer", async () => {
    seedConnection({ tokenExpiresAt: new Date(Date.now() + 60_000) }); // within the 2-minute buffer
    global.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ access_token: "new-access-token", refresh_token: "new-refresh-token", expires_in: 86400 }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;

    const token = await resolveAccessToken(ENV, TIKTOK_ACCOUNT, connectionsById.get("conn_1") as never);

    expect(token).toBe("new-access-token");
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const persisted = connectionsById.get("conn_1")!;
    expect(persisted.encryptedAccessToken).not.toBe(encryptToken("old-access-token", KEY)); // re-encrypted with a fresh IV, never plaintext-equal by chance
    const { decryptToken } = await import("@socialith/auth");
    expect(decryptToken(persisted.encryptedAccessToken as string, KEY)).toBe("new-access-token");
    expect(persisted.lastRefreshedAt).toBeInstanceOf(Date);
  });

  it("acquires the real Postgres advisory lock before deciding whether to refresh (race-condition guard)", async () => {
    seedConnection({ tokenExpiresAt: new Date(Date.now() + 60_000) });
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ access_token: "new-access-token", expires_in: 86400 }), { status: 200 }),
    ) as unknown as typeof fetch;

    await resolveAccessToken(ENV, TIKTOK_ACCOUNT, connectionsById.get("conn_1") as never);

    expect(queryRawMock).toHaveBeenCalledTimes(1);
  });

  it("when another process already refreshed the connection while this one waited for the lock, reuses that result instead of calling the platform again", async () => {
    // Simulates the race: the connection passed in looks expired, but by
    // the time this transaction's advisory lock is granted and it
    // re-reads the row, a concurrent refresh already updated it.
    seedConnection({ tokenExpiresAt: new Date(Date.now() - 1000) });
    const staleConnection = { ...connectionsById.get("conn_1")! };
    connectionsById.set("conn_1", {
      ...staleConnection,
      encryptedAccessToken: encryptToken("already-refreshed-by-someone-else", KEY),
      tokenExpiresAt: new Date(Date.now() + 3600_000),
    });
    global.fetch = vi.fn() as unknown as typeof fetch;

    const token = await resolveAccessToken(ENV, TIKTOK_ACCOUNT, staleConnection as never);

    expect(token).toBe("already-refreshed-by-someone-else");
    expect(global.fetch).not.toHaveBeenCalled(); // never made a second, redundant/rotation-breaking refresh call
  });

  it("keeps the existing refresh token when the platform doesn't rotate it (TikTok's response omits refresh_token)", async () => {
    const original = seedConnection({ tokenExpiresAt: new Date(Date.now() - 1000) });
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ access_token: "new-access-token", expires_in: 86400 }), { status: 200 }),
    ) as unknown as typeof fetch;

    await resolveAccessToken(ENV, TIKTOK_ACCOUNT, original as never);

    const persisted = connectionsById.get("conn_1")!;
    expect(persisted.encryptedRefreshToken).toBe(original.encryptedRefreshToken); // unchanged
  });

  it("rotates the stored refresh token when the platform issues a new one", async () => {
    seedConnection({ tokenExpiresAt: new Date(Date.now() - 1000) });
    global.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ access_token: "new-access-token", refresh_token: "rotated-refresh-token", expires_in: 86400 }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;

    await resolveAccessToken(ENV, TIKTOK_ACCOUNT, connectionsById.get("conn_1") as never);

    const { decryptToken } = await import("@socialith/auth");
    const persisted = connectionsById.get("conn_1")!;
    expect(decryptToken(persisted.encryptedRefreshToken as string, KEY)).toBe("rotated-refresh-token");
  });

  it("throws a real CONFIGURATION_ERROR (no network call) when no refresh token is stored at all", async () => {
    seedConnection({ tokenExpiresAt: new Date(Date.now() - 1000), encryptedRefreshToken: null });
    global.fetch = vi.fn() as unknown as typeof fetch;

    await expect(resolveAccessToken(ENV, TIKTOK_ACCOUNT, connectionsById.get("conn_1") as never)).rejects.toMatchObject({
      code: "CONFIGURATION_ERROR",
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("throws CONFIGURATION_ERROR when there is no connection at all", async () => {
    await expect(resolveAccessToken(ENV, TIKTOK_ACCOUNT, null)).rejects.toMatchObject({ code: "CONFIGURATION_ERROR" });
  });

  it("rejects a genuine platform refresh rejection (e.g. TikTok's real invalid_grant on a revoked/reused refresh token) without persisting anything", async () => {
    const original = seedConnection({ tokenExpiresAt: new Date(Date.now() - 1000) });
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: "invalid_grant", error_description: "Refresh token is invalid or expired." }), {
        status: 400,
      }),
    ) as unknown as typeof fetch;

    await expect(resolveAccessToken(ENV, TIKTOK_ACCOUNT, original as never)).rejects.toThrow();
    const persisted = connectionsById.get("conn_1")!;
    expect(persisted.encryptedAccessToken).toBe(original.encryptedAccessToken); // untouched
  });
});

describe("forceRefreshAccessToken", () => {
  it("refreshes even when the token is NOT near expiry (the scheduled worker's wider safety window already decided this)", async () => {
    seedConnection({ tokenExpiresAt: new Date(Date.now() + 3600_000) }); // would NOT trigger resolveAccessToken's own refresh
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ access_token: "proactively-refreshed-token", expires_in: 86400 }), { status: 200 }),
    ) as unknown as typeof fetch;

    const token = await forceRefreshAccessToken(ENV, TIKTOK_ACCOUNT, connectionsById.get("conn_1") as never);

    expect(token).toBe("proactively-refreshed-token");
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("throws CONFIGURATION_ERROR for a revoked connection instead of refreshing a dead credential", async () => {
    seedConnection({ revokedAt: new Date() });
    global.fetch = vi.fn() as unknown as typeof fetch;

    await expect(
      forceRefreshAccessToken(ENV, TIKTOK_ACCOUNT, connectionsById.get("conn_1") as never),
    ).rejects.toMatchObject({ code: "CONFIGURATION_ERROR" });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
