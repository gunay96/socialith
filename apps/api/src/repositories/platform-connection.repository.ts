import { prisma } from "@socialith/database";
import type { PlatformConnection, Prisma } from "@socialith/database";

/**
 * Credential vault repository — deliberately its own file, never imported
 * by controllers/social-account.controller.ts or any code that shapes an
 * API response (see schema.prisma's PlatformConnection comment). Only
 * services/social-account.service.ts (disconnect) and
 * packages/database/prisma/seed.ts (dev-only sample data) touch this.
 */
type Db = Pick<typeof prisma, "platformConnection">;

export interface CreatePlatformConnectionInput {
  socialAccountId: string;
  encryptedAccessToken: string;
  encryptedRefreshToken?: string | null;
  tokenExpiresAt?: Date | null;
  scopes: string[];
  providerMetadata?: Prisma.InputJsonValue;
}

export function createPlatformConnection(
  input: CreatePlatformConnectionInput,
  db: Db = prisma,
): Promise<PlatformConnection> {
  // scopes is string[] at every call site (this file's own public
  // interface) but Json at the Prisma/MySQL layer — see schema.prisma's
  // PlatformConnection.scopes comment. Cast at this one boundary only.
  return db.platformConnection.create({ data: { ...input, scopes: input.scopes as Prisma.InputJsonValue } });
}

export function findPlatformConnectionByAccountId(
  socialAccountId: string,
  db: Db = prisma,
): Promise<PlatformConnection | null> {
  return db.platformConnection.findUnique({ where: { socialAccountId } });
}

export interface ConnectionSummary {
  scopes: string[];
  tokenExpiresAt: Date | null;
  lastRefreshedAt: Date | null;
  hasActiveCredential: boolean;
}

/**
 * The one place this vault's data is allowed to reach an API response —
 * a narrow, explicitly credential-free projection (scopes/expiry/refresh
 * timestamp only, never the encrypted token columns themselves) for the
 * Account detail page's "Permissions/scopes" + "Last synced" display.
 * `hasActiveCredential` is derived here, not left for a controller to
 * infer from token presence, so nothing outside this file ever needs to
 * look at `encryptedAccessToken` even to check whether it's null.
 */
export async function getConnectionSummary(socialAccountId: string, db: Db = prisma): Promise<ConnectionSummary | null> {
  const connection = await db.platformConnection.findUnique({
    where: { socialAccountId },
    select: { scopes: true, tokenExpiresAt: true, lastRefreshedAt: true, encryptedAccessToken: true, revokedAt: true },
  });
  if (!connection) return null;
  return {
    // See schema.prisma's PlatformConnection.scopes comment — stored as
    // Json (MySQL has no array type), always written as a string array by
    // every writer in this file, so this cast reflects an invariant this
    // file itself maintains, not an assumption about external data.
    scopes: connection.scopes as string[],
    tokenExpiresAt: connection.tokenExpiresAt,
    lastRefreshedAt: connection.lastRefreshedAt,
    hasActiveCredential: connection.encryptedAccessToken !== null && connection.revokedAt === null,
  };
}

/**
 * Phase 10 real OAuth connect/reconnect: `socialAccountId` is already
 * `@unique` on this table (one row per account, see this file's class
 * comment), so this is a real UPSERT, not upsertSocialAccount's
 * composite-key version — reconnecting always replaces the credential
 * and clears `revokedAt`, matching "disconnect nulls it, reconnect
 * refills it" as the only two states this table's credential fields have.
 */
export function upsertPlatformConnection(input: CreatePlatformConnectionInput, db: Db = prisma): Promise<PlatformConnection> {
  const { socialAccountId, scopes, ...rest } = input;
  const scopesJson = scopes as Prisma.InputJsonValue;
  return db.platformConnection.upsert({
    where: { socialAccountId },
    create: { socialAccountId, scopes: scopesJson, ...rest },
    update: { scopes: scopesJson, ...rest, revokedAt: null },
  });
}

/**
 * Disconnect: nulls the encrypted credential fields and stamps
 * `revokedAt` — never just flips a flag while leaving a still-valid
 * OAuth token sitting in the database. Idempotent at the row level (an
 * already-revoked connection just gets revoked again); the "was it
 * already disconnected" business rule lives in
 * services/social-account.service.ts, scoped to SocialAccount.status.
 */
export function revokePlatformConnection(socialAccountId: string, db: Db = prisma): Promise<PlatformConnection> {
  return db.platformConnection.update({
    where: { socialAccountId },
    data: {
      encryptedAccessToken: null,
      encryptedRefreshToken: null,
      revokedAt: new Date(),
    },
  });
}
