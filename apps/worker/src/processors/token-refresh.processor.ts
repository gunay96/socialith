import { prisma } from "@socialith/database";
import { loadEnv } from "@socialith/config";
import type { Job } from "bullmq";
import type { TokenRefreshJobData } from "@socialith/types";
import { logger } from "../logger.js";
import { forceRefreshAccessToken } from "../publishing/token.js";
import { PublishError } from "../publishing/types.js";

/**
 * Fires once per PlatformConnection the scan (below) found nearing
 * expiry. Goes through the same centralized refresh-and-persist logic
 * publishing/analytics-sync use (forceRefreshAccessToken), so there is
 * exactly one place token refresh actually happens, never a
 * scheduled-worker-specific copy of the per-platform refresh calls.
 */
export async function processTokenRefresh(job: Job<TokenRefreshJobData>): Promise<void> {
  const { platformConnectionId } = job.data;

  const connection = await prisma.platformConnection.findUnique({
    where: { id: platformConnectionId },
    include: { socialAccount: true },
  });
  if (!connection) {
    logger.warn({ platformConnectionId }, "token-refresh: connection no longer exists, skipping");
    return;
  }
  if (connection.revokedAt) {
    logger.warn({ platformConnectionId }, "token-refresh: connection was revoked since being scanned, skipping");
    return;
  }

  try {
    await forceRefreshAccessToken(loadEnv(), connection.socialAccount, connection);
    logger.info({ platformConnectionId, platform: connection.socialAccount.platform }, "token-refresh: succeeded");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ platformConnectionId, err: message }, "token-refresh: failed");
    if (err instanceof PublishError && err.code === "AUTH_ERROR") {
      // A real, permanent auth rejection (not just "not configured") —
      // surface it exactly like a failed publish attempt would (see
      // publishing.processor.ts's recordFailure): mark the account so
      // Accounts UI shows "reauthorization required" instead of staying
      // silently CONNECTED with a token that will fail the next real
      // publish attempt.
      await prisma.socialAccount
        .update({ where: { id: connection.socialAccountId }, data: { status: "ERROR", lastErrorMessage: message } })
        .catch((updateErr) => logger.error({ platformConnectionId, updateErr }, "token-refresh: failed to mark account ERROR"));
    }
  }
}
