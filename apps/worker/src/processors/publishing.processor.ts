import { prisma } from "@socialith/database";
import { loadEnv, resolveAssetStorageConfig, type Env } from "@socialith/config";
import { resolveAssetStorage } from "@socialith/video-engine";
import type { Job } from "bullmq";
import type { Prisma } from "@socialith/database";
import type { PublishingJobData } from "@socialith/types";
import { logger } from "../logger.js";
import { resolvePublishingProvider } from "../publishing/resolve-provider.js";
import { resolveAccessToken } from "../publishing/token.js";
import { enqueuePublishStatusPoll } from "../publishing/enqueue.js";
import { PublishError, type PublishErrorCode, type PublishInput, type PublishSuccess } from "../publishing/types.js";

/**
 * ContentAsset.url is a snapshot taken at upload/render time — fine for
 * the real local storage backend (never expires), but for R2 without a
 * public bucket it's a presigned URL good for only ~1 hour (see
 * packages/video-engine's R2AssetStorage.getDownloadUrl). A target
 * scheduled days out would otherwise hand the platform an already-expired
 * URL. Regenerates a fresh signed URL from the asset's real storage key
 * right before every publish attempt instead of trusting the stale
 * persisted one; a Phase 05 url-only asset (no storageKey — referencing
 * media that lives somewhere else entirely) and any local-storage asset
 * both pass through unchanged.
 */
async function resolveAssetUrl(env: Env, asset: { url: string; metadata: Prisma.JsonValue }): Promise<string> {
  const storageKey =
    asset.metadata && typeof asset.metadata === "object" && !Array.isArray(asset.metadata)
      ? (asset.metadata as Record<string, unknown>).storageKey
      : undefined;
  if (typeof storageKey !== "string") return asset.url;

  const storage = resolveAssetStorage(resolveAssetStorageConfig(env));
  if (storage.kind !== "r2") return asset.url;
  return storage.getDownloadUrl(storageKey);
}

const TARGET_INCLUDE = {
  content: { include: { variations: true, assets: true, sound: true } },
  socialAccount: { include: { platformConnection: true } },
} satisfies Prisma.ContentTargetInclude;

type TargetWithRelations = Prisma.ContentTargetGetPayload<{ include: typeof TARGET_INCLUDE }>;

interface Classified {
  code: PublishErrorCode;
  retryable: boolean;
  httpStatusCode?: number;
  message: string;
  responseMetadata?: Record<string, unknown>;
  rateLimitResetAt: Date | null;
}

function classify(err: unknown): Classified {
  if (err instanceof PublishError) {
    return {
      code: err.code,
      retryable: err.retryable,
      httpStatusCode: err.httpStatusCode,
      message: err.message,
      responseMetadata: err.responseMetadata,
      rateLimitResetAt: err.retryAfterMs ? new Date(Date.now() + err.retryAfterMs) : null,
    };
  }
  // An unexpected (non-PublishError) exception — a real bug, most likely.
  // Treated as retryable rather than permanent: a code defect shouldn't
  // silently stop retrying the way a genuine 4xx should, and BullMQ's own
  // attempts cap still bounds how many times this can happen.
  return {
    code: "PLATFORM_ERROR",
    retryable: true,
    message: err instanceof Error ? err.message : String(err),
    rateLimitResetAt: null,
  };
}

/** After a target reaches a terminal state, rolls Content.status up from its targets — PUBLISHED only if every target succeeded, FAILED if any did not. Exported for index.ts's "failed" handler, which reaches a terminal target state via a different path (BullMQ retry exhaustion) than this file's own permanent-failure branch. */
export async function maybeFinalizeContentStatus(contentId: string): Promise<void> {
  const remaining = await prisma.contentTarget.count({
    where: { contentId, status: { in: ["PENDING", "SCHEDULED", "PUBLISHING"] } },
  });
  if (remaining > 0) return;

  const failedCount = await prisma.contentTarget.count({ where: { contentId, status: "FAILED" } });
  await prisma.content.update({
    where: { id: contentId },
    data: { status: failedCount > 0 ? "FAILED" : "PUBLISHED" },
  });
}

async function recordSuccess(
  target: TargetWithRelations,
  attemptNumber: number,
  startedAt: Date,
  result: PublishSuccess,
): Promise<void> {
  const completedAt = new Date();
  // TikTok's real Direct Post flow: video/init/ only *initiates* the
  // post — PublishAttempt records this real, successful init call, but
  // the ContentTarget itself stays PUBLISHING (not PUBLISHED) until a
  // follow-up status poll confirms it — see
  // processors/publish-status-poll.processor.ts. Every other provider
  // (pendingConfirmation omitted) keeps the original immediate-PUBLISHED
  // behavior unchanged.
  const targetData = result.pendingConfirmation
    ? {
        externalPostId: result.externalPostId,
        externalPostUrl: result.externalPostUrl,
        attemptCount: attemptNumber,
        errorMessage: null,
      }
    : {
        status: "PUBLISHED" as const,
        publishedAt: completedAt,
        externalPostId: result.externalPostId,
        externalPostUrl: result.externalPostUrl,
        attemptCount: attemptNumber,
        errorMessage: null,
      };

  await prisma.$transaction([
    prisma.publishAttempt.create({
      data: {
        organizationId: target.content.organizationId,
        contentTargetId: target.id,
        attemptNumber,
        status: "SUCCEEDED",
        externalPostId: result.externalPostId,
        externalPostUrl: result.externalPostUrl,
        responseMetadata: result.responseMetadata as unknown as Prisma.InputJsonValue,
        startedAt,
        completedAt,
      },
    }),
    prisma.contentTarget.update({ where: { id: target.id }, data: targetData }),
    // Best-effort self-heal: a prior auth failure on this account no
    // longer applies once a publish through it has genuinely succeeded.
    prisma.socialAccount.updateMany({
      where: { id: target.socialAccountId, status: "ERROR" },
      data: { status: "CONNECTED", lastErrorMessage: null },
    }),
  ]);

  if (result.pendingConfirmation) {
    await enqueuePublishStatusPoll(target.id, 1);
    logger.info(
      { contentTargetId: target.id, externalPostId: result.externalPostId },
      "publishing: initiated, awaiting async confirmation",
    );
    return;
  }

  await maybeFinalizeContentStatus(target.contentId);
  logger.info(
    { contentTargetId: target.id, externalPostId: result.externalPostId },
    "publishing: succeeded",
  );
}

/** Returns true if the failure was permanent (no further retry) so the caller knows whether to re-throw for BullMQ. */
async function recordFailure(target: TargetWithRelations, attemptNumber: number, startedAt: Date, err: unknown): Promise<boolean> {
  const completedAt = new Date();
  const classified = classify(err);

  await prisma.$transaction([
    prisma.publishAttempt.create({
      data: {
        organizationId: target.content.organizationId,
        contentTargetId: target.id,
        attemptNumber,
        status: "FAILED",
        errorCode: classified.code,
        errorMessage: classified.message,
        httpStatusCode: classified.httpStatusCode,
        retryable: classified.retryable,
        responseMetadata: (classified.responseMetadata ?? null) as unknown as Prisma.InputJsonValue,
        rateLimitResetAt: classified.rateLimitResetAt,
        startedAt,
        completedAt,
      },
    }),
    prisma.contentTarget.update({
      where: { id: target.id },
      data: { attemptCount: attemptNumber, errorMessage: classified.message },
    }),
  ]);

  if (classified.code === "AUTH_ERROR") {
    await prisma.socialAccount
      .update({ where: { id: target.socialAccountId }, data: { status: "ERROR", lastErrorMessage: classified.message } })
      .catch((updateErr) => logger.error({ socialAccountId: target.socialAccountId, updateErr }, "publishing: failed to mark account ERROR"));
  }

  if (!classified.retryable) {
    await prisma.contentTarget.update({ where: { id: target.id }, data: { status: "FAILED" } });
    await maybeFinalizeContentStatus(target.contentId);
    logger.warn(
      { contentTargetId: target.id, code: classified.code, message: classified.message },
      "publishing: permanent failure, not retried",
    );
    return true;
  }

  logger.warn(
    { contentTargetId: target.id, code: classified.code, message: classified.message, attemptNumber },
    "publishing: retryable failure",
  );
  return false;
}

/**
 * Fires once per ContentTarget, enqueued by content-scheduling.processor.ts
 * (or a manual retry — see apps/api/src/services/content-target.service.ts)
 * once the target is in PUBLISHING status. Resolves a real access token
 * (refreshing if needed), calls the real platform adapter, and records
 * the outcome as an immutable PublishAttempt row plus the ContentTarget's
 * current status — never fabricates a PUBLISHED result.
 */
export async function processPublishing(job: Job<PublishingJobData>): Promise<void> {
  const { contentTargetId } = job.data;

  const target = await prisma.contentTarget.findUnique({ where: { id: contentTargetId }, include: TARGET_INCLUDE });
  if (!target) {
    logger.warn({ contentTargetId }, "publishing: target no longer exists, skipping");
    return;
  }
  if (target.status === "PUBLISHED" || target.status === "FAILED") {
    logger.warn({ contentTargetId, status: target.status }, "publishing: target already in a terminal state, skipping");
    return;
  }
  if (target.status !== "PUBLISHING") {
    logger.warn({ contentTargetId, status: target.status }, "publishing: target is not PUBLISHING, skipping");
    return;
  }

  const attemptNumber = target.attemptCount + 1;
  const startedAt = new Date();
  const env = loadEnv();

  let accessToken: string;
  try {
    accessToken = await resolveAccessToken(env, target.socialAccount, target.socialAccount.platformConnection);
  } catch (err) {
    const permanent = await recordFailure(target, attemptNumber, startedAt, err);
    if (!permanent) throw err;
    return;
  }

  const variation = target.content.variations.find((v) => v.platform === target.socialAccount.platform) ?? null;
  const relevantAssets = [
    ...target.content.assets.filter((a) => a.platform === target.socialAccount.platform),
    ...target.content.assets.filter((a) => a.platform === null),
  ];

  const assetsWithFreshUrls = await Promise.all(
    relevantAssets.map(async (a) => ({ type: a.type, url: await resolveAssetUrl(env, a), platform: a.platform })),
  );

  const input: PublishInput = {
    contentId: target.contentId,
    contentTargetId: target.id,
    socialAccountId: target.socialAccountId,
    externalAccountId: target.socialAccount.externalAccountId,
    accessToken,
    caption: variation?.caption ?? target.content.caption,
    title: variation?.title ?? null,
    assets: assetsWithFreshUrls,
    sound: target.content.sound
      ? {
          title: target.content.sound.title,
          artist: target.content.sound.artist,
          externalSoundId: target.content.sound.externalSoundId,
          soundUrl: target.content.sound.soundUrl,
        }
      : null,
  };

  const provider = resolvePublishingProvider(target.socialAccount.platform);
  try {
    const result = await provider.publish(input);
    await recordSuccess(target, attemptNumber, startedAt, result);
  } catch (err) {
    const permanent = await recordFailure(target, attemptNumber, startedAt, err);
    if (!permanent) throw err; // let BullMQ's attempts/backoff retry a genuinely transient failure
  }
}
