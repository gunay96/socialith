import { decryptToken, encryptToken, parseEncryptionKey } from "@socialith/auth";
import { prisma } from "@socialith/database";
import type { Env } from "@socialith/config";
import type { Platform, PlatformConnection, SocialAccount } from "@socialith/database";
import { fetchOrThrow, throwForErrorResponse } from "./http.js";
import { PublishError } from "./types.js";

/** A token that's about to expire is treated as already expired — refreshing 2 minutes early avoids a publish attempt racing an expiry mid-flight. */
const EXPIRY_BUFFER_MS = 2 * 60 * 1000;

interface RefreshResult {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
}

/**
 * Real per-platform refresh calls. Each uses the app-level OAuth
 * credentials from @socialith/config (TIKTOK_CLIENT_KEY/SECRET,
 * META_APP_ID/SECRET, GOOGLE_CLIENT_ID/SECRET) — missing credentials
 * throw a real CONFIGURATION_ERROR rather than attempting a call that
 * could never succeed.
 */
async function refreshAccessToken(platform: Platform, refreshToken: string, env: Env): Promise<RefreshResult> {
  if (platform === "TIKTOK") {
    if (!env.TIKTOK_CLIENT_KEY || !env.TIKTOK_CLIENT_SECRET) {
      throw new PublishError("TIKTOK_CLIENT_KEY/TIKTOK_CLIENT_SECRET is not configured.", "CONFIGURATION_ERROR", false);
    }
    const res = await fetchOrThrow(
      "https://open.tiktokapis.com/v2/oauth/token/",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_key: env.TIKTOK_CLIENT_KEY,
          client_secret: env.TIKTOK_CLIENT_SECRET,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }),
      },
      "TikTok token refresh",
    );
    if (!res.ok) await throwForErrorResponse(res, "TikTok token refresh");
    const body = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!body.access_token) {
      throw new PublishError("TikTok token refresh response had no access_token.", "AUTH_ERROR", false, res.status);
    }
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? refreshToken,
      expiresAt: body.expires_in ? new Date(Date.now() + body.expires_in * 1000) : null,
    };
  }

  if (platform === "INSTAGRAM") {
    // Meta long-lived tokens don't use a separate refresh_token grant —
    // they're extended via a fb_exchange_token call using the *current*
    // access token (stored as encryptedAccessToken, passed in here as
    // `refreshToken` by resolveAccessToken's caller — see there for why).
    if (!env.META_APP_ID || !env.META_APP_SECRET) {
      throw new PublishError("META_APP_ID/META_APP_SECRET is not configured.", "CONFIGURATION_ERROR", false);
    }
    const url = new URL("https://graph.facebook.com/v26.0/oauth/access_token");
    url.searchParams.set("grant_type", "fb_exchange_token");
    url.searchParams.set("client_id", env.META_APP_ID);
    url.searchParams.set("client_secret", env.META_APP_SECRET);
    url.searchParams.set("fb_exchange_token", refreshToken);
    const res = await fetchOrThrow(url.toString(), { method: "GET" }, "Instagram token refresh");
    if (!res.ok) await throwForErrorResponse(res, "Instagram token refresh");
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) {
      throw new PublishError("Instagram token refresh response had no access_token.", "AUTH_ERROR", false, res.status);
    }
    return {
      accessToken: body.access_token,
      refreshToken: body.access_token, // Meta's long-lived token IS its own next exchange input
      expiresAt: body.expires_in ? new Date(Date.now() + body.expires_in * 1000) : null,
    };
  }

  // YOUTUBE
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new PublishError("GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET is not configured.", "CONFIGURATION_ERROR", false);
  }
  const res = await fetchOrThrow(
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    },
    "YouTube token refresh",
  );
  if (!res.ok) await throwForErrorResponse(res, "YouTube token refresh");
  const body = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) {
    throw new PublishError("YouTube token refresh response had no access_token.", "AUTH_ERROR", false, res.status);
  }
  return {
    accessToken: body.access_token,
    refreshToken, // Google does not rotate the refresh token on each refresh
    expiresAt: body.expires_in ? new Date(Date.now() + body.expires_in * 1000) : null,
  };
}

/**
 * Shared by resolveAccessToken's just-in-time path and
 * forceRefreshAccessToken's proactive-scheduled path — the actual refresh
 * call + re-encrypt + persist, exactly once in one place.
 *
 * Race condition guard: a publishing job (JIT refresh) and the scheduled
 * token-refresh worker (proactive refresh) can both decide a connection
 * needs refreshing at the same moment — or two publishing jobs for two
 * ContentTargets on the same SocialAccount can race each other. Without a
 * lock, both would call the real platform refresh endpoint with the same
 * refresh_token; a provider that rotates refresh tokens (TikTok does)
 * would then reject whichever call loses the race with a real
 * invalid_grant, not a hypothetical concern. Guarded by a
 * transaction-scoped Postgres advisory lock keyed on the connection's id
 * (auto-released on commit/rollback, never a row lock — unrelated reads
 * of this row are never blocked) so only one refresh-and-persist for a
 * given connection is ever in flight at once; a transaction that loses
 * the race re-reads the row after acquiring the lock and, finding the
 * stored credential has already changed since the caller's own snapshot,
 * returns that result instead of refreshing again.
 *
 * Deliberately does NOT re-derive "is it still expired" from
 * EXPIRY_BUFFER_MS inside the lock — that buffer is resolveAccessToken's
 * own just-in-time policy, and forceRefreshAccessToken exists specifically
 * to *bypass* it (the scheduled worker's wider safety window already
 * decided a refresh is warranted). Re-applying the narrow buffer here
 * would silently turn every forced refresh into a same-token no-op
 * whenever the token still had, say, 90 minutes left — a real bug this
 * function's own test suite (token.test.ts) caught. Instead, the only
 * question asked under the lock is "did the stored credential change
 * since the caller took their snapshot" — a real signal of a raced
 * refresh, independent of which caller/policy triggered this call.
 */
async function refreshAndPersist(
  env: Env,
  socialAccount: Pick<SocialAccount, "platform">,
  connection: Pick<PlatformConnection, "id" | "encryptedAccessToken">,
  key: Buffer,
): Promise<string> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${connection.id})::bigint)`;

      const fresh = await tx.platformConnection.findUnique({ where: { id: connection.id } });
      if (!fresh || fresh.revokedAt) {
        throw new PublishError(
          `Connection was revoked or removed (platform: ${socialAccount.platform}). Reconnect the account.`,
          "CONFIGURATION_ERROR",
          false,
        );
      }

      if (fresh.encryptedAccessToken && fresh.encryptedAccessToken !== connection.encryptedAccessToken) {
        // Another transaction refreshed this exact connection while we
        // were waiting for the advisory lock — use its result rather
        // than making a second, redundant (and potentially
        // rotation-breaking) refresh call.
        return decryptToken(fresh.encryptedAccessToken, key);
      }

      const refreshInput =
        socialAccount.platform === "INSTAGRAM" ? fresh.encryptedAccessToken : fresh.encryptedRefreshToken;
      if (!refreshInput) {
        throw new PublishError(
          `No refresh token is stored for this account (platform: ${socialAccount.platform}). Reconnect the account.`,
          "CONFIGURATION_ERROR",
          false,
        );
      }

      const refreshed = await refreshAccessToken(socialAccount.platform, decryptToken(refreshInput, key), env);

      await tx.platformConnection.update({
        where: { id: connection.id },
        data: {
          encryptedAccessToken: encryptToken(refreshed.accessToken, key),
          encryptedRefreshToken: refreshed.refreshToken ? encryptToken(refreshed.refreshToken, key) : fresh.encryptedRefreshToken,
          tokenExpiresAt: refreshed.expiresAt,
          lastRefreshedAt: new Date(),
        },
      });

      return refreshed.accessToken;
    },
    // Real network I/O happens inside this transaction (the refresh HTTP
    // call) — Prisma's default 5s interactive-transaction timeout is too
    // tight for that plus a lock wait under contention.
    { timeout: 20_000 },
  );
}

/**
 * Resolves a real, usable access token for this SocialAccount — refreshing
 * it first if it's missing/expired and a refresh path exists, and
 * persisting the refreshed credential back (re-encrypted) so the next
 * attempt doesn't refresh again unnecessarily. Never returns a plaintext
 * token to a caller outside this module's own call chain (the publishing
 * processor holds it only in memory for the duration of one publish
 * attempt — see processors/publishing.processor.ts). This is the one
 * centralized token-lifecycle entry point every consumer (publishing,
 * analytics-sync, and the scheduled token-refresh worker below) goes
 * through — none of them read PlatformConnection's encrypted columns
 * directly.
 *
 * Throws PublishError(CONFIGURATION_ERROR) — no network call at all — when
 * there's no connection, no token, or the connection was revoked. This is
 * the primary, safe, zero-external-call failure path for every account in
 * an environment with no real OAuth credentials.
 */
export async function resolveAccessToken(
  env: Env,
  socialAccount: Pick<SocialAccount, "id" | "platform" | "status">,
  connection: PlatformConnection | null,
): Promise<string> {
  if (!connection || connection.revokedAt || !connection.encryptedAccessToken) {
    throw new PublishError(
      `No active platform connection for this account (platform: ${socialAccount.platform}). Connect the account before publishing.`,
      "CONFIGURATION_ERROR",
      false,
    );
  }

  const key = parseEncryptionKey(env.TOKEN_ENCRYPTION_KEY);
  const isExpired = connection.tokenExpiresAt !== null && connection.tokenExpiresAt.getTime() - EXPIRY_BUFFER_MS <= Date.now();

  if (!isExpired) {
    return decryptToken(connection.encryptedAccessToken, key);
  }

  return refreshAndPersist(env, socialAccount, connection, key);
}

/**
 * Phase 10's scheduled token-refresh worker calls this instead of
 * resolveAccessToken — the scan that enqueues these jobs already decided
 * (via a wider safety-window query, see
 * processors/token-refresh-scan.processor.ts) that this connection is
 * due for a proactive refresh; resolveAccessToken's own much narrower
 * "expires within 2 minutes" check would otherwise treat a token expiring
 * in, say, 90 minutes as still fine and skip the refresh entirely. Same
 * CONFIGURATION_ERROR-first behavior for a missing/revoked connection.
 */
export async function forceRefreshAccessToken(
  env: Env,
  socialAccount: Pick<SocialAccount, "platform">,
  connection: PlatformConnection,
): Promise<string> {
  if (connection.revokedAt || !connection.encryptedAccessToken) {
    throw new PublishError(`Connection is revoked or has no credential (platform: ${socialAccount.platform}).`, "CONFIGURATION_ERROR", false);
  }
  const key = parseEncryptionKey(env.TOKEN_ENCRYPTION_KEY);
  return refreshAndPersist(env, socialAccount, connection, key);
}
