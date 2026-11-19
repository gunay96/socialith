import { Prisma, prisma } from "@socialith/database";
import { getMetricsRollupForTargets, type MetricsRollup } from "./analytics.repository.js";

export interface AccountsByStatus {
  total: number;
  connected: number;
  expired: number;
  error: number;
  disconnected: number;
}

export interface DashboardOverview {
  accounts: AccountsByStatus;
  activeCampaigns: number;
  scheduledContent: number;
  publishingNow: number;
  publishedLast30d: number;
  failedLast30d: number;
  metrics: MetricsRollup;
}

export interface TopPerformer {
  id: string;
  label: string;
  viewCount: number;
}

/**
 * One dashboard-load's worth of real aggregate queries — every number
 * comes from an actual indexed COUNT/SUM against this organization's own
 * rows, never a placeholder. Run in parallel (Promise.all), not
 * sequentially, and each query is scoped to `organizationId` directly in
 * its own WHERE clause — the same isolation pattern every other
 * repository in this codebase uses.
 */
export async function getDashboardOverview(organizationId: string): Promise<DashboardOverview> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [statusCounts, activeCampaigns, scheduledContent, publishingNow, publishedLast30d, failedLast30d, publishedTargetIds] =
    await Promise.all([
      prisma.socialAccount.groupBy({ by: ["status"], where: { organizationId }, _count: { _all: true } }),
      prisma.campaign.count({ where: { organizationId, status: "ACTIVE" } }),
      prisma.content.count({ where: { organizationId, status: "SCHEDULED" } }),
      prisma.content.count({ where: { organizationId, status: "PUBLISHING" } }),
      prisma.contentTarget.count({
        where: { socialAccount: { organizationId }, status: "PUBLISHED", publishedAt: { gte: thirtyDaysAgo } },
      }),
      prisma.contentTarget.count({
        where: { socialAccount: { organizationId }, status: "FAILED", updatedAt: { gte: thirtyDaysAgo } },
      }),
      prisma.contentTarget.findMany({
        where: { socialAccount: { organizationId }, status: "PUBLISHED" },
        select: { id: true },
      }),
    ]);

  const accounts: AccountsByStatus = { total: 0, connected: 0, expired: 0, error: 0, disconnected: 0 };
  for (const row of statusCounts) {
    accounts.total += row._count._all;
    if (row.status === "CONNECTED") accounts.connected = row._count._all;
    else if (row.status === "EXPIRED") accounts.expired = row._count._all;
    else if (row.status === "ERROR") accounts.error = row._count._all;
    else if (row.status === "DISCONNECTED") accounts.disconnected = row._count._all;
  }

  const metrics = await getMetricsRollupForTargets(publishedTargetIds.map((t) => t.id));

  return { accounts, activeCampaigns, scheduledContent, publishingNow, publishedLast30d, failedLast30d, metrics };
}

/**
 * Top 5 by real summed views (latest snapshot per target, via the same
 * LATERAL-join pattern analytics.repository.ts's DISTINCT ON query uses)
 * — content with no synced metrics yet simply doesn't appear rather than
 * showing a fabricated zero-ranked entry.
 */
export async function getTopContent(organizationId: string): Promise<TopPerformer[]> {
  return prisma.$queryRaw<TopPerformer[]>(Prisma.sql`
    SELECT c.id, COALESCE(c.caption, '(no caption)') as label, SUM(latest.view_count)::int as "viewCount"
    FROM content c
    JOIN content_targets ct ON ct.content_id = c.id
    JOIN LATERAL (
      SELECT view_count FROM post_metrics_snapshots pms
      WHERE pms.content_target_id = ct.id ORDER BY fetched_at DESC LIMIT 1
    ) latest ON true
    WHERE c.organization_id = ${organizationId} AND latest.view_count IS NOT NULL
    GROUP BY c.id, c.caption
    ORDER BY "viewCount" DESC
    LIMIT 5
  `);
}

export async function getTopSounds(organizationId: string): Promise<TopPerformer[]> {
  return prisma.$queryRaw<TopPerformer[]>(Prisma.sql`
    SELECT s.id, s.title as label, SUM(latest.view_count)::int as "viewCount"
    FROM sounds s
    JOIN content c ON c.sound_id = s.id
    JOIN content_targets ct ON ct.content_id = c.id
    JOIN LATERAL (
      SELECT view_count FROM post_metrics_snapshots pms
      WHERE pms.content_target_id = ct.id ORDER BY fetched_at DESC LIMIT 1
    ) latest ON true
    WHERE s.organization_id = ${organizationId} AND latest.view_count IS NOT NULL
    GROUP BY s.id, s.title
    ORDER BY "viewCount" DESC
    LIMIT 5
  `);
}
