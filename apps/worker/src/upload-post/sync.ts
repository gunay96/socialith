import { Prisma, type PrismaClient, type SocialAccountStatus, type UploadPostAccountStatus } from "@socialith/database";
import { UploadPostError, type UploadPostClient, type UploadPostConnectedAccountData, type UploadPostProfileData } from "@socialith/upload-post";
import { logger as defaultLogger } from "../logger.js";

/**
 * Read-only synchronization of Upload-Post profiles and their connected accounts into the database
 * (`GET /uploadposts/users`). It writes ONLY provider-owned columns: the Socialith-side mappings
 * (managedPageId, creatorId, destination links) are never touched, so a sync can never undo a mapping.
 *
 * Guarantees (each covered by tests/integration):
 *  - no duplicate rows, however often it runs or races: (organization, username) and (profile, platform) are unique;
 *  - nothing is ever deleted: profiles/accounts that disappear upstream are flagged REMOVED / DISCONNECTED;
 *  - a failed or implausible provider response changes NOTHING (an outage can't mass-"remove" everything);
 *  - stable identity: accounts are keyed by the provider's stable account id, handles are display data;
 *    when the stable id behind (profile, platform) CHANGES, a linked publishing destination is flagged ERROR
 *    instead of silently publishing to a different account.
 */
export interface SyncSummary {
  profilesSeen: number;
  profilesCreated: number;
  profilesUpdated: number;
  profilesRemoved: number;
  accountsSeen: number;
  accountsCreated: number;
  accountsUpdated: number;
  accountsDisconnected: number;
  accountsReauth: number;
  identityChanges: number;
}

export type SyncOutcome =
  | { status: "SKIPPED_ALREADY_RUNNING" }
  | { status: "FAILED"; runId: string; errorKind: string; errorMessage: string }
  | { status: "SUCCEEDED"; runId: string; summary: SyncSummary; plan: string | null; profileLimit: number | null };

export interface SyncDeps {
  db: PrismaClient;
  client: UploadPostClient;
  now?: () => Date;
  log?: Pick<typeof defaultLogger, "info" | "warn">;
}

/** A RUNNING row older than this is a crashed run, not a concurrent one. */
const RUNNING_STALE_MS = 10 * 60_000;
/** With this many ACTIVE profiles, an empty provider list is treated as an anomaly, not as "everything was deleted". */
const SUSPICIOUS_EMPTY_THRESHOLD = 5;

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002";
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function destinationStatus(status: UploadPostAccountStatus): { status: SocialAccountStatus; message: string | null } {
  switch (status) {
    case "CONNECTED":
      return { status: "CONNECTED", message: null };
    case "REAUTH_REQUIRED":
      return { status: "EXPIRED", message: "Upload-Post reports this account must be reconnected (authorization expired)." };
    case "DISCONNECTED":
      return { status: "DISCONNECTED", message: "This account is no longer connected in its Upload-Post profile." };
  }
}

export async function syncUploadPostProfiles(
  deps: SyncDeps,
  organizationId: string,
  trigger: "SCHEDULED" | "MANUAL" | "STARTUP",
): Promise<SyncOutcome> {
  const { db, client } = deps;
  const log = deps.log ?? defaultLogger;
  const now = (deps.now ?? (() => new Date()))();

  const running = await db.uploadPostSyncRun.findFirst({
    where: { organizationId, status: "RUNNING", startedAt: { gt: new Date(now.getTime() - RUNNING_STALE_MS) } },
    select: { id: true },
  });
  if (running) return { status: "SKIPPED_ALREADY_RUNNING" };

  const run = await db.uploadPostSyncRun.create({ data: { organizationId, trigger, status: "RUNNING", startedAt: now } });
  const fail = async (errorKind: string, errorMessage: string): Promise<SyncOutcome> => {
    await db.uploadPostSyncRun.update({
      where: { id: run.id },
      data: { status: "FAILED", finishedAt: new Date(), errorKind, errorMessage: errorMessage.slice(0, 1000) },
    });
    log.warn({ organizationId, runId: run.id, errorKind }, "upload-post sync failed; nothing was changed");
    return { status: "FAILED", runId: run.id, errorKind, errorMessage };
  };

  let list;
  try {
    list = await client.listProfiles();
  } catch (err) {
    if (err instanceof UploadPostError) return fail(err.kind, err.message);
    throw err;
  }

  const activeLocal = await db.uploadPostProfile.count({ where: { organizationId, status: "ACTIVE" } });
  if (list.profiles.length === 0 && activeLocal >= SUSPICIOUS_EMPTY_THRESHOLD) {
    return fail(
      "SUSPICIOUS_EMPTY",
      `Upload-Post returned no profiles although ${activeLocal} are known. Refusing to mark them all removed; re-run the sync to confirm.`,
    );
  }

  const summary: SyncSummary = {
    profilesSeen: list.profiles.length,
    profilesCreated: 0,
    profilesUpdated: 0,
    profilesRemoved: 0,
    accountsSeen: 0,
    accountsCreated: 0,
    accountsUpdated: 0,
    accountsDisconnected: 0,
    accountsReauth: 0,
    identityChanges: 0,
  };

  for (const profile of list.profiles) {
    summary.accountsSeen += profile.accounts.length;
    try {
      await db.$transaction((tx) => syncOneProfile(tx, organizationId, profile, now, summary));
    } catch (err) {
      // A concurrent writer created the row between our read and insert (unique constraint): the data is the same, retry once as an update.
      if (!isUniqueViolation(err)) throw err;
      await db.$transaction((tx) => syncOneProfile(tx, organizationId, profile, now, summary));
    }
  }

  // Profiles that are no longer returned: flag, never delete.
  const seenUsernames = list.profiles.map((p) => p.username);
  const gone = await db.uploadPostProfile.findMany({
    where: { organizationId, status: "ACTIVE", username: { notIn: seenUsernames.length ? seenUsernames : ["\u0000"] } },
    include: { accounts: true },
  });
  for (const profile of gone) {
    await db.$transaction(async (tx) => {
      await tx.uploadPostProfile.update({ where: { id: profile.id }, data: { status: "REMOVED", removedAt: now, lastSyncedAt: now } });
      for (const account of profile.accounts.filter((a) => a.status !== "DISCONNECTED")) {
        await markDisconnected(tx, organizationId, account.id, account.socialAccountId, now, "profile removed upstream");
        summary.accountsDisconnected++;
      }
    });
    summary.profilesRemoved++;
  }

  await db.uploadPostSyncRun.update({
    where: { id: run.id },
    data: {
      status: "SUCCEEDED",
      finishedAt: new Date(),
      profilesSeen: summary.profilesSeen,
      profilesCreated: summary.profilesCreated,
      profilesUpdated: summary.profilesUpdated,
      profilesRemoved: summary.profilesRemoved,
      accountsSeen: summary.accountsSeen,
      accountsCreated: summary.accountsCreated,
      accountsUpdated: summary.accountsUpdated,
      accountsDisconnected: summary.accountsDisconnected,
      accountsReauth: summary.accountsReauth,
      plan: list.plan,
      profileLimit: list.profileLimit,
    },
  });
  log.info({ organizationId, runId: run.id, ...summary }, "upload-post sync finished");
  return { status: "SUCCEEDED", runId: run.id, summary, plan: list.plan, profileLimit: list.profileLimit };
}

async function markDisconnected(
  tx: Prisma.TransactionClient,
  organizationId: string,
  accountId: string,
  socialAccountId: string | null,
  now: Date,
  reason: string,
): Promise<void> {
  await tx.uploadPostConnectedAccount.update({ where: { id: accountId }, data: { status: "DISCONNECTED", disconnectedAt: now, reauthRequired: false } });
  if (socialAccountId) {
    const d = destinationStatus("DISCONNECTED");
    await tx.socialAccount.update({ where: { id: socialAccountId }, data: { status: d.status, lastErrorMessage: d.message } });
  }
  await tx.auditLog.create({
    data: { organizationId, action: "UPLOAD_POST_ACCOUNT_DISCONNECTED", targetType: "UploadPostConnectedAccount", targetId: accountId, metadataJson: { reason } },
  });
}

async function syncOneProfile(
  tx: Prisma.TransactionClient,
  organizationId: string,
  profile: UploadPostProfileData,
  now: Date,
  summary: SyncSummary,
): Promise<void> {
  const existing = await tx.uploadPostProfile.findUnique({
    where: { organizationId_username: { organizationId, username: profile.username } },
    include: { accounts: true },
  });

  const pending = profile.pendingPlatforms.length ? profile.pendingPlatforms : null;
  let profileId: string;
  let accounts: NonNullable<typeof existing>["accounts"] = [];

  if (!existing) {
    const created = await tx.uploadPostProfile.create({
      data: {
        organizationId,
        username: profile.username,
        displayName: profile.displayName,
        providerCreatedAt: profile.createdAt,
        pendingPlatforms: pending ?? undefined,
        lastSyncedAt: now,
      },
    });
    profileId = created.id;
    summary.profilesCreated++;
  } else {
    profileId = existing.id;
    accounts = existing.accounts;
    const changed =
      existing.displayName !== profile.displayName ||
      existing.status !== "ACTIVE" ||
      !sameJson(existing.pendingPlatforms, pending) ||
      (existing.providerCreatedAt?.getTime() ?? null) !== (profile.createdAt?.getTime() ?? null);
    await tx.uploadPostProfile.update({
      where: { id: existing.id },
      data: {
        displayName: profile.displayName,
        providerCreatedAt: profile.createdAt,
        status: "ACTIVE",
        removedAt: null,
        pendingPlatforms: pending ?? Prisma.JsonNull,
        lastSyncedAt: now,
      },
    });
    if (changed) summary.profilesUpdated++;
  }

  const byPlatform = new Map(accounts.map((a) => [a.platform, a]));
  for (const acc of profile.accounts) {
    await syncOneAccount(tx, organizationId, profileId, acc, byPlatform.get(acc.platform), now, summary);
  }

  const presentPlatforms = new Set(profile.accounts.map((a) => a.platform));
  for (const old of accounts) {
    if (!presentPlatforms.has(old.platform) && old.status !== "DISCONNECTED") {
      await markDisconnected(tx, organizationId, old.id, old.socialAccountId, now, "account no longer in profile at provider");
      summary.accountsDisconnected++;
    }
  }
}

async function syncOneAccount(
  tx: Prisma.TransactionClient,
  organizationId: string,
  profileId: string,
  acc: UploadPostConnectedAccountData,
  existing: { id: string; providerAccountId: string; handle: string | null; displayName: string | null; avatarUrl: string | null; status: UploadPostAccountStatus; reauthRequired: boolean; capabilities: Prisma.JsonValue; socialAccountId: string | null } | undefined,
  now: Date,
  summary: SyncSummary,
): Promise<void> {
  const status: UploadPostAccountStatus = acc.reauthRequired ? "REAUTH_REQUIRED" : "CONNECTED";
  if (acc.reauthRequired) summary.accountsReauth++;
  const capabilities = acc.capabilities.length ? acc.capabilities : undefined;

  if (!existing) {
    await tx.uploadPostConnectedAccount.create({
      data: {
        organizationId,
        profileId,
        platform: acc.platform,
        providerAccountId: acc.providerAccountId,
        handle: acc.handle,
        displayName: acc.displayName,
        avatarUrl: acc.avatarUrl,
        status,
        reauthRequired: acc.reauthRequired,
        capabilities,
        lastSeenAt: now,
      },
    });
    summary.accountsCreated++;
    return;
  }

  const identityChanged = existing.providerAccountId !== acc.providerAccountId;
  const changed =
    identityChanged ||
    existing.handle !== acc.handle ||
    existing.displayName !== acc.displayName ||
    existing.avatarUrl !== acc.avatarUrl ||
    existing.status !== status ||
    existing.reauthRequired !== acc.reauthRequired ||
    !sameJson(existing.capabilities, capabilities ?? null);

  await tx.uploadPostConnectedAccount.update({
    where: { id: existing.id },
    data: {
      providerAccountId: acc.providerAccountId,
      handle: acc.handle,
      displayName: acc.displayName,
      avatarUrl: acc.avatarUrl,
      status,
      reauthRequired: acc.reauthRequired,
      capabilities: capabilities ?? Prisma.JsonNull,
      lastSeenAt: now,
      disconnectedAt: null,
      // A different account now sits behind (profile, platform): the old destination link is
      // invalidated (publication history stays on the old SocialAccount, which is kept).
      ...(identityChanged && existing.socialAccountId ? { socialAccountId: null } : {}),
    },
  });
  if (changed) summary.accountsUpdated++;

  if (existing.status !== status && status === "REAUTH_REQUIRED") {
    await tx.auditLog.create({
      data: { organizationId, action: "UPLOAD_POST_ACCOUNT_REAUTH_REQUIRED", targetType: "UploadPostConnectedAccount", targetId: existing.id, metadataJson: { platform: acc.platform } },
    });
  }

  if (existing.socialAccountId) {
    if (identityChanged) {
      // The account behind this (profile, platform) is a DIFFERENT one now. Publishing goes by profile+platform,
      // so without this the destination would silently publish to the new account. Block it until a human re-confirms.
      summary.identityChanges++;
      await tx.socialAccount.update({
        where: { id: existing.socialAccountId },
        data: {
          status: "ERROR",
          lastErrorMessage: `The connected ${acc.platform} account changed at Upload-Post (a different account is now connected). Review it and re-enable this destination.`,
        },
      });
      await tx.auditLog.create({
        data: {
          organizationId,
          action: "UPLOAD_POST_ACCOUNT_IDENTITY_CHANGED",
          targetType: "UploadPostConnectedAccount",
          targetId: existing.id,
          metadataJson: { platform: acc.platform, previousProviderAccountId: existing.providerAccountId, newProviderAccountId: acc.providerAccountId },
        },
      });
    } else {
      const d = destinationStatus(status);
      await tx.socialAccount.update({
        where: { id: existing.socialAccountId },
        data: {
          status: d.status,
          lastErrorMessage: d.message,
          handle: acc.handle ?? undefined,
          displayName: acc.displayName ?? undefined,
          avatarUrl: acc.avatarUrl ?? undefined,
          lastSyncedAt: now,
        },
      });
    }
  }
}
