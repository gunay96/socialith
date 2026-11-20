import { prisma } from "@socialith/database";
import type { ContentTarget, ContentTargetStatus, Prisma } from "@socialith/database";

/**
 * Optional Prisma client override so services/content-target.service.ts
 * can run the assign+schedule sequence inside one `prisma.$transaction`
 * — same pattern as every other repository in this codebase that needs
 * transactional atomicity.
 */
type Db = Pick<typeof prisma, "contentTarget" | "socialAccount">;

/**
 * Filters `socialAccountIds` down to the ones that actually belong to
 * `organizationId` — the organization-isolation check for bulk targeting
 * (mirrors team.repository.ts's findOrganizationMemberById, generalized
 * to a batch). IDs that don't match (wrong org, or don't exist at all)
 * are silently excluded here; the caller reports them as `skipped`
 * rather than 403/404-ing the whole batch for one bad ID.
 */
export async function filterOwnedSocialAccountIds(
  organizationId: string,
  socialAccountIds: string[],
  db: Db = prisma,
): Promise<string[]> {
  const owned = await db.socialAccount.findMany({
    where: { organizationId, id: { in: socialAccountIds } },
    select: { id: true },
  });
  return owned.map((a) => a.id);
}

/**
 * Bulk-assigns target accounts to a content item in a single INSERT —
 * not one query per account (the exact N+1/1000-requests mistake this
 * phase is designed to avoid). `skipDuplicates` makes re-assigning an
 * already-targeted account a no-op instead of a unique-constraint error,
 * so the operation is safely repeatable.
 */
export async function assignContentTargets(
  contentId: string,
  socialAccountIds: string[],
  db: Db = prisma,
): Promise<number> {
  if (socialAccountIds.length === 0) return 0;
  const result = await db.contentTarget.createMany({
    data: socialAccountIds.map((socialAccountId) => ({ contentId, socialAccountId })),
    skipDuplicates: true,
  });
  return result.count;
}

/** Bulk-removes targets in one query. Idempotent — removing a target that was never assigned is a no-op. */
export async function removeContentTargets(
  contentId: string,
  socialAccountIds: string[],
  db: Db = prisma,
): Promise<number> {
  if (socialAccountIds.length === 0) return 0;
  const result = await db.contentTarget.deleteMany({
    where: { contentId, socialAccountId: { in: socialAccountIds } },
  });
  return result.count;
}

/**
 * Bulk-schedules every PENDING target of a content in one UPDATE — the
 * query shape Phase 08's worker will eventually mirror in reverse
 * ("find due SCHEDULED targets"), see the (status, scheduledAt) index on
 * ContentTarget in schema.prisma.
 */
export async function scheduleContentTargets(
  contentId: string,
  scheduledAt: Date,
  db: Db = prisma,
  options: { requireApproved?: boolean } = {},
): Promise<number> {
  // Phase 3: targets that are already SCHEDULED move to the new time too (rescheduling a content item must move its
  // targets, each of which now carries its own time); HELD / CANCELLED targets are parked on purpose and never
  // re-scheduled by this bulk path; when the organization requires approval only APPROVED targets qualify.
  const result = await db.contentTarget.updateMany({
    where: {
      contentId,
      status: { in: ["PENDING", "SCHEDULED"] },
      exception: null,
      ...(options.requireApproved ? { approvalStatus: "APPROVED" as const } : {}),
    },
    data: { status: "SCHEDULED", scheduledAt },
  });
  return result.count;
}

/** Org isolation is enforced by the caller already having 404'd on `contentId` (see content.service.ts's getContentDetail). */
export function findContentTargetByAccount(contentId: string, socialAccountId: string): Promise<ContentTarget | null> {
  return prisma.contentTarget.findUnique({ where: { contentId_socialAccountId: { contentId, socialAccountId } } });
}

/**
 * Phase 08 manual retry's idempotency guard: an atomic conditional
 * UPDATE, not a read-then-write — only a target whose status is still
 * FAILED at the moment this runs gets reset to PUBLISHING, so two
 * concurrent retry requests for the same target can't both succeed and
 * enqueue two competing jobs (the loser's WHERE simply matches zero
 * rows). Mirrors content-target.repository.ts's other bulk-updateMany
 * calls in spirit, just scoped to exactly one row.
 */
export async function resetTargetForRetry(contentTargetId: string): Promise<boolean> {
  const result = await prisma.contentTarget.updateMany({
    where: { id: contentTargetId, status: "FAILED" },
    data: { status: "PUBLISHING", errorMessage: null, exception: null }, // a STALE marker ends with the retry
  });
  return result.count === 1;
}

/**
 * Phase 09 analytics rollups: the id list a `getMetricsRollupForTargets`
 * call (analytics.repository.ts) needs, scoped four different ways. Ids
 * only — never the full rows — since a rollup only sums metrics, and
 * pulling every ContentTarget column for potentially 1000+ rows just to
 * discard most of it would be the exact "select everything" mistake this
 * phase's scale rules warn against.
 */
export async function listTargetIdsForContent(contentId: string): Promise<string[]> {
  const rows = await prisma.contentTarget.findMany({ where: { contentId }, select: { id: true } });
  return rows.map((r) => r.id);
}

export async function listTargetIdsForCampaign(campaignId: string): Promise<string[]> {
  const rows = await prisma.contentTarget.findMany({ where: { content: { campaignId } }, select: { id: true } });
  return rows.map((r) => r.id);
}

export async function listTargetIdsForSound(soundId: string): Promise<string[]> {
  const rows = await prisma.contentTarget.findMany({ where: { content: { soundId } }, select: { id: true } });
  return rows.map((r) => r.id);
}

export async function listTargetIdsForAccount(socialAccountId: string): Promise<string[]> {
  const rows = await prisma.contentTarget.findMany({ where: { socialAccountId }, select: { id: true } });
  return rows.map((r) => r.id);
}

export interface ListContentTargetsResult {
  items: (ContentTarget & {
    socialAccount: { id: string; platform: string; handle: string; displayName: string; status: string };
  })[];
  total: number;
}

/**
 * Paginated — a single content item can have 1000+ targets, so this is
 * never returned inline with the content detail response (see
 * content.repository.ts's findContentById, which only returns a count).
 */
export async function listContentTargets(
  contentId: string,
  page: number,
  pageSize: number,
  status?: ContentTargetStatus,
): Promise<ListContentTargetsResult> {
  const where: Prisma.ContentTargetWhereInput = { contentId, ...(status ? { status } : {}) };
  const [items, total] = await Promise.all([
    prisma.contentTarget.findMany({
      where,
      include: {
        socialAccount: { select: { id: true, platform: true, handle: true, displayName: true, status: true } },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.contentTarget.count({ where }),
  ]);
  return { items, total };
}
