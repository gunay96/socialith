import { prisma } from "@socialith/database";
import { loadEnv } from "@socialith/config";
import { ERROR_CODES } from "@socialith/types";
import {
  INTEGRATION_ORGANIZATION_MESSAGES,
  UploadPostError,
  resolveIntegrationOrganization,
  type TikTokMusicResult,
} from "@socialith/upload-post";
import type { Prisma } from "@socialith/database";
import { ApiHttpError } from "../middleware/error-handler.js";
import { createAuditLog } from "../repositories/audit-log.repository.js";
import { enqueueUploadPostSync, getUploadPostClient, probeProvider, type HealthProbe } from "../lib/upload-post.js";
import type { SafeUser } from "../types/auth.js";

/** Platforms Socialith can publish to today (the `Platform` enum). Other provider platforms are synchronized and shown only. */
export const PUBLISHABLE_PLATFORMS = ["tiktok", "instagram", "youtube"] as const;

type Paging = { page: number; pageSize: number };
const skipTake = (p: Paging) => ({ skip: (p.page - 1) * p.pageSize, take: p.pageSize });

// ------------------------------------------------------------------------------------ errors --

/** Provider failure → HTTP error with an actionable message. The API key never appears in any of them. */
export function toApiError(err: unknown): ApiHttpError {
  if (err instanceof ApiHttpError) return err;
  if (!(err instanceof UploadPostError)) return new ApiHttpError(500, ERROR_CODES.INTERNAL_ERROR, "Unexpected error talking to Upload-Post.");
  switch (err.kind) {
    case "NOT_CONFIGURED":
      return new ApiHttpError(503, ERROR_CODES.CONFIGURATION_ERROR, "Upload-Post is not configured on this server (UPLOAD_POST_API_KEY is not set).");
    case "AUTH":
      return new ApiHttpError(502, ERROR_CODES.CONFIGURATION_ERROR, "Upload-Post rejected the configured API key. Replace it in the server environment.");
    case "FORBIDDEN_PLAN":
    case "QUOTA_EXCEEDED":
      return new ApiHttpError(409, ERROR_CODES.CONFIGURATION_ERROR, `Upload-Post: ${err.message}`);
    case "REAUTH_REQUIRED":
      return new ApiHttpError(409, ERROR_CODES.REAUTH_REQUIRED, `The social account must be reconnected in Upload-Post: ${err.message}`);
    case "NOT_FOUND":
      return new ApiHttpError(404, ERROR_CODES.NOT_FOUND, `Upload-Post: ${err.message}`);
    case "VALIDATION":
    case "CONFLICT":
      return new ApiHttpError(400, ERROR_CODES.INVALID_REQUEST, `Upload-Post: ${err.message}`);
    case "RATE_LIMITED":
      return new ApiHttpError(429, ERROR_CODES.RATE_LIMITED, "Upload-Post is rate limiting requests. Try again shortly.");
    default:
      return new ApiHttpError(502, ERROR_CODES.INTERNAL_ERROR, "Upload-Post is unreachable or failed. Try again shortly.");
  }
}

// ------------------------------------------------------------------------------ integration --

async function integrationOrganization(): Promise<ReturnType<typeof resolveIntegrationOrganization>> {
  const orgs = await prisma.organization.findMany({ where: { status: "ACTIVE" }, select: { id: true }, take: 3 });
  return resolveIntegrationOrganization(orgs.map((o) => o.id), loadEnv().UPLOAD_POST_ORGANIZATION_ID);
}

export type ProviderStatus = "CONNECTED" | "DISCONNECTED" | "SYNC_PENDING" | "SYNC_FAILED" | "LIMIT_REACHED";

/**
 * One headline status for the integration:
 *   DISCONNECTED  not configured, key rejected, provider unreachable, or this organization does not own the key
 *   SYNC_FAILED   the latest synchronization failed
 *   LIMIT_REACHED the plan's profile limit is used up
 *   SYNC_PENDING  configured but never synchronized successfully (or a sync is running)
 *   CONNECTED     everything above is fine
 */
export function deriveProviderStatus(input: {
  configured: boolean;
  organizationOwnsKey: boolean;
  probeOk: boolean | null;
  lastRun: { status: string } | null;
  lastSuccess: unknown;
  profileLimit: number | null;
  activeProfiles: number;
}): ProviderStatus {
  if (!input.configured || !input.organizationOwnsKey || input.probeOk === false) return "DISCONNECTED";
  if (input.lastRun?.status === "FAILED") return "SYNC_FAILED";
  if (input.profileLimit !== null && input.activeProfiles >= input.profileLimit) return "LIMIT_REACHED";
  if (!input.lastSuccess || input.lastRun?.status === "RUNNING") return "SYNC_PENDING";
  return "CONNECTED";
}

async function integrationContext(actor: SafeUser) {
  const env = loadEnv();
  const owner = await integrationOrganization();
  const organizationOwnsKey = owner.ok && owner.organizationId === actor.organizationId;
  return {
    configured: Boolean(env.UPLOAD_POST_API_KEY),
    organizationOwnsKey,
    organizationIssue: owner.ok ? (organizationOwnsKey ? null : "The Upload-Post key belongs to a different organization of this deployment.") : INTEGRATION_ORGANIZATION_MESSAGES[owner.reason],
    handoff: { enabled: env.UPLOAD_POST_SCHEDULE_HANDOFF_ENABLED, windowHours: env.UPLOAD_POST_SCHEDULE_HANDOFF_WINDOW_HOURS },
    syncIntervalMinutes: env.UPLOAD_POST_SYNC_INTERVAL_MINUTES,
    webhookConfigured: Boolean(env.UPLOAD_POST_WEBHOOK_SECRET),
  };
}

/** Public-safe projection of a probe: never contains the key; the account e-mail is shown to admins only. */
function publicProbe(probe: HealthProbe, actor: SafeUser) {
  if (!probe.configured) return { configured: false as const };
  if (!probe.ok) return { configured: true as const, ok: false as const, latencyMs: probe.latencyMs, checkedAt: probe.checkedAt, errorKind: probe.errorKind, message: probe.message, retryAfterMs: probe.retryAfterMs };
  const admin = actor.role === "ADMIN" || actor.role === "OWNER";
  return {
    configured: true as const,
    ok: true as const,
    latencyMs: probe.latencyMs,
    checkedAt: probe.checkedAt,
    account: { plan: probe.account.plan, email: admin ? probe.account.email : null, analyzeShorts: probe.account.analyzeShorts },
  };
}

export async function getHealth(actor: SafeUser, force = false) {
  const ctx = await integrationContext(actor);
  const probe = await probeProvider(force);
  return { ...ctx, provider: publicProbe(probe, actor) };
}

export async function getOverview(actor: SafeUser) {
  const orgId = actor.organizationId;
  const ctx = await integrationContext(actor);
  const probe = await probeProvider(false);

  const [profilesActive, profilesRemoved, accountsByStatus, accountsByPlatform, destinations, unmappedProfiles, unmappedAccounts, pubsByStatus, lastRun, lastSuccess, managedPages, creators] =
    await Promise.all([
      prisma.uploadPostProfile.count({ where: { organizationId: orgId, status: "ACTIVE" } }),
      prisma.uploadPostProfile.count({ where: { organizationId: orgId, status: "REMOVED" } }),
      prisma.uploadPostConnectedAccount.groupBy({ by: ["status"], where: { organizationId: orgId }, _count: { _all: true } }),
      prisma.uploadPostConnectedAccount.groupBy({ by: ["platform"], where: { organizationId: orgId, status: { not: "DISCONNECTED" } }, _count: { _all: true } }),
      prisma.uploadPostConnectedAccount.count({ where: { organizationId: orgId, socialAccountId: { not: null } } }),
      prisma.uploadPostProfile.count({ where: { organizationId: orgId, status: "ACTIVE", managedPageId: null } }),
      prisma.uploadPostConnectedAccount.count({ where: { organizationId: orgId, status: { not: "DISCONNECTED" }, creatorId: null } }),
      prisma.uploadPostPublication.groupBy({ by: ["status"], where: { organizationId: orgId }, _count: { _all: true } }),
      prisma.uploadPostSyncRun.findFirst({ where: { organizationId: orgId }, orderBy: { startedAt: "desc" } }),
      prisma.uploadPostSyncRun.findFirst({ where: { organizationId: orgId, status: "SUCCEEDED" }, orderBy: { startedAt: "desc" } }),
      prisma.managedPage.count({ where: { organizationId: orgId, status: "ACTIVE" } }),
      prisma.creator.count({ where: { organizationId: orgId, status: "ACTIVE" } }),
    ]);

  const status = deriveProviderStatus({
    configured: ctx.configured,
    organizationOwnsKey: ctx.organizationOwnsKey,
    probeOk: probe.configured ? probe.ok : null,
    lastRun,
    lastSuccess,
    profileLimit: lastSuccess?.profileLimit ?? null,
    activeProfiles: profilesActive,
  });

  const toMap = (rows: ({ _count: { _all: number } } & Record<string, unknown>)[], key: string): Record<string, number> =>
    Object.fromEntries(rows.map((r) => [String(r[key]), r._count._all]));
  return {
    status,
    ...ctx,
    provider: publicProbe(probe, actor),
    profiles: { active: profilesActive, removed: profilesRemoved, unmapped: unmappedProfiles, limit: lastSuccess?.profileLimit ?? null },
    accounts: { byStatus: toMap(accountsByStatus, "status"), byPlatform: toMap(accountsByPlatform, "platform"), unmapped: unmappedAccounts, destinations },
    publications: toMap(pubsByStatus, "status"),
    mapping: { managedPages, creators },
    lastSync: lastRun
      ? { id: lastRun.id, status: lastRun.status, trigger: lastRun.trigger, startedAt: lastRun.startedAt, finishedAt: lastRun.finishedAt, errorKind: lastRun.errorKind, errorMessage: lastRun.errorMessage }
      : null,
    lastSuccessfulSyncAt: lastSuccess?.finishedAt ?? null,
  };
}

export async function getPlan(actor: SafeUser) {
  const orgId = actor.organizationId;
  const probe = await probeProvider(false);
  const [lastSuccess, active, recentRuns] = await Promise.all([
    prisma.uploadPostSyncRun.findFirst({ where: { organizationId: orgId, status: "SUCCEEDED" }, orderBy: { startedAt: "desc" } }),
    prisma.uploadPostProfile.count({ where: { organizationId: orgId, status: "ACTIVE" } }),
    prisma.uploadPostSyncRun.findMany({ where: { organizationId: orgId }, orderBy: { startedAt: "desc" }, take: 10 }),
  ]);
  const limit = lastSuccess?.profileLimit ?? null;
  const pub = publicProbe(probe, actor);
  return {
    // Reported by the provider; this application never assumes a number.
    plan: (pub.configured && pub.ok ? pub.account.plan : null) ?? lastSuccess?.plan ?? null,
    profileLimit: limit,
    profilesUsed: active,
    profilesRemaining: limit === null ? null : Math.max(0, limit - active),
    limitReached: limit !== null && active >= limit,
    analyzeShorts: pub.configured && pub.ok ? pub.account.analyzeShorts : null,
    source: pub.configured && pub.ok ? "live" : lastSuccess ? "last-sync" : "none",
    lastSyncedAt: lastSuccess?.finishedAt ?? null,
    recentSyncRuns: recentRuns.map((r) => ({ id: r.id, status: r.status, trigger: r.trigger, startedAt: r.startedAt, finishedAt: r.finishedAt, profilesSeen: r.profilesSeen, accountsSeen: r.accountsSeen, errorKind: r.errorKind, errorMessage: r.errorMessage })),
  };
}

export async function requestSync(actor: SafeUser) {
  const ctx = await integrationContext(actor);
  if (!ctx.configured) throw toApiError(new UploadPostError({ kind: "NOT_CONFIGURED", message: "not configured", retryable: false }));
  if (!ctx.organizationOwnsKey) throw new ApiHttpError(409, ERROR_CODES.CONFIGURATION_ERROR, ctx.organizationIssue ?? "This organization does not own the Upload-Post key.");
  const queued = await enqueueUploadPostSync(actor.organizationId);
  if (queued === "NO_QUEUE") throw new ApiHttpError(503, ERROR_CODES.CONFIGURATION_ERROR, "Background processing (Redis/worker) is not available in this deployment.");
  await createAuditLog({ organizationId: actor.organizationId, userId: actor.id, action: "UPLOAD_POST_SYNC_REQUESTED", metadata: { result: queued } });
  return { queued: queued === "QUEUED", alreadyQueued: queued === "ALREADY_QUEUED" };
}

// ------------------------------------------------------------------------------------ listing --

const accountInclude = {
  creator: { select: { id: true, name: true, status: true } },
  profile: { select: { id: true, username: true, displayName: true, status: true } },
  socialAccount: { select: { id: true, status: true, publishingProvider: true } },
} satisfies Prisma.UploadPostConnectedAccountInclude;

export async function listProfiles(actor: SafeUser, q: { page: number; pageSize: number; search?: string; status?: "ACTIVE" | "REMOVED"; mapped?: "true" | "false"; managedPageId?: string }) {
  const where: Prisma.UploadPostProfileWhereInput = {
    organizationId: actor.organizationId,
    ...(q.status ? { status: q.status } : {}),
    ...(q.managedPageId ? { managedPageId: q.managedPageId } : {}),
    ...(q.mapped === "true" ? { managedPageId: { not: null } } : q.mapped === "false" ? { managedPageId: null } : {}),
    ...(q.search
      ? {
          OR: [
            { username: { contains: q.search } },
            { displayName: { contains: q.search } },
            { accounts: { some: { OR: [{ handle: { contains: q.search } }, { displayName: { contains: q.search } }] } } },
          ],
        }
      : {}),
  };
  const [total, items] = await Promise.all([
    prisma.uploadPostProfile.count({ where }),
    prisma.uploadPostProfile.findMany({
      where,
      orderBy: [{ status: "asc" }, { username: "asc" }],
      ...skipTake(q),
      include: { managedPage: { select: { id: true, name: true, slug: true } }, accounts: { include: accountInclude, orderBy: { platform: "asc" } } },
    }),
  ]);
  return { items, total, page: q.page, pageSize: q.pageSize };
}

export async function listAccounts(
  actor: SafeUser,
  q: { page: number; pageSize: number; search?: string; platform?: string; status?: "CONNECTED" | "REAUTH_REQUIRED" | "DISCONNECTED"; mapped?: "true" | "false"; destination?: "true" | "false"; profileId?: string; creatorId?: string },
) {
  const where: Prisma.UploadPostConnectedAccountWhereInput = {
    organizationId: actor.organizationId,
    ...(q.platform ? { platform: q.platform } : {}),
    ...(q.status ? { status: q.status } : {}),
    ...(q.profileId ? { profileId: q.profileId } : {}),
    ...(q.creatorId ? { creatorId: q.creatorId } : {}),
    ...(q.mapped === "true" ? { creatorId: { not: null } } : q.mapped === "false" ? { creatorId: null } : {}),
    ...(q.destination === "true" ? { socialAccountId: { not: null } } : q.destination === "false" ? { socialAccountId: null } : {}),
    ...(q.search ? { OR: [{ handle: { contains: q.search } }, { displayName: { contains: q.search } }, { providerAccountId: { contains: q.search } }, { profile: { username: { contains: q.search } } }] } : {}),
  };
  const [total, items] = await Promise.all([
    prisma.uploadPostConnectedAccount.count({ where }),
    prisma.uploadPostConnectedAccount.findMany({ where, orderBy: [{ platform: "asc" }, { handle: "asc" }], ...skipTake(q), include: accountInclude }),
  ]);
  // The same real account connected in several profiles is surfaced, not hidden (it can make a destination ambiguous).
  const sharedIds = items.length
    ? await prisma.uploadPostConnectedAccount.groupBy({
        by: ["platform", "providerAccountId"],
        where: { organizationId: actor.organizationId, status: { not: "DISCONNECTED" }, providerAccountId: { in: items.map((i) => i.providerAccountId) } },
        _count: { _all: true },
        having: { providerAccountId: { _count: { gt: 1 } } },
      })
    : [];
  const shared = new Set(sharedIds.map((s) => `${s.platform}:${s.providerAccountId}`));
  return {
    items: items.map((a) => ({ ...a, sharedAcrossProfiles: shared.has(`${a.platform}:${a.providerAccountId}`), publishable: (PUBLISHABLE_PLATFORMS as readonly string[]).includes(a.platform) })),
    total,
    page: q.page,
    pageSize: q.pageSize,
  };
}

export async function listPublications(actor: SafeUser, q: { page: number; pageSize: number; status?: string }) {
  const where = { organizationId: actor.organizationId, ...(q.status ? { status: q.status as never } : {}) };
  const [total, items] = await Promise.all([
    prisma.uploadPostPublication.count({ where }),
    prisma.uploadPostPublication.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      ...skipTake(q),
      include: { contentTarget: { select: { id: true, status: true, content: { select: { id: true, caption: true, scheduledAt: true } }, socialAccount: { select: { id: true, handle: true, platform: true } } } } },
    }),
  ]);
  return { items: items.map(({ lastProviderResult: _omit, idempotencyKey: _k, ...rest }) => rest), total, page: q.page, pageSize: q.pageSize };
}

export async function listScheduled(actor: SafeUser, q: { page: number; pageSize: number }) {
  const where: Prisma.UploadPostPublicationWhereInput = { organizationId: actor.organizationId, mode: "PROVIDER_SCHEDULED", status: { in: ["SCHEDULED_AT_PROVIDER", "PENDING", "UNKNOWN_OUTCOME"] } };
  const [total, items] = await Promise.all([
    prisma.uploadPostPublication.count({ where }),
    prisma.uploadPostPublication.findMany({
      where,
      orderBy: { scheduledFor: "asc" },
      ...skipTake(q),
      select: {
        id: true, status: true, platform: true, profileUsername: true, scheduledFor: true, handedOffAt: true, providerJobId: true, externalId: true, generation: true, lastErrorKind: true, lastErrorMessage: true, notes: true,
        contentTarget: { select: { id: true, content: { select: { id: true, caption: true } }, socialAccount: { select: { handle: true } } } },
      },
    }),
  ]);
  return { items, total, page: q.page, pageSize: q.pageSize };
}

// ----------------------------------------------------------------------------------- mapping --

export async function setProfileMapping(actor: SafeUser, profileId: string, managedPageId: string | null) {
  const profile = await prisma.uploadPostProfile.findFirst({ where: { id: profileId, organizationId: actor.organizationId } });
  if (!profile) throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, "Profile not found.");
  if (managedPageId) {
    const page = await prisma.managedPage.findFirst({ where: { id: managedPageId, organizationId: actor.organizationId } });
    if (!page) throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, "Page not found.");
    if (page.status === "ARCHIVED") throw new ApiHttpError(409, ERROR_CODES.CONFLICT, "That page is archived.");
  }
  const updated = await prisma.uploadPostProfile.update({ where: { id: profile.id }, data: { managedPageId }, include: { managedPage: { select: { id: true, name: true, slug: true } } } });
  await createAuditLog({ organizationId: actor.organizationId, userId: actor.id, action: "UPLOAD_POST_MAPPING_CHANGED", targetType: "UploadPostProfile", targetId: profile.id, metadata: { from: profile.managedPageId, to: managedPageId } });
  return updated;
}

export async function setAccountMapping(actor: SafeUser, accountId: string, creatorId: string | null) {
  const account = await prisma.uploadPostConnectedAccount.findFirst({ where: { id: accountId, organizationId: actor.organizationId } });
  if (!account) throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, "Account not found.");
  if (creatorId) {
    const creator = await prisma.creator.findFirst({ where: { id: creatorId, organizationId: actor.organizationId } });
    if (!creator) throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, "Creator not found.");
    if (creator.status === "ARCHIVED") throw new ApiHttpError(409, ERROR_CODES.CONFLICT, "That creator is archived.");
    if (!(PUBLISHABLE_PLATFORMS as readonly string[]).includes(account.platform)) {
      throw new ApiHttpError(409, ERROR_CODES.CONFLICT, `Socialith cannot assign ${account.platform} accounts to creators yet (supported: ${PUBLISHABLE_PLATFORMS.join(", ")}).`);
    }
  }
  const updated = await prisma.uploadPostConnectedAccount.update({ where: { id: account.id }, data: { creatorId }, include: accountInclude });
  await createAuditLog({ organizationId: actor.organizationId, userId: actor.id, action: "UPLOAD_POST_MAPPING_CHANGED", targetType: "UploadPostConnectedAccount", targetId: account.id, metadata: { from: account.creatorId, to: creatorId, platform: account.platform } });
  return updated;
}

// ------------------------------------------------------------------ publishing destination --

export async function enableDestination(actor: SafeUser, accountId: string) {
  const account = await prisma.uploadPostConnectedAccount.findFirst({ where: { id: accountId, organizationId: actor.organizationId }, include: { profile: true } });
  if (!account) throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, "Account not found.");
  if (!(PUBLISHABLE_PLATFORMS as readonly string[]).includes(account.platform)) {
    throw new ApiHttpError(409, ERROR_CODES.CONFLICT, `Socialith cannot publish to ${account.platform} yet (supported: ${PUBLISHABLE_PLATFORMS.join(", ")}).`);
  }
  if (account.profile.status !== "ACTIVE") throw new ApiHttpError(409, ERROR_CODES.CONFLICT, "The Upload-Post profile no longer exists at the provider.");
  if (account.status !== "CONNECTED") {
    throw new ApiHttpError(409, ERROR_CODES.REAUTH_REQUIRED, account.status === "REAUTH_REQUIRED" ? "Reconnect this account in Upload-Post first (authorization expired)." : "This account is disconnected in Upload-Post.");
  }
  if (account.socialAccountId) {
    return prisma.uploadPostConnectedAccount.findUniqueOrThrow({ where: { id: account.id }, include: accountInclude }); // idempotent
  }

  const platform = account.platform.toUpperCase() as "TIKTOK" | "INSTAGRAM" | "YOUTUBE";
  const existing = await prisma.socialAccount.findUnique({
    where: { organizationId_platform_externalAccountId: { organizationId: actor.organizationId, platform, externalAccountId: account.providerAccountId } },
    include: { uploadPostAccount: { select: { id: true, profile: { select: { username: true } } } } },
  });
  if (existing && existing.publishingProvider === "NATIVE") {
    throw new ApiHttpError(409, ERROR_CODES.CONFLICT, "This account is already connected natively. Socialith will not silently switch its publishing route; disconnect the native connection first if you want Upload-Post to publish for it.");
  }
  if (existing?.uploadPostAccount && existing.uploadPostAccount.id !== account.id) {
    throw new ApiHttpError(409, ERROR_CODES.CONFLICT, `This account is already a publishing destination through the Upload-Post profile "${existing.uploadPostAccount.profile.username}".`);
  }

  try {
    await prisma.$transaction(async (tx) => {
      const social = existing
        ? await tx.socialAccount.update({ where: { id: existing.id }, data: { status: "CONNECTED", lastErrorMessage: null, handle: account.handle ?? existing.handle, displayName: account.displayName ?? existing.displayName, avatarUrl: account.avatarUrl ?? existing.avatarUrl } })
        : await tx.socialAccount.create({
            data: {
              organizationId: actor.organizationId,
              platform,
              externalAccountId: account.providerAccountId,
              handle: account.handle ?? account.providerAccountId,
              displayName: account.displayName ?? account.handle ?? account.providerAccountId,
              avatarUrl: account.avatarUrl,
              status: "CONNECTED",
              publishingProvider: "UPLOAD_POST",
              connectedById: actor.id,
              providerMetadata: { provider: "upload-post", profileUsername: account.profile.username },
            },
          });
      await tx.uploadPostConnectedAccount.update({ where: { id: account.id }, data: { socialAccountId: social.id } });
    });
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") throw new ApiHttpError(409, ERROR_CODES.CONFLICT, "This account was just enabled by someone else.");
    throw err;
  }
  await createAuditLog({ organizationId: actor.organizationId, userId: actor.id, action: "UPLOAD_POST_DESTINATION_ENABLED", targetType: "UploadPostConnectedAccount", targetId: account.id, metadata: { platform: account.platform, profile: account.profile.username } });
  return prisma.uploadPostConnectedAccount.findUniqueOrThrow({ where: { id: account.id }, include: accountInclude });
}

export async function disableDestination(actor: SafeUser, accountId: string) {
  const account = await prisma.uploadPostConnectedAccount.findFirst({ where: { id: accountId, organizationId: actor.organizationId } });
  if (!account) throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, "Account not found.");
  if (!account.socialAccountId) return prisma.uploadPostConnectedAccount.findUniqueOrThrow({ where: { id: account.id }, include: accountInclude });

  const open = await prisma.contentTarget.count({ where: { socialAccountId: account.socialAccountId, status: { in: ["PENDING", "SCHEDULED", "PUBLISHING"] } } });
  if (open > 0) {
    throw new ApiHttpError(409, ERROR_CODES.CONFLICT, `${open} publication target(s) are still pending for this destination. Finish, cancel or remove them first.`);
  }
  await prisma.$transaction([
    prisma.uploadPostConnectedAccount.update({ where: { id: account.id }, data: { socialAccountId: null } }),
    // history stays attached to the SocialAccount, which is kept (disconnected), never deleted
    prisma.socialAccount.update({ where: { id: account.socialAccountId }, data: { status: "DISCONNECTED", lastErrorMessage: "Publishing through Upload-Post was disabled." } }),
  ]);
  await createAuditLog({ organizationId: actor.organizationId, userId: actor.id, action: "UPLOAD_POST_DESTINATION_DISABLED", targetType: "UploadPostConnectedAccount", targetId: account.id, metadata: { platform: account.platform } });
  return prisma.uploadPostConnectedAccount.findUniqueOrThrow({ where: { id: account.id }, include: accountInclude });
}

// ------------------------------------------------------------------- managed pages & creators --

function slugify(value: string): string {
  return value.toLowerCase().replace(/ı/g, "i").normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/g, "");
}

function conflictOrRethrow(err: unknown, message: string): never {
  if ((err as { code?: string }).code === "P2002") throw new ApiHttpError(409, ERROR_CODES.CONFLICT, message);
  throw err;
}

export async function listManagedPages(actor: SafeUser, includeArchived: boolean) {
  return prisma.managedPage.findMany({
    where: { organizationId: actor.organizationId, ...(includeArchived ? {} : { status: "ACTIVE" }) },
    orderBy: { name: "asc" },
    include: { _count: { select: { uploadPostProfiles: true } } },
  });
}
export async function createManagedPage(actor: SafeUser, input: { name: string; slug?: string; description?: string | null }) {
  const slug = input.slug ?? slugify(input.name);
  if (slug.length < 2) throw new ApiHttpError(400, ERROR_CODES.INVALID_REQUEST, "Could not derive a slug from the name; provide one.");
  try {
    const page = await prisma.managedPage.create({ data: { organizationId: actor.organizationId, name: input.name, slug, description: input.description ?? null } });
    await createAuditLog({ organizationId: actor.organizationId, userId: actor.id, action: "MANAGED_PAGE_CREATED", targetType: "ManagedPage", targetId: page.id });
    return page;
  } catch (err) {
    return conflictOrRethrow(err, "A page with that slug already exists.");
  }
}
export async function updateManagedPage(actor: SafeUser, id: string, input: { name?: string; description?: string | null; status?: "ACTIVE" | "ARCHIVED" }) {
  const page = await prisma.managedPage.findFirst({ where: { id, organizationId: actor.organizationId } });
  if (!page) throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, "Page not found.");
  const updated = await prisma.managedPage.update({ where: { id }, data: input });
  await createAuditLog({ organizationId: actor.organizationId, userId: actor.id, action: "MANAGED_PAGE_UPDATED", targetType: "ManagedPage", targetId: id, metadata: { fields: Object.keys(input) } });
  return updated;
}

export async function listCreators(actor: SafeUser, includeArchived: boolean) {
  return prisma.creator.findMany({
    where: { organizationId: actor.organizationId, ...(includeArchived ? {} : { status: "ACTIVE" }) },
    orderBy: { name: "asc" },
    include: { _count: { select: { uploadPostAccounts: true } } },
  });
}
export async function createCreator(actor: SafeUser, input: { name: string; notes?: string | null }) {
  try {
    const creator = await prisma.creator.create({ data: { organizationId: actor.organizationId, name: input.name, notes: input.notes ?? null } });
    await createAuditLog({ organizationId: actor.organizationId, userId: actor.id, action: "CREATOR_CREATED", targetType: "Creator", targetId: creator.id });
    return creator;
  } catch (err) {
    return conflictOrRethrow(err, "A creator with that name already exists.");
  }
}
export async function updateCreator(actor: SafeUser, id: string, input: { name?: string; notes?: string | null; status?: "ACTIVE" | "ARCHIVED" }) {
  const creator = await prisma.creator.findFirst({ where: { id, organizationId: actor.organizationId } });
  if (!creator) throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, "Creator not found.");
  try {
    const updated = await prisma.creator.update({ where: { id }, data: input });
    await createAuditLog({ organizationId: actor.organizationId, userId: actor.id, action: "CREATOR_UPDATED", targetType: "Creator", targetId: id, metadata: { fields: Object.keys(input) } });
    return updated;
  } catch (err) {
    return conflictOrRethrow(err, "A creator with that name already exists.");
  }
}

// ------------------------------------------------------------------------------- TikTok music --

/** The TikTok account of a profile, only if it can actually serve music lookups. */
async function musicCapableProfile(actor: SafeUser, profileId: string): Promise<{ username: string }> {
  const profile = await prisma.uploadPostProfile.findFirst({
    where: { id: profileId, organizationId: actor.organizationId },
    include: { accounts: { where: { platform: "tiktok" } } },
  });
  if (!profile) throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, "Profile not found.");
  const tiktok = profile.accounts[0];
  if (!tiktok || tiktok.status === "DISCONNECTED") throw new ApiHttpError(409, ERROR_CODES.CONFLICT, "This profile has no connected TikTok account.");
  if (tiktok.status === "REAUTH_REQUIRED") throw new ApiHttpError(409, ERROR_CODES.REAUTH_REQUIRED, "Reconnect the TikTok account in Upload-Post first.");
  const capabilities = Array.isArray(tiktok.capabilities) ? tiktok.capabilities : [];
  if (!capabilities.includes("music")) {
    throw new ApiHttpError(409, ERROR_CODES.REAUTH_REQUIRED, "This TikTok connection does not offer the 'music' capability. Reconnect the account in Upload-Post to enable it. Music fields are only offered for accounts that report it.");
  }
  return { username: profile.username };
}

const MUSIC_DISCLAIMER =
  "Chart data from TikTok's Commercial Music Library as cached by Upload-Post. It is NOT the whole TikTok catalogue: a track missing here may still exist on TikTok, and a track present here still needs its rights confirmed for your use.";

export async function searchMusic(actor: SafeUser, q: { profileId: string; q?: string; genre?: string; countryCode?: string; dateRange?: string }) {
  const { username } = await musicCapableProfile(actor, q.profileId);
  const client = getUploadPostClient();
  if (!client) throw toApiError(new UploadPostError({ kind: "NOT_CONFIGURED", message: "not configured", retryable: false }));
  try {
    const result: TikTokMusicResult = q.q
      ? await client.searchTikTokMusic({ profile: username, query: q.q, genre: q.genre, countryCode: q.countryCode, dateRange: q.dateRange })
      : await client.trendingTikTokMusic({ profile: username, genre: q.genre, countryCode: q.countryCode, dateRange: q.dateRange });
    return { ...result, notice: MUSIC_DISCLAIMER };
  } catch (err) {
    throw toApiError(err);
  }
}

async function loadSound(actor: SafeUser, soundId: string) {
  const sound = await prisma.sound.findFirst({ where: { id: soundId, organizationId: actor.organizationId } });
  if (!sound) throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, "Track not found.");
  return sound;
}
async function loadMapping(actor: SafeUser, id: string) {
  const mapping = await prisma.soundMusicMapping.findFirst({ where: { id, organizationId: actor.organizationId } });
  if (!mapping) throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, "Music mapping not found.");
  return mapping;
}

export async function listMusicMappings(actor: SafeUser, soundId: string) {
  await loadSound(actor, soundId);
  return prisma.soundMusicMapping.findMany({ where: { organizationId: actor.organizationId, soundId }, orderBy: { updatedAt: "desc" } });
}

export async function createMusicMapping(actor: SafeUser, soundId: string, input: { providerMusicId: string; commercialMusicId?: string | null; providerTitle: string; providerArtist?: string | null; durationSec?: number | null; previewUrl?: string | null; coverUrl?: string | null }) {
  await loadSound(actor, soundId);
  try {
    const mapping = await prisma.soundMusicMapping.create({
      data: {
        organizationId: actor.organizationId,
        soundId,
        providerMusicId: input.providerMusicId,
        commercialMusicId: input.commercialMusicId ?? null,
        providerTitle: input.providerTitle,
        providerArtist: input.providerArtist ?? null,
        durationSec: input.durationSec ?? null,
        previewUrl: input.previewUrl ?? null,
        coverUrl: input.coverUrl ?? null,
        availability: "UNVERIFIED", // never assumed usable merely because it was picked
        createdById: actor.id,
      },
    });
    await createAuditLog({ organizationId: actor.organizationId, userId: actor.id, action: "MUSIC_MAPPING_CREATED", targetType: "SoundMusicMapping", targetId: mapping.id, metadata: { soundId, providerMusicId: input.providerMusicId } });
    return mapping;
  } catch (err) {
    return conflictOrRethrow(err, "This track is already mapped to that TikTok music id.");
  }
}

/** Re-checks availability against the provider's chart data using a profile that has the music capability. */
export async function verifyMusicMapping(actor: SafeUser, id: string, profileId: string) {
  const mapping = await loadMapping(actor, id);
  const { username } = await musicCapableProfile(actor, profileId);
  const client = getUploadPostClient();
  if (!client) throw toApiError(new UploadPostError({ kind: "NOT_CONFIGURED", message: "not configured", retryable: false }));
  let found = false;
  try {
    const bySearch = await client.searchTikTokMusic({ profile: username, query: mapping.providerTitle, limit: 100 });
    found = bySearch.tracks.some((t) => t.id === mapping.providerMusicId);
    if (!found) {
      const trending = await client.trendingTikTokMusic({ profile: username });
      found = trending.tracks.some((t) => t.id === mapping.providerMusicId);
    }
  } catch (err) {
    throw toApiError(err);
  }
  const updated = await prisma.soundMusicMapping.update({
    where: { id: mapping.id },
    data: { availability: found ? "VERIFIED_AVAILABLE" : "UNAVAILABLE", verifiedAt: new Date(), verifiedWithProfile: username },
  });
  await createAuditLog({ organizationId: actor.organizationId, userId: actor.id, action: "MUSIC_MAPPING_VERIFIED", targetType: "SoundMusicMapping", targetId: mapping.id, metadata: { available: found } });
  return { mapping: updated, notice: MUSIC_DISCLAIMER };
}

export async function setMusicRights(actor: SafeUser, id: string, input: { confirmed: boolean; note?: string | null }) {
  const mapping = await loadMapping(actor, id);
  const updated = await prisma.soundMusicMapping.update({
    where: { id: mapping.id },
    data: input.confirmed
      ? { rightsConfirmed: true, rightsConfirmedAt: new Date(), rightsConfirmedById: actor.id, rightsNote: input.note ?? null }
      : { rightsConfirmed: false, rightsConfirmedAt: null, rightsConfirmedById: null, rightsNote: input.note ?? null },
  });
  await createAuditLog({ organizationId: actor.organizationId, userId: actor.id, action: "MUSIC_MAPPING_RIGHTS_CHANGED", targetType: "SoundMusicMapping", targetId: mapping.id, metadata: { confirmed: input.confirmed } });
  return updated;
}

export async function deleteMusicMapping(actor: SafeUser, id: string) {
  const mapping = await loadMapping(actor, id);
  await prisma.soundMusicMapping.delete({ where: { id: mapping.id } });
  await createAuditLog({ organizationId: actor.organizationId, userId: actor.id, action: "MUSIC_MAPPING_DELETED", targetType: "SoundMusicMapping", targetId: mapping.id });
}
