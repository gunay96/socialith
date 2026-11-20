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

/** How many target ids go into one query: far below MySQL's 65,535 placeholder limit, so any number of targets works. */
const TARGET_CHUNK = 1000;

type SnapshotRow = { view_count: number | null; like_count: number | null; comment_count: number | null; share_count: number | null };

/**
 * The newest snapshot of each given target (MySQL 8.4): ROW_NUMBER() over the (content_target_id, fetched_at)
 * index, `rn = 1` per target. `id DESC` breaks a tie between two snapshots fetched in the same millisecond, so the
 * choice is deterministic (the PostgreSQL `DISTINCT ON` this replaces left ties arbitrary). A target with no snapshot
 * yields no row; a latest snapshot whose counters are NULL yields a row of NULLs (counted as "synced", summed as 0) -
 * exactly as before.
 */
async function latestSnapshotsFor(ids: string[]): Promise<SnapshotRow[]> {
  return prisma.$queryRaw<SnapshotRow[]>(Prisma.sql`
    SELECT view_count, like_count, comment_count, share_count
    FROM (
      SELECT view_count, like_count, comment_count, share_count,
             ROW_NUMBER() OVER (PARTITION BY content_target_id ORDER BY fetched_at DESC, id DESC) AS rn
      FROM post_metrics_snapshots
      WHERE content_target_id IN (${Prisma.join(ids)})
    ) AS ranked
    WHERE rn = 1
  `);
}

/**
 * Sums each target's *latest* snapshot only (a growth series isn't summed
 * across time, just across targets) — one windowed query per chunk of
 * targets against the (content_target_id, fetched_at) index, not an N+1
 * walk, so this stays cheap at 1000+ targets. A target belongs to exactly
 * one chunk and the window is partitioned by target, so chunking cannot
 * double-count or drop a target. `targetIds` is always pre-scoped to the
 * caller's organization by whoever built it (see analytics.service.ts) —
 * this function itself trusts the list it's given rather than re-deriving
 * organization membership, matching content-target.repository.ts's
 * `Db`-scoped-elsewhere pattern.
 */
export async function getMetricsRollupForTargets(targetIds: string[]): Promise<MetricsRollup> {
  if (targetIds.length === 0) return EMPTY_ROLLUP;
  const unique = [...new Set(targetIds)];

  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += TARGET_CHUNK) chunks.push(unique.slice(i, i + TARGET_CHUNK));

  const [targetCount, publishedCounts, snapshotChunks] = await Promise.all([
    Promise.resolve(unique.length),
    Promise.all(chunks.map((ids) => prisma.contentTarget.count({ where: { id: { in: ids }, status: "PUBLISHED" } }))),
    Promise.all(chunks.map(latestSnapshotsFor)),
  ]);
  const publishedCount = publishedCounts.reduce((a, b) => a + b, 0);
  const latestSnapshots = snapshotChunks.flat();

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
