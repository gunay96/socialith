import { prisma } from "@socialith/database";
import { loadEnv } from "@socialith/config";
import type { Job } from "bullmq";
import type { Prisma } from "@socialith/database";
import type { AnalyticsSyncJobData } from "@socialith/types";
import { logger } from "../logger.js";
import { resolveAnalyticsProvider } from "../analytics/resolve-provider.js";
import { resolveAccessToken } from "../publishing/token.js";

const TARGET_INCLUDE = {
  socialAccount: { include: { platformConnection: true } },
} satisfies Prisma.ContentTargetInclude;

/**
 * Fires per ContentTarget from either trigger: a manual "sync now"
 * (apps/api/src/services/content-target.service.ts's syncAnalytics) or
 * the production automation this phase adds — a repeatable scan
 * (processors/analytics-sync-scan.processor.ts) that fans out this same
 * job for targets due a re-sync. Only meaningful for a target that
 * genuinely has a real published post to look up; anything else is
 * logged and skipped, not retried. Reuses the exact same
 * resolveAccessToken() the publishing pipeline uses, including real
 * token refresh — same CONFIGURATION_ERROR-first-before-any-network-call
 * behavior when there's no real platform credential.
 */
export async function processAnalyticsSync(job: Job<AnalyticsSyncJobData>): Promise<void> {
  const { contentTargetId } = job.data;

  const target = await prisma.contentTarget.findUnique({ where: { id: contentTargetId }, include: TARGET_INCLUDE });
  if (!target) {
    logger.warn({ contentTargetId }, "analytics-sync: target no longer exists, skipping");
    return;
  }
  if (target.status !== "PUBLISHED" || !target.externalPostId) {
    logger.warn(
      { contentTargetId, status: target.status },
      "analytics-sync: target has no real published post to sync, skipping",
    );
    return;
  }

  // Stamped at the start of every real attempt (success or failure) — see
  // schema.prisma's comment on this field: this is what lets the scan
  // above space out re-syncs instead of retrying a permanently-broken
  // target every single scan tick.
  await prisma.contentTarget.update({ where: { id: target.id }, data: { lastAnalyticsSyncAt: new Date() } }).catch(() => {});

  const env = loadEnv();
  let accessToken: string;
  try {
    accessToken = await resolveAccessToken(env, target.socialAccount, target.socialAccount.platformConnection);
  } catch (err) {
    logger.warn(
      { contentTargetId, err: err instanceof Error ? err.message : String(err) },
      "analytics-sync: could not resolve an access token, skipping",
    );
    return;
  }

  const provider = resolveAnalyticsProvider(target.socialAccount.platform);
  try {
    const metrics = await provider.fetchMetrics({
      externalPostId: target.externalPostId,
      externalAccountId: target.socialAccount.externalAccountId,
      accessToken,
    });

    await prisma.postMetricsSnapshot.create({
      data: {
        organizationId: target.socialAccount.organizationId,
        contentTargetId: target.id,
        platform: target.socialAccount.platform,
        viewCount: metrics.viewCount,
        likeCount: metrics.likeCount,
        commentCount: metrics.commentCount,
        shareCount: metrics.shareCount,
        raw: metrics.raw as unknown as Prisma.InputJsonValue,
      },
    });
    logger.info({ contentTargetId, ...metrics, raw: undefined }, "analytics-sync: succeeded");
  } catch (err) {
    logger.warn(
      { contentTargetId, err: err instanceof Error ? err.message : String(err) },
      "analytics-sync: metrics fetch failed",
    );
    // No retry/backoff here (unlike publishing): a metrics-fetch failure
    // is never permanent-vs-transient time-critical the way a publish
    // attempt is, and the trigger is manually re-clickable — see this
    // file's class doc.
  }
}
