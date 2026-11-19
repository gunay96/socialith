import { Prisma, prisma } from "@socialith/database";
import type { PostMetricsSnapshot } from "@socialith/database";

export type { PostMetricsSnapshot };

/** Org isolation enforced by the caller (content.service.ts's getContentDetail already 404s a wrong-org contentId before this runs). */
export function listMetricsSnapshots(contentTargetId: string): Promise<PostMetricsSnapshot[]> {
  return prisma.postMetricsSnapshot.findMany({
    where: { contentTargetId },
    orderBy: { fetchedAt: "asc" },
  });
}

export interface MetricsRollup {
  targetCount: number;
  publishedCount: number;
  syncedCount: number;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  shareCount: number;
}

const EMPTY_ROLLUP: MetricsRollup = {
  targetCount: 0,
  publishedCount: 0,
  syncedCount: 0,
  viewCount: 0,
  likeCount: 0,
  commentCount: 0,
  shareCount: 0,
};

/**
 * Sums each target's *latest* snapshot only (a growth series isn't summed
 * across time, just across targets) — a real `DISTINCT ON` query against
 * the (content_target_id, fetched_at) index, not an N+1 walk, so this
 * stays cheap at 1000+ targets. `targetIds` is always pre-scoped to the
 * caller's organization by whoever built it (see analytics.service.ts) —
 * this function itself trusts the list it's given rather than re-deriving
 * organization membership, matching content-target.repository.ts's
 * `Db`-scoped-elsewhere pattern.
 */
export async function getMetricsRollupForTargets(targetIds: string[]): Promise<MetricsRollup> {
  if (targetIds.length === 0) return EMPTY_ROLLUP;

  const [targetCount, publishedCount, latestSnapshots] = await Promise.all([
    Promise.resolve(targetIds.length),
    prisma.contentTarget.count({ where: { id: { in: targetIds }, status: "PUBLISHED" } }),
    prisma.$queryRaw<
      { view_count: number | null; like_count: number | null; comment_count: number | null; share_count: number | null }[]
    >(Prisma.sql`
      SELECT DISTINCT ON (content_target_id)
        view_count, like_count, comment_count, share_count
      FROM post_metrics_snapshots
      WHERE content_target_id IN (${Prisma.join(targetIds)})
      ORDER BY content_target_id, fetched_at DESC
    `),
  ]);

  const rollup = latestSnapshots.reduce(
    (acc, row) => ({
      viewCount: acc.viewCount + (row.view_count ?? 0),
      likeCount: acc.likeCount + (row.like_count ?? 0),
      commentCount: acc.commentCount + (row.comment_count ?? 0),
      shareCount: acc.shareCount + (row.share_count ?? 0),
    }),
    { viewCount: 0, likeCount: 0, commentCount: 0, shareCount: 0 },
  );

  return { targetCount, publishedCount, syncedCount: latestSnapshots.length, ...rollup };
}
