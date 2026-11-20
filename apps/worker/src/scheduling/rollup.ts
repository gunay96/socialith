import type { Prisma, PrismaClient } from "@socialith/database";
import { computeContentRollup, type ContentRollupStatus } from "@socialith/publishing";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Recomputes Content.status (and Content.scheduledAt = earliest scheduled target) from its targets with the shared
 * pure rule in @socialith/publishing. Targets are scheduled, held, cancelled and published independently, so the
 * content status is always derived, never assumed.
 */
export async function rollUpContent(db: Db, contentId: string): Promise<{ status: ContentRollupStatus; scheduledAt: Date | null }> {
  const rows = await db.contentTarget.groupBy({
    by: ["status", "exception"],
    where: { contentId },
    _count: { _all: true },
    _min: { scheduledAt: true },
  });
  const rollup = computeContentRollup(rows.map((r) => ({ status: r.status, exception: r.exception, count: r._count._all, minScheduledAt: r._min.scheduledAt })));
  await db.content.update({
    where: { id: contentId },
    data: { status: rollup.status, ...(rollup.scheduledAt ? { scheduledAt: rollup.scheduledAt } : {}) },
  });
  return rollup;
}
