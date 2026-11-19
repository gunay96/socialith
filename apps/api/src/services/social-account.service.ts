import { prisma } from "@socialith/database";
import { loadEnv } from "@socialith/config";
import { encryptToken, parseEncryptionKey } from "@socialith/auth";
import { ERROR_CODES } from "@socialith/types";
import type { Platform, Prisma } from "@socialith/database";
import { ApiHttpError } from "../middleware/error-handler.js";
import {
  listSocialAccounts,
  findSocialAccountById,
  updateSocialAccountStatus,
  upsertSocialAccount,
  type ListSocialAccountsFilters,
  type ListSocialAccountsResult,
  type SocialAccount,
} from "../repositories/social-account.repository.js";
import {
  revokePlatformConnection,
  upsertPlatformConnection,
  getConnectionSummary,
  type ConnectionSummary,
} from "../repositories/platform-connection.repository.js";
import { createAuditLog } from "../repositories/audit-log.repository.js";
import { withUpsertRaceRetry } from "../lib/db-retry.js";
import type { SafeUser } from "../types/auth.js";

export async function getAccounts(
  actor: SafeUser,
  filters: ListSocialAccountsFilters,
): Promise<ListSocialAccountsResult> {
  return listSocialAccounts(actor.organizationId, filters);
}

/**
 * Loads the target scoped to the actor's own organization. An `id` that
 * belongs to a different organization simply doesn't match and comes
 * back "not found" here — never "forbidden" — same reasoning as
 * team.service.ts's loadTargetOrThrow: this endpoint can't be used to
 * probe whether a given ID exists in some other tenant.
 */
async function loadAccountOrThrow(organizationId: string, id: string): Promise<SocialAccount> {
  const account = await findSocialAccountById(organizationId, id);
  if (!account) {
    throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, "Connected account not found.");
  }
  return account;
}

export async function getAccountDetail(actor: SafeUser, id: string): Promise<SocialAccount & { connection: ConnectionSummary | null }> {
  const account = await loadAccountOrThrow(actor.organizationId, id);
  const connection = await getConnectionSummary(account.id);
  return { ...account, connection };
}

/**
 * Disconnects a connected account: flips SocialAccount.status to
 * DISCONNECTED and — in the same transaction — nulls the
 * PlatformConnection's encrypted credential fields (see
 * platform-connection.repository.ts's revokePlatformConnection). Rejects
 * an already-disconnected account with 409 rather than silently
 * succeeding, so a caller can't mistake "no-op" for "just disconnected
 * it" — same conflict-signaling pattern as team.service.ts's
 * last-owner-protection check.
 */
export async function disconnectAccount(actor: SafeUser, id: string): Promise<SocialAccount> {
  const account = await loadAccountOrThrow(actor.organizationId, id);

  if (account.status === "DISCONNECTED") {
    throw new ApiHttpError(409, ERROR_CODES.CONFLICT, "This account is already disconnected.");
  }

  const updated = await prisma.$transaction(async (tx) => {
    const result = await updateSocialAccountStatus(account.id, { status: "DISCONNECTED" }, tx);
    // A seed-created (or future real-OAuth-created) account is expected
    // to always have a PlatformConnection row — but this is defensive
    // rather than assumed, since nothing in the schema *requires* one to
    // exist before disconnecting is attempted.
    await revokePlatformConnection(account.id, tx).catch(() => {
      /* no connection row to revoke — nothing to clean up */
    });
    return result;
  });

  await createAuditLog({
    organizationId: actor.organizationId,
    userId: actor.id,
    action: "SOCIAL_ACCOUNT_DISCONNECTED",
    targetType: "SocialAccount",
    targetId: account.id,
    metadata: { platform: account.platform, handle: account.handle },
  });

  return updated;
}

export interface ConnectAccountInput {
  platform: Platform;
  externalAccountId: string;
  handle: string;
  displayName: string;
  avatarUrl?: string | null;
  followerCount?: number | null;
  providerMetadata?: Record<string, unknown>;
  /** Plaintext — encrypted here, never persisted or logged as-is. */
  accessToken: string;
  refreshToken?: string | null;
  tokenExpiresAt?: Date | null;
  scopes: string[];
}

/**
 * The real OAuth connect/reconnect write path (apps/api/src/routes/oauth.ts's
 * callback handler calls this after a successful token exchange). Upserts
 * both SocialAccount and PlatformConnection keyed the same way disconnect
 * expects, so connecting the same external account a second time (after a
 * disconnect, or just re-running the OAuth flow) updates the existing row
 * instead of creating a duplicate — see upsertSocialAccount's comment.
 * Encryption happens in this one place, using the same AES-256-GCM key
 * already validated at boot (@socialith/config).
 */
export async function connectAccount(actor: SafeUser, input: ConnectAccountInput): Promise<SocialAccount> {
  const key = parseEncryptionKey(loadEnv().TOKEN_ENCRYPTION_KEY);
  const encryptedAccessToken = encryptToken(input.accessToken, key);
  const encryptedRefreshToken = input.refreshToken ? encryptToken(input.refreshToken, key) : null;

  // The whole transaction is retried from scratch on a lost upsert race
  // (P2002/P2034): MySQL has no native Prisma upsert, so simultaneous OAuth
  // callbacks for one external account can collide — see lib/db-retry.ts.
  const account = await withUpsertRaceRetry(() =>
    prisma.$transaction(async (tx) => {
      const result = await upsertSocialAccount(
        {
          organizationId: actor.organizationId,
          platform: input.platform,
          externalAccountId: input.externalAccountId,
          handle: input.handle,
          displayName: input.displayName,
          avatarUrl: input.avatarUrl ?? null,
          followerCount: input.followerCount ?? null,
          connectedById: actor.id,
          providerMetadata: input.providerMetadata as Prisma.InputJsonValue | undefined,
        },
        tx,
      );
      await upsertPlatformConnection(
        {
          socialAccountId: result.id,
          encryptedAccessToken,
          encryptedRefreshToken,
          tokenExpiresAt: input.tokenExpiresAt ?? null,
          scopes: input.scopes,
        },
        tx,
      );
      return result;
    }),
  );

  await createAuditLog({
    organizationId: actor.organizationId,
    userId: actor.id,
    action: "SOCIAL_ACCOUNT_CONNECTED",
    targetType: "SocialAccount",
    targetId: account.id,
    metadata: { platform: account.platform, handle: account.handle, scopes: input.scopes },
  });

  return account;
}
