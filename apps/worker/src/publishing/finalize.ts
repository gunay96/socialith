import type { PrismaClient } from "@socialith/database";

/**
 * After a target reaches a terminal state, rolls Content.status up from its targets — PUBLISHED only
 * if every target succeeded, FAILED if any did not. Extracted from publishing.processor.ts (no behaviour
 * change) so the Upload-Post reconciler can use it without importing the processor (import cycle).
 */
export async function finalizeContentStatus(db: PrismaClient, contentId: string): Promise<void> {
  const remaining = await db.contentTarget.count({
    where: { contentId, status: { in: ["PENDING", "SCHEDULED", "PUBLISHING"] } },
  });
  if (remaining > 0) return;

  const failedCount = await db.contentTarget.count({ where: { contentId, status: "FAILED" } });
  await db.content.update({
    where: { id: contentId },
    data: { status: failedCount > 0 ? "FAILED" : "PUBLISHED" },
  });
}
