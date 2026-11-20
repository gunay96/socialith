import { prisma } from "@socialith/database";
import { loadEnv } from "@socialith/config";
import type { Job } from "bullmq";
import type { Prisma } from "@socialith/database";
import type { PublishingJobData } from "@socialith/types";
import { logger } from "../logger.js";
import { resolvePublishingProvider } from "../publishing/resolve-provider.js";
import { resolveAccessToken } from "../publishing/token.js";
import { enqueuePublishStatusPoll } from "../publishing/enqueue.js";
import { resolveAssetUrl } from "../publishing/assets.js";
import { finalizeContentStatus } from "../publishing/finalize.js";
import { evaluateApprovalGate } from "../publishing/approval-gate.js";
import { effectiveText } from "@socialith/publishing";
import { getUploadPostClient, toPublishError } from "../upload-post/client.js";
import { publishViaUploadPost } from "../upload-post/publish.js";
import { DEMO_ACCOUNT_PUBLISH_MESSAGE, isDemoAccount } from "../publishing/demo-guard.js";
import { PublishError, type PublishErrorCode, type PublishInput, type PublishSuccess } from "../publishing/types.js";

const TARGET_INCLUDE = {
  content: { include: { variations: true, assets: true, sound: true } },
  socialAccount: { include: { platformConnection: true, uploadPostAccount: { include: { profile: true } } } },
} satisfies Prisma.ContentTargetInclude;

type TargetWithRelations = Prisma.ContentTargetGetPayload<{ include: typeof TARGET_INCLUDE }>;

/** The text actually sent for one destination: its own text wins, then the platform variation, then the base caption (same rule as the approval payload). */
function textFor(target: TargetWithRelations, variation: { caption: string | null; title: string | null } | null): { caption: string | null; title: string | null } {
  return effectiveText({ captionOverride: target.captionOverride, titleOverride: target.titleOverride, variationCaption: variation?.caption ?? null, variationTitle: variation?.title ?? null, contentCaption: target.content.caption });
}

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
  await finalizeContentStatus(prisma, contentId);
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

  // Demo/seed accounts have fake credentials and must never reach a real
  // platform API, however the target got here (schedule, retry, recovery).
  if (isDemoAccount(target.socialAccount.providerMetadata)) {
    await recordFailure(
      target,
      attemptNumber,
      startedAt,
      new PublishError(DEMO_ACCOUNT_PUBLISH_MESSAGE, "CONFIGURATION_ERROR", false),
    );
    return;
  }

  // Phase 3 approval gate: when the organization requires approval, only an APPROVED publication whose content is
  // unchanged since approval may reach a provider — whichever path got it here (schedule, retry, recovery).
  const gate = await evaluateApprovalGate(prisma, contentTargetId);
  if (!gate.ok) {
    await recordFailure(target, attemptNumber, startedAt, new PublishError(gate.message, "CONFIGURATION_ERROR", false));
    return;
  }

  // Phase 2: destinations published through Upload-Post have no native OAuth token. They follow the
  // same recording path (PublishAttempt rows, retry classification) but call the provider adapter.
  if (target.socialAccount.publishingProvider === "UPLOAD_POST") {
    const variation = target.content.variations.find((v) => v.platform === target.socialAccount.platform) ?? null;
    const relevant = [
      ...target.content.assets.filter((a) => a.platform === target.socialAccount.platform),
      ...target.content.assets.filter((a) => a.platform === null),
    ];
    try {
      const assets = await Promise.all(relevant.map(async (a) => ({ type: a.type, url: await resolveAssetUrl(env, a) })));
      const result = await publishViaUploadPost({
        db: prisma,
        client: getUploadPostClient(env),
        target,
        ...textFor(target, variation),
        assets,
      });
      await recordSuccess(target, attemptNumber, startedAt, result);
    } catch (err) {
      const permanent = await recordFailure(target, attemptNumber, startedAt, toPublishError(err));
      if (!permanent) throw err;
    }
    return;
  }
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
    ...textFor(target, variation),
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
