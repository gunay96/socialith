import { prisma } from "@socialith/database";
import type { Prisma } from "@socialith/database";
import { ERROR_CODES } from "@socialith/types";
import { PUBLICATION_STATES, validateDestination, zonedDayKey, zonedDayRange, type PlatformKey, type PublicationState } from "@socialith/publishing";
import { ApiHttpError } from "../middleware/error-handler.js";
import type { SafeUser } from "../types/auth.js";
import { PUBLICATION_INCLUDE, getEffectiveSettings, stateOf, toPublicationDto, effectiveTextOf, isProviderOwned } from "./publishing-common.js";
import { assetFacts, validatePublicationTarget } from "./publishing-validation.service.js";

// ------------------------------------------------------------------------------------------------ filters

export interface PublicationFilters {
  states?: PublicationState[];
  platform?: "TIKTOK" | "INSTAGRAM" | "YOUTUBE";
  campaignId?: string;
  contentId?: string;
  destinationId?: string;
  creatorId?: string;
  managedPageId?: string;
  /** free text, matched against Sound.artist (there is no Artist entity until Phase 7) */
  artist?: string;
  search?: string;
  from?: Date;
  to?: Date;
  dateField?: "scheduledAt" | "publishedAt" | "createdAt";
  owner?: "SOCIALITH" | "PROVIDER";
}

const PENDING = { status: "PENDING" as const };
const PROVIDER_OWNED: Prisma.ContentTargetWhereInput = {
  uploadPostPublication: { is: { mode: "PROVIDER_SCHEDULED", status: { in: ["PENDING", "UNKNOWN_OUTCOME", "SCHEDULED_AT_PROVIDER"] } } },
};

/**
 * The stored-column condition behind each derived state. It mirrors derivePublicationState() exactly (an integration
 * test checks that listing by a state returns precisely the publications that derive to it).
 */
export function stateWhere(state: PublicationState): Prisma.ContentTargetWhereInput {
  switch (state) {
    case "DRAFT":
      return { ...PENDING, approvalStatus: "DRAFT", exception: null };
    case "READY_FOR_REVIEW":
      return { ...PENDING, approvalStatus: "READY_FOR_REVIEW", exception: null };
    case "APPROVED":
      return { ...PENDING, approvalStatus: "APPROVED", exception: null };
    case "REJECTED":
      return { ...PENDING, approvalStatus: "REJECTED", exception: null };
    case "HELD":
      return { ...PENDING, exception: "HELD" };
    case "CANCELLED":
      return { ...PENDING, exception: "CANCELLED" };
    case "SCHEDULED":
      return { status: "SCHEDULED" };
    case "QUEUED":
      return { status: "PUBLISHING", attemptCount: 0, uploadPostPublication: { is: null } };
    case "PUBLISHING":
      return { status: "PUBLISHING", OR: [{ attemptCount: { gt: 0 } }, { uploadPostPublication: { isNot: null } }] };
    case "PUBLISHED":
      return { status: "PUBLISHED" };
    case "FAILED":
      return { status: "FAILED", OR: [{ exception: null }, { exception: { in: ["HELD", "CANCELLED"] } }] };
    case "STALE":
      return { status: "FAILED", exception: "STALE" };
  }
}

export function filterWhere(organizationId: string, f: PublicationFilters): Prisma.ContentTargetWhereInput {
  const and: Prisma.ContentTargetWhereInput[] = [{ content: { organizationId } }];
  if (f.platform) and.push({ socialAccount: { platform: f.platform } });
  if (f.campaignId) and.push({ content: { campaignId: f.campaignId } });
  if (f.contentId) and.push({ contentId: f.contentId });
  if (f.destinationId) and.push({ socialAccountId: f.destinationId });
  if (f.creatorId) and.push({ socialAccount: { uploadPostAccount: { is: { creatorId: f.creatorId } } } });
  if (f.managedPageId) and.push({ socialAccount: { uploadPostAccount: { is: { profile: { managedPageId: f.managedPageId } } } } });
  if (f.artist) and.push({ content: { sound: { is: { artist: { contains: f.artist } } } } });
  if (f.search) and.push({ OR: [{ socialAccount: { handle: { contains: f.search } } }, { socialAccount: { displayName: { contains: f.search } } }, { content: { caption: { contains: f.search } } }, { captionOverride: { contains: f.search } }] });
  if (f.from || f.to) and.push({ [f.dateField ?? "scheduledAt"]: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lt: f.to } : {}) } });
  if (f.owner === "PROVIDER") and.push({ status: "SCHEDULED", ...PROVIDER_OWNED });
  if (f.owner === "SOCIALITH") and.push({ status: "SCHEDULED", NOT: PROVIDER_OWNED });
  if (f.states?.length) and.push({ OR: f.states.map(stateWhere) });
  return { AND: and };
}

// ------------------------------------------------------------------------------------------------ lists

export async function listPublications(actor: SafeUser, f: PublicationFilters & { page: number; pageSize: number; sort?: "scheduledAt_asc" | "scheduledAt_desc" | "updatedAt_desc" }) {
  const settings = await getEffectiveSettings(actor.organizationId);
  const where = filterWhere(actor.organizationId, f);
  const orderBy: Prisma.ContentTargetOrderByWithRelationInput[] =
    f.sort === "scheduledAt_asc" ? [{ scheduledAt: { sort: "asc", nulls: "last" } }, { id: "asc" }] : f.sort === "scheduledAt_desc" ? [{ scheduledAt: { sort: "desc", nulls: "last" } }, { id: "asc" }] : [{ updatedAt: "desc" }, { id: "asc" }];
  const [total, rows] = await Promise.all([
    prisma.contentTarget.count({ where }),
    prisma.contentTarget.findMany({ where, include: PUBLICATION_INCLUDE, orderBy, skip: (f.page - 1) * f.pageSize, take: f.pageSize }),
  ]);
  return { items: rows.map((t) => toPublicationDto(t, settings.requireApproval)), total, page: f.page, pageSize: f.pageSize, timezone: settings.timezone };
}

/** Calendar feed: lean items for a UTC range (a month view of an agency can be large — capped, and says so). */
export async function getCalendar(actor: SafeUser, f: PublicationFilters & { from: Date; to: Date }) {
  const settings = await getEffectiveSettings(actor.organizationId);
  const CAP = 1500;
  const where = filterWhere(actor.organizationId, { ...f, dateField: "scheduledAt" });
  const rows = await prisma.contentTarget.findMany({
    // cancelled publications are not on the calendar (explicit null handling: NOT (exception = 'X') drops NULL rows in SQL)
    where: { AND: [where, { OR: [{ exception: null }, { exception: { not: "CANCELLED" } }] }] },
    include: PUBLICATION_INCLUDE,
    orderBy: [{ scheduledAt: "asc" }, { id: "asc" }],
    take: CAP + 1,
  });
  const truncated = rows.length > CAP;
  const items = rows.slice(0, CAP).map((t) => {
    const dto = toPublicationDto(t, settings.requireApproval);
    return {
      id: dto.id,
      state: dto.state,
      stateLabel: dto.stateLabel,
      schedulingOwner: dto.schedulingOwner,
      scheduledAt: dto.scheduledAt,
      scheduledTimezone: dto.scheduledTimezone,
      contentId: dto.contentId,
      platform: dto.destination.platform,
      handle: dto.destination.handle,
      campaign: dto.campaign,
      creator: dto.destination.creator,
      managedPage: dto.destination.managedPage,
      snippet: (dto.effective.caption ?? "").slice(0, 90),
      errorMessage: dto.errorMessage,
      allowedActions: dto.allowedActions,
    };
  });
  return { items, truncated, timezone: settings.timezone, from: f.from, to: f.to };
}

export async function getOverview(actor: SafeUser, f: PublicationFilters) {
  const settings = await getEffectiveSettings(actor.organizationId);
  const base = filterWhere(actor.organizationId, { ...f, states: undefined });
  const counts = await Promise.all(PUBLICATION_STATES.map((s) => prisma.contentTarget.count({ where: { AND: [base, stateWhere(s)] } })));
  const byState = Object.fromEntries(PUBLICATION_STATES.map((s, i) => [s, counts[i]!])) as Record<PublicationState, number>;
  const n = (...s: PublicationState[]) => s.reduce((sum, k) => sum + byState[k], 0);

  const accounts = await prisma.socialAccount.findMany({ where: { organizationId: actor.organizationId }, select: { status: true, providerMetadata: true, platform: true } });
  const isDemo = (m: unknown) => typeof m === "object" && m !== null && !Array.isArray(m) && (m as Record<string, unknown>).seed === true;
  const connected = accounts.filter((a) => a.status === "CONNECTED" && !isDemo(a.providerMetadata));

  const upcoming = await prisma.contentTarget.findMany({
    where: { AND: [base, { status: "SCHEDULED", scheduledAt: { gte: new Date() } }] },
    include: PUBLICATION_INCLUDE,
    orderBy: [{ scheduledAt: "asc" }, { id: "asc" }],
    take: 8,
  });

  return {
    timezone: settings.timezone,
    approval: { required: settings.requireApproval, source: settings.source },
    metrics: {
      scheduled: byState.SCHEDULED,
      published: byState.PUBLISHED,
      pending: n("DRAFT", "READY_FOR_REVIEW", "APPROVED", "QUEUED", "PUBLISHING", "HELD"),
      failed: n("FAILED", "STALE"),
      awaitingApproval: byState.READY_FOR_REVIEW,
      connectedAccounts: connected.length,
      connectedByPlatform: connected.reduce<Record<string, number>>((m, a) => ({ ...m, [a.platform]: (m[a.platform] ?? 0) + 1 }), {}),
    },
    byState,
    upcoming: upcoming.map((t) => {
      const d = toPublicationDto(t, settings.requireApproval);
      return { id: d.id, scheduledAt: d.scheduledAt, platform: d.destination.platform, handle: d.destination.handle, schedulingOwner: d.schedulingOwner, snippet: (d.effective.caption ?? "").slice(0, 90), campaign: d.campaign };
    }),
  };
}

// ------------------------------------------------------------------------------------------------ detail

export async function getPublicationDetail(actor: SafeUser, id: string) {
  const settings = await getEffectiveSettings(actor.organizationId);
  const t = await prisma.contentTarget.findFirst({ where: { id, content: { organizationId: actor.organizationId } }, include: PUBLICATION_INCLUDE });
  if (!t) throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, "Publication not found.");
  const [events, attempts, revisions, validation, siblings] = await Promise.all([
    prisma.publicationEvent.findMany({ where: { contentTargetId: id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], include: { actor: { select: { id: true, name: true } } }, take: 200 }),
    prisma.publishAttempt.findMany({ where: { contentTargetId: id }, orderBy: { attemptNumber: "desc" }, take: 50 }),
    prisma.contentRevision.findMany({ where: { contentId: t.contentId }, orderBy: { revision: "desc" }, take: 20, include: { createdBy: { select: { id: true, name: true } } } }),
    ["DRAFT", "READY_FOR_REVIEW", "APPROVED", "REJECTED", "SCHEDULED", "HELD", "STALE", "FAILED"].includes(stateOf(t)) ? validatePublicationTarget(t, { settings, now: new Date(), scheduledAt: t.scheduledAt, scheduleRequired: false, skipCaps: stateOf(t) === "FAILED" || stateOf(t) === "STALE" }) : Promise.resolve(null),
    prisma.contentTarget.count({ where: { contentId: t.contentId } }),
  ]);
  const userIds = [t.submittedById, t.approvedById].filter((x): x is string => Boolean(x));
  const people = userIds.length ? await prisma.user.findMany({ where: { id: { in: userIds }, organizationId: actor.organizationId }, select: { id: true, name: true } }) : [];
  const name = (uid: string | null) => people.find((p) => p.id === uid)?.name ?? null;

  const dto = toPublicationDto(t, settings.requireApproval);
  const factsById = new Map(assetFacts(t).map((f) => [f.id, f]));
  return {
    ...dto,
    timezone: settings.timezone,
    submittedBy: dto.submittedById ? { id: dto.submittedById, name: name(dto.submittedById) } : null,
    approvedBy: dto.approvedById ? { id: dto.approvedById, name: name(dto.approvedById) } : null,
    content: {
      id: t.content.id,
      caption: t.content.caption,
      status: t.content.status,
      siblingPublications: siblings,
      // `facts` shows what is KNOWN about each file; a null is an honest "unknown", never a guess.
      assets: t.content.assets
        .filter((a) => a.platform === null || a.platform === t.socialAccount.platform)
        .map((a) => {
          const f = factsById.get(a.id);
          return { id: a.id, type: a.type, platform: a.platform, url: a.url, metadata: a.metadata, facts: { width: f?.width ?? null, height: f?.height ?? null, durationSec: f?.durationSec ?? null, sizeBytes: f?.sizeBytes ?? null } };
        }),
    },
    providerOwned: isProviderOwned(t),
    validation,
    events: events.map((e) => ({ id: e.id, type: e.type, fromState: e.fromState, toState: e.toState, reason: e.reason, metadata: e.metadata, createdAt: e.createdAt, actor: e.actor ? { id: e.actor.id, name: e.actor.name } : null })),
    attempts: attempts.map((a) => ({ id: a.id, attemptNumber: a.attemptNumber, status: a.status, errorCode: a.errorCode, errorMessage: a.errorMessage, retryable: a.retryable, httpStatusCode: a.httpStatusCode, rateLimitResetAt: a.rateLimitResetAt, startedAt: a.startedAt, completedAt: a.completedAt, externalPostId: a.externalPostId, externalPostUrl: a.externalPostUrl })),
    revisions: revisions.map((r) => ({ revision: r.revision, reason: r.reason, createdAt: r.createdAt, createdBy: r.createdBy ? { id: r.createdBy.id, name: r.createdBy.name } : null })),
    text: effectiveTextOf(t),
  };
}

// ------------------------------------------------------------------------------------------------ destinations

/**
 * The destination picker: every publishing account of the organization with its readiness (the same account/provider
 * checks scheduling applies), the creator / thematic page behind it and how busy it is today.
 */
export async function listDestinations(
  actor: SafeUser,
  q: { page: number; pageSize: number; ids?: string[]; search?: string; platform?: "TIKTOK" | "INSTAGRAM" | "YOUTUBE"; provider?: "NATIVE" | "UPLOAD_POST"; creatorId?: string; managedPageId?: string; readyOnly?: boolean },
) {
  const settings = await getEffectiveSettings(actor.organizationId);
  const where: Prisma.SocialAccountWhereInput = {
    organizationId: actor.organizationId,
    ...(q.ids ? { id: { in: q.ids } } : {}),
    ...(q.platform ? { platform: q.platform } : {}),
    ...(q.provider ? { publishingProvider: q.provider } : {}),
    ...(q.search ? { OR: [{ handle: { contains: q.search } }, { displayName: { contains: q.search } }] } : {}),
    ...(q.creatorId ? { uploadPostAccount: { is: { creatorId: q.creatorId } } } : {}),
    ...(q.managedPageId ? { uploadPostAccount: { is: { profile: { managedPageId: q.managedPageId } } } } : {}),
  };
  const accounts = await prisma.socialAccount.findMany({
    where,
    include: { uploadPostAccount: { include: { creator: { select: { id: true, name: true } }, profile: { include: { managedPage: { select: { id: true, name: true } } } } } } },
    orderBy: [{ platform: "asc" }, { handle: "asc" }, { id: "asc" }],
  });

  const day = zonedDayRange(zonedDayKey(new Date(), settings.timezone), settings.timezone);
  const usage = accounts.length
    ? await prisma.contentTarget.groupBy({
        by: ["socialAccountId"],
        where: { socialAccountId: { in: accounts.map((a) => a.id) }, status: { in: ["SCHEDULED", "PUBLISHING", "PUBLISHED"] }, scheduledAt: { gte: day.start, lt: day.end } },
        _count: { _all: true },
      })
    : [];
  const usageOf = new Map(usage.map((u) => [u.socialAccountId, u._count._all]));

  const rows = accounts.map((a) => {
    const up = a.uploadPostAccount;
    const meta = a.providerMetadata;
    const issues = validateDestination(
      {
        platform: a.platform as PlatformKey,
        handle: a.handle,
        accountStatus: a.status,
        isDemo: typeof meta === "object" && meta !== null && !Array.isArray(meta) && (meta as Record<string, unknown>).seed === true,
        provider: a.publishingProvider,
        uploadPost: up
          ? { accountStatus: up.status, accountPlatform: up.platform, capabilities: Array.isArray(up.capabilities) ? up.capabilities.filter((c): c is string => typeof c === "string") : [], profileStatus: up.profile.status, profileBlocked: up.profile.blocked, identityUnchanged: up.providerAccountId === a.externalAccountId }
          : null,
      },
      a.platform as PlatformKey,
    );
    const capabilities = up && Array.isArray(up.capabilities) ? up.capabilities.filter((c): c is string => typeof c === "string") : [];
    const todayCount = usageOf.get(a.id) ?? 0;
    return {
      id: a.id,
      platform: a.platform,
      handle: a.handle,
      displayName: a.displayName,
      status: a.status,
      provider: a.publishingProvider,
      profile: up ? { id: up.profile.id, username: up.profile.username } : null,
      creator: up?.creator ?? null,
      managedPage: up?.profile.managedPage ?? null,
      ready: issues.length === 0,
      problems: issues.map((i) => ({ code: i.code, message: i.message })),
      supports: { music: a.platform === "TIKTOK" && a.publishingProvider === "UPLOAD_POST" && capabilities.includes("music"), images: a.platform !== "YOUTUBE", video: true },
      today: { count: todayCount, cap: settings.maxPostsPerDestinationPerDay, capReached: todayCount >= settings.maxPostsPerDestinationPerDay },
    };
  });
  const filtered = q.readyOnly ? rows.filter((r) => r.ready) : rows;
  const start = (q.page - 1) * q.pageSize;
  return { items: filtered.slice(start, start + q.pageSize), total: filtered.length, page: q.page, pageSize: q.pageSize, timezone: settings.timezone };
}
