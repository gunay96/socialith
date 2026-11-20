import { prisma } from "@socialith/database";
import type { Prisma, PublicationEventType } from "@socialith/database";
import {
  DEFAULT_PUBLISHING_POLICY,
  DEFAULT_TIMEZONE,
  allowedActions,
  buildTargetPayload,
  computeContentRollup,
  derivePublicationState,
  effectiveText,
  schedulingOwner,
  STATE_LABELS,
  type DestinationFacts,
  type PublicationState,
} from "@socialith/publishing";
import { enqueueContentScheduling, removeContentSchedulingJob } from "../lib/queue.js";

/** Everything one publication (a ContentTarget) needs for display, validation and approval pinning. */
export const PUBLICATION_INCLUDE = {
  content: {
    include: {
      variations: true,
      assets: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
      sound: { select: { id: true, title: true, artist: true } },
      campaign: { select: { id: true, name: true, autoScheduleOnApproval: true } },
    },
  },
  socialAccount: {
    include: {
      // Phase 4: the page this destination is directly authorized for (wins over the Phase 2 profile mapping below).
      managedPage: { select: { id: true, name: true } },
      uploadPostAccount: {
        include: {
          creator: { select: { id: true, name: true } },
          profile: { include: { managedPage: { select: { id: true, name: true } } } },
        },
      },
    },
  },
  uploadPostPublication: true,
} satisfies Prisma.ContentTargetInclude;

export type Publication = Prisma.ContentTargetGetPayload<{ include: typeof PUBLICATION_INCLUDE }>;

/** A destination (SocialAccount) with the provider rows its readiness depends on. */
export type DestinationRow = Prisma.SocialAccountGetPayload<{ include: { uploadPostAccount: { include: { profile: true } } } }>;

/**
 * The facts the platform/provider checks need about a destination. One definition for the Publishing Center's
 * validation and for the Page Network's account mapping, so both always agree on what "ready" means.
 */
export function destinationFactsOf(s: DestinationRow): DestinationFacts {
  const up = s.uploadPostAccount;
  const meta = s.providerMetadata;
  return {
    platform: s.platform,
    handle: s.handle,
    accountStatus: s.status,
    isDemo: typeof meta === "object" && meta !== null && !Array.isArray(meta) && (meta as Record<string, unknown>).seed === true,
    provider: s.publishingProvider,
    uploadPost: up
      ? {
          accountStatus: up.status,
          accountPlatform: up.platform,
          capabilities: Array.isArray(up.capabilities) ? up.capabilities.filter((c): c is string => typeof c === "string") : [],
          profileStatus: up.profile.status,
          profileBlocked: up.profile.blocked,
          identityUnchanged: up.providerAccountId === s.externalAccountId,
        }
      : null,
  };
}

// ---------------------------------------------------------------------------------------------- settings

export interface EffectiveSettings {
  /** "default" = the organization never saved Publishing Settings: the product defaults apply (approval REQUIRED). An explicitly saved preference is always honoured. */
  source: "default" | "configured";
  timezone: string;
  requireApproval: boolean;
  /** The OWNER may approve what they submitted themselves. */
  ownerSelfApproval: boolean;
  /** An ADMIN may approve what they submitted themselves (a CREATOR never may). */
  adminSelfApproval: boolean;
  autoScheduleOnApproval: boolean;
  duplicateGuard: "BLOCK" | "WARN" | "OFF";
  similarityThresholdPct: number;
  maxSimilarPerPlatform: number;
  maxPostsPerDestinationPerDay: number;
  minMinutesBetweenPosts: number;
  minLeadMinutes: number;
}

export async function getEffectiveSettings(organizationId: string): Promise<EffectiveSettings> {
  const [row, org] = await Promise.all([
    prisma.publishingSettings.findUnique({ where: { organizationId } }),
    prisma.organization.findUnique({ where: { id: organizationId }, select: { timezone: true } }),
  ]);
  if (row) {
    return {
      source: "configured",
      timezone: row.timezone,
      requireApproval: row.requireApproval,
      ownerSelfApproval: row.ownerSelfApproval,
      adminSelfApproval: row.adminSelfApproval,
      autoScheduleOnApproval: row.autoScheduleOnApproval,
      duplicateGuard: row.duplicateGuard,
      similarityThresholdPct: row.similarityThresholdPct,
      maxSimilarPerPlatform: row.maxSimilarPerPlatform,
      maxPostsPerDestinationPerDay: row.maxPostsPerDestinationPerDay,
      minMinutesBetweenPosts: row.minMinutesBetweenPosts,
      minLeadMinutes: row.minLeadMinutes,
    };
  }
  return {
    source: "default",
    timezone: org?.timezone || DEFAULT_TIMEZONE,
    // Product decision: approval is required unless an organization explicitly saved otherwise (new organizations and
    // organizations without a saved preference alike). The worker applies the same default.
    requireApproval: DEFAULT_PUBLISHING_POLICY.requireApproval,
    ownerSelfApproval: DEFAULT_PUBLISHING_POLICY.ownerSelfApproval,
    adminSelfApproval: DEFAULT_PUBLISHING_POLICY.adminSelfApproval,
    autoScheduleOnApproval: false,
    duplicateGuard: "BLOCK",
    similarityThresholdPct: 85,
    maxSimilarPerPlatform: 1,
    maxPostsPerDestinationPerDay: 3,
    minMinutesBetweenPosts: 60,
    minLeadMinutes: 10,
  };
}

// ---------------------------------------------------------------------------------------------- state

export function stateOf(t: Pick<Publication, "status" | "approvalStatus" | "exception" | "attemptCount" | "uploadPostPublication">): PublicationState {
  return derivePublicationState({
    status: t.status,
    approvalStatus: t.approvalStatus,
    exception: t.exception,
    attemptCount: t.attemptCount,
    hasProviderPublication: t.uploadPostPublication !== null,
  });
}

/** Mirrors apps/worker/src/scheduling/ownership.ts PROVIDER_OWNED: the Upload-Post scheduler holds this target's clock. */
export function isProviderOwned(t: Pick<Publication, "uploadPostPublication">): boolean {
  const p = t.uploadPostPublication;
  return p !== null && p.mode === "PROVIDER_SCHEDULED" && ["PENDING", "UNKNOWN_OUTCOME", "SCHEDULED_AT_PROVIDER"].includes(p.status);
}

export function payloadOf(t: Publication): string {
  return buildTargetPayload({
    platform: t.socialAccount.platform,
    captionOverride: t.captionOverride,
    titleOverride: t.titleOverride,
    content: { caption: t.content.caption, soundId: t.content.soundId, variations: t.content.variations, assets: t.content.assets },
  });
}

export function effectiveTextOf(t: Publication): { caption: string | null; title: string | null } {
  const variation = t.content.variations.find((v) => v.platform === t.socialAccount.platform) ?? null;
  return effectiveText({
    captionOverride: t.captionOverride,
    titleOverride: t.titleOverride,
    variationCaption: variation?.caption ?? null,
    variationTitle: variation?.title ?? null,
    contentCaption: t.content.caption,
  });
}

export function toPublicationDto(t: Publication, approvalRequired: boolean) {
  const state = stateOf(t);
  const providerScheduled = isProviderOwned(t);
  const up = t.socialAccount.uploadPostAccount;
  const pub = t.uploadPostPublication;
  const text = effectiveTextOf(t);
  return {
    id: t.id,
    contentId: t.contentId,
    campaign: t.content.campaign ? { id: t.content.campaign.id, name: t.content.campaign.name } : null,
    track: t.content.sound ? { id: t.content.sound.id, title: t.content.sound.title, artist: t.content.sound.artist } : null,
    destination: {
      id: t.socialAccount.id,
      platform: t.socialAccount.platform,
      handle: t.socialAccount.handle,
      displayName: t.socialAccount.displayName,
      status: t.socialAccount.status,
      provider: t.socialAccount.publishingProvider,
      profile: up ? { id: up.profile.id, username: up.profile.username } : null,
      creator: up?.creator ?? null,
      managedPage: t.socialAccount.managedPage ?? up?.profile.managedPage ?? null,
    },
    state,
    stateLabel: STATE_LABELS[state],
    approvalStatus: t.approvalStatus,
    exception: t.exception,
    allowedActions: allowedActions(state, approvalRequired),
    scheduledAt: t.scheduledAt,
    scheduledTimezone: t.scheduledTimezone,
    publishedAt: t.publishedAt,
    schedulingOwner: schedulingOwner(state, providerScheduled),
    externalPostId: t.externalPostId,
    externalPostUrl: t.externalPostUrl,
    errorMessage: t.errorMessage,
    deliveryNote: t.deliveryNote,
    attemptCount: t.attemptCount,
    captionOverride: t.captionOverride,
    titleOverride: t.titleOverride,
    requireMusic: t.requireMusic,
    effective: text,
    submittedAt: t.submittedAt,
    submittedById: t.submittedById,
    approvedAt: t.approvedAt,
    approvedById: t.approvedById,
    provider: pub
      ? { kind: "UPLOAD_POST" as const, mode: pub.mode, status: pub.status, externalId: pub.externalId, requestId: pub.requestId, jobId: pub.providerJobId, scheduledFor: pub.scheduledFor, notes: pub.notes, lastErrorKind: pub.lastErrorKind }
      : null,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

export type PublicationDto = ReturnType<typeof toPublicationDto>;

// ---------------------------------------------------------------------------------------------- events

type Tx = Prisma.TransactionClient;

export interface EventInput {
  organizationId: string;
  contentTargetId: string;
  type: PublicationEventType;
  fromState?: PublicationState | null;
  toState?: PublicationState | null;
  actorId?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown>;
}

export async function recordEvent(db: Tx | typeof prisma, e: EventInput): Promise<void> {
  await db.publicationEvent.create({
    data: {
      organizationId: e.organizationId,
      contentTargetId: e.contentTargetId,
      type: e.type,
      fromState: e.fromState ?? null,
      toState: e.toState ?? null,
      actorId: e.actorId ?? null,
      reason: e.reason ?? null,
      metadata: (e.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  });
}

// ---------------------------------------------------------------------------------------------- content roll-up and job

/** Same rule as the worker (apps/worker/src/scheduling/rollup.ts): Content.status derived from its targets. */
export async function rollUpContent(db: Tx | typeof prisma, contentId: string): Promise<{ status: string; scheduledAt: Date | null }> {
  const rows = await db.contentTarget.groupBy({ by: ["status", "exception"], where: { contentId }, _count: { _all: true }, _min: { scheduledAt: true } });
  const rollup = computeContentRollup(rows.map((r) => ({ status: r.status, exception: r.exception, count: r._count._all, minScheduledAt: r._min.scheduledAt })));
  await db.content.update({ where: { id: contentId }, data: { status: rollup.status, ...(rollup.scheduledAt ? { scheduledAt: rollup.scheduledAt } : {}) } });
  return rollup;
}

/**
 * Brings the BullMQ job in line with the database after a change: one deterministic job per content, set to the
 * EARLIEST scheduled target (or removed when nothing is scheduled). Called after the transaction committed, so a
 * failed enqueue can never leave a job for something the database does not consider scheduled; the reverse (a
 * committed schedule without a job) is repaired by the worker's reconciler, which reads the same rows.
 */
export async function armContentScheduling(contentId: string): Promise<void> {
  const next = await prisma.contentTarget.aggregate({ where: { contentId, status: "SCHEDULED" }, _min: { scheduledAt: true }, _count: { _all: true } });
  if (next._count._all === 0) {
    await removeContentSchedulingJob(contentId);
    return;
  }
  const at = next._min.scheduledAt ?? new Date();
  await enqueueContentScheduling(contentId, at);
}
