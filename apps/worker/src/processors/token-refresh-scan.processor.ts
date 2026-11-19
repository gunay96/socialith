import { prisma } from "@socialith/database";
import { logger } from "../logger.js";
import { enqueueTokenRefresh } from "../scheduled/producers.js";

/** Refresh proactively this far ahead of expiry — generous enough that a token never actually expires mid-publish even if this scan's own interval (see index.ts's repeatable job) is somewhat coarse. */
const SAFETY_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 hours

/** Never enqueue more than this many refreshes from one scan tick — bounds the fan-out even if thousands of connections are due at once (e.g. right after a bulk-connect), matching this phase's explicit "don't refresh 1000+ accounts at once" rule. The next scan tick picks up whatever's left. */
const MAX_PER_SCAN = 500;

/**
 * A single BullMQ *repeatable* job (registered once in index.ts, not a
 * new scheduler system) — finds active connections whose token expires
 * within the safety window and fans out one token-refresh job per
 * connection. Never touches encrypted columns itself, only `id` +
 * `tokenExpiresAt` (indexed — see schema.prisma's PlatformConnection).
 */
export async function processTokenRefreshScan(): Promise<void> {
  const threshold = new Date(Date.now() + SAFETY_WINDOW_MS);
  const dueConnections = await prisma.platformConnection.findMany({
    where: { revokedAt: null, encryptedAccessToken: { not: null }, tokenExpiresAt: { lte: threshold } },
    select: { id: true },
    take: MAX_PER_SCAN,
  });

  for (const connection of dueConnections) {
    await enqueueTokenRefresh(connection.id);
  }

  if (dueConnections.length > 0) {
    logger.info({ count: dueConnections.length }, "token-refresh-scan: enqueued refresh jobs");
  }
}
