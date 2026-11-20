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

/** MySQL returns SUM() as DECIMAL and a CAST to an integer as BIGINT (a JS bigint, which JSON cannot carry): normalize to a number. */
type TopRow = { id: string; label: string; viewCount: number | bigint | string };
const toTopPerformers = (rows: TopRow[]): TopPerformer[] => rows.map((r) => ({ id: r.id, label: r.label, viewCount: Number(r.viewCount) }));

/**
 * Top 5 by real summed views (latest snapshot per target, picked with a
 * LATERAL derived table: MySQL 8.0.14+, so 8.4 is fine) — content with no
 * synced metrics yet simply doesn't appear rather than showing a fabricated
 * zero-ranked entry; a target whose newest snapshot has no view count is
 * left out (it does not fall back to an older one), as before. Ties on the
 * view count are ordered by id so the ranking is stable, and the newest
 * snapshot of a tie in fetched_at is the one with the greater id.
 */
export async function getTopContent(organizationId: string): Promise<TopPerformer[]> {
  const rows = await prisma.$queryRaw<TopRow[]>(Prisma.sql`
    SELECT c.id AS id, COALESCE(c.caption, '(no caption)') AS label, SUM(latest.view_count) AS viewCount
    FROM content c
    JOIN content_targets ct ON ct.content_id = c.id
    JOIN LATERAL (
      SELECT pms.view_count AS view_count FROM post_metrics_snapshots pms
      WHERE pms.content_target_id = ct.id ORDER BY pms.fetched_at DESC, pms.id DESC LIMIT 1
    ) AS latest ON TRUE
    WHERE c.organization_id = ${organizationId} AND latest.view_count IS NOT NULL
    GROUP BY c.id, c.caption
    ORDER BY viewCount DESC, c.id ASC
    LIMIT 5
  `);
  return toTopPerformers(rows);
}

export async function getTopSounds(organizationId: string): Promise<TopPerformer[]> {
  const rows = await prisma.$queryRaw<TopRow[]>(Prisma.sql`
    SELECT s.id AS id, s.title AS label, SUM(latest.view_count) AS viewCount
    FROM sounds s
    JOIN content c ON c.sound_id = s.id
    JOIN content_targets ct ON ct.content_id = c.id
    JOIN LATERAL (
      SELECT pms.view_count AS view_count FROM post_metrics_snapshots pms
      WHERE pms.content_target_id = ct.id ORDER BY pms.fetched_at DESC, pms.id DESC LIMIT 1
    ) AS latest ON TRUE
    WHERE s.organization_id = ${organizationId} AND latest.view_count IS NOT NULL
    GROUP BY s.id, s.title
    ORDER BY viewCount DESC, s.id ASC
    LIMIT 5
  `);
  return toTopPerformers(rows);
}
