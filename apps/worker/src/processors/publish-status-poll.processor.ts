import { prisma } from "@socialith/database";
import { loadEnv } from "@socialith/config";
import type { Job } from "bullmq";
import type { Prisma } from "@socialith/database";
import type { PublishStatusPollJobData } from "@socialith/types";
import { logger } from "../logger.js";
import { resolvePublishingProvider } from "../publishing/resolve-provider.js";
import { resolveAccessToken } from "../publishing/token.js";
import { enqueuePublishStatusPoll } from "../publishing/enqueue.js";
import { PublishError } from "../publishing/types.js";
import { maybeFinalizeContentStatus } from "./publishing.processor.js";
import { getUploadPostClient } from "../upload-post/client.js";
import { pollUploadPostTarget } from "../upload-post/publish.js";

const TARGET_INCLUDE = {
  content: { select: { id: true, organizationId: true } },
  socialAccount: { include: { platformConnection: true } },
} satisfies Prisma.ContentTargetInclude;

/** Real bound on how long a target can stay PUBLISHING waiting for TikTok — 20 attempts * 15s interval ≈ 5 minutes, generous for TikTok's own documented processing time while never polling forever on a genuinely stuck publish_id. */
const MAX_POLL_ATTEMPTS = 20;

/** Upload-Post uploads can legitimately take longer (async transcode + platform processing): 120 polls * 15 s = 30 minutes. After that this job stops; the Upload-Post sweep keeps reconciling the publication until the provider reports a final state (it fails a job with no activity after 1 h), so nothing is abandoned. */
const UPLOAD_POST_MAX_POLL_ATTEMPTS = 120;

/**
 * Fires once per poll for a ContentTarget whose provider returned
 * PublishSuccess.pendingConfirmation (today: TikTok only — see
 * tiktok.provider.ts's checkPublishStatus). Either finalizes the target
 * (PUBLISHED/FAILED) or re-enqueues itself with the next attempt number,
 * via apps/worker/src/publishing/enqueue.ts's enqueuePublishStatusPoll —
 * never blocks a worker slot waiting, unlike a naive polling loop would.
 */
export async function processPublishStatusPoll(job: Job<PublishStatusPollJobData>): Promise<void> {
  const { contentTargetId, attempt } = job.data;

  const target = await prisma.contentTarget.findUnique({ where: { id: contentTargetId }, include: TARGET_INCLUDE });
  if (!target) {
    logger.warn({ contentTargetId }, "publish-status-poll: target no longer exists, skipping");
    return;
  }
  if (target.status !== "PUBLISHING") {
    logger.warn(
      { contentTargetId, status: target.status },
      "publish-status-poll: target is no longer PUBLISHING (already finalized elsewhere), skipping",
    );
    return;
  }
  if (!target.externalPostId) {
    logger.error({ contentTargetId }, "publish-status-poll: target has no provisional externalPostId, cannot poll");
    return;
  }

  if (target.socialAccount.publishingProvider === "UPLOAD_POST") {
    const state = await pollUploadPostTarget(prisma, getUploadPostClient(loadEnv()), target.id);
    if (state === "done") {
      logger.info({ contentTargetId }, "publish-status-poll: Upload-Post publication reached a final state");
      return;
    }
    if (attempt >= UPLOAD_POST_MAX_POLL_ATTEMPTS) {
      logger.warn({ contentTargetId, attempt }, "publish-status-poll: Upload-Post still processing; polling stops, the sweep keeps reconciling");
      return;
    }
    await enqueuePublishStatusPoll(target.id, attempt + 1);
    return;
  }
  const provider = resolvePublishingProvider(target.socialAccount.platform);
  if (!provider.checkPublishStatus) {
    // Defensive only — nothing enqueues a poll for a provider that never
    // returns pendingConfirmation, so this should be unreachable.
    logger.error({ contentTargetId, platform: target.socialAccount.platform }, "publish-status-poll: provider has no checkPublishStatus, skipping");
    return;
  }

  const env = loadEnv();
  const accessToken = await resolveAccessToken(env, target.socialAccount, target.socialAccount.platformConnection);
  const result = await provider.checkPublishStatus(accessToken, target.externalPostId);

  if (result.status === "COMPLETE") {
    const completedAt = new Date();
    await prisma.contentTarget.update({
      where: { id: target.id },
      data: {
        status: "PUBLISHED",
        publishedAt: completedAt,
        externalPostId: result.externalPostId ?? target.externalPostId,
        externalPostUrl: result.externalPostUrl ?? target.externalPostUrl,
        deliveryNote: result.deliveryNote ?? null,
        errorMessage: null,
      },
    });
    await maybeFinalizeContentStatus(target.content.id);
    logger.info(
      { contentTargetId, externalPostId: result.externalPostId, deliveryNote: result.deliveryNote },
      "publish-status-poll: confirmed COMPLETE",
    );
    return;
  }

  if (result.status === "FAILED") {
    await prisma.contentTarget.update({
      where: { id: target.id },
      data: { status: "FAILED", errorMessage: result.failReason ?? "Publish failed (confirmed by status poll)." },
    });
    await maybeFinalizeContentStatus(target.content.id);
    logger.warn({ contentTargetId, failReason: result.failReason }, "publish-status-poll: confirmed FAILED");
    return;
  }

  // Still PROCESSING.
  if (attempt >= MAX_POLL_ATTEMPTS) {
    await prisma.contentTarget.update({
      where: { id: target.id },
      data: {
        status: "FAILED",
        errorMessage:
          "TikTok did not confirm this publish within the expected time. It may have completed on TikTok's side — check the account directly; Socialith stopped polling after the real, bounded retry window.",
      },
    });
    await maybeFinalizeContentStatus(target.content.id);
    logger.error({ contentTargetId, attempt }, "publish-status-poll: gave up after MAX_POLL_ATTEMPTS, marked FAILED");
    return;
  }

  await enqueuePublishStatusPoll(target.id, attempt + 1);
  logger.info({ contentTargetId, attempt: attempt + 1 }, "publish-status-poll: still processing, re-polling");
}

/** Marks a target FAILED after BullMQ exhausts this queue's own attempts (a real, transient HTTP failure on every retry) — mirrors publishing.processor.ts's index.ts "failed" handler pattern. Exported for apps/worker/src/index.ts. */
export async function recordPublishStatusPollFailure(contentTargetId: string, err: unknown): Promise<void> {
  const message = err instanceof PublishError ? err.message : err instanceof Error ? err.message : String(err);
  await prisma.contentTarget
    .updateMany({
      where: { id: contentTargetId, status: "PUBLISHING" },
      data: { status: "FAILED", errorMessage: `Status confirmation failed: ${message}` },
    })
    .then(async (result) => {
      if (result.count > 0) {
        const target = await prisma.contentTarget.findUnique({ where: { id: contentTargetId }, select: { contentId: true } });
        if (target) await maybeFinalizeContentStatus(target.contentId);
      }
    })
    .catch((updateErr) => logger.error({ contentTargetId, updateErr }, "publish-status-poll: failed to record final FAILED state"));
}
