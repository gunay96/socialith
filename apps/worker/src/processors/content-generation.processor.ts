import { prisma } from "@socialith/database";
import { loadEnv } from "@socialith/config";
import type { Job } from "bullmq";
import type { Prisma } from "@socialith/database";
import { ERROR_CODES } from "@socialith/types";
import type { ContentGenerationJobData } from "@socialith/types";
import { resolveAiProvider, AiProviderRateLimitError } from "../ai/provider.js";
import { logger } from "../logger.js";

/**
 * Fires once per content-generation job. Real work: call the configured
 * AI provider for a caption + hashtags, then write the result to either
 * Content.caption (platform-less request) or the matching
 * ContentVariation (platform-scoped request).
 *
 * Without AI_PROVIDER_API_KEY configured, this is a genuine, permanent
 * failure — resolveAiProvider returns null, the job row is marked FAILED
 * with a clear reason, and this function returns normally (no throw) so
 * BullMQ does NOT retry a failure that retrying can never fix. A real
 * provider error (network, bad response) instead throws, so BullMQ's
 * attempts/backoff (see apps/api/src/lib/queue.ts) retries it; only once
 * attempts are exhausted does the worker's "failed" handler
 * (apps/worker/src/index.ts) mark the row FAILED for that case.
 */
export async function processContentGeneration(job: Job<ContentGenerationJobData>): Promise<void> {
  const { jobRowId } = job.data;

  const jobRow = await prisma.contentGenerationJob.findUnique({
    where: { id: jobRowId },
    include: { content: { select: { id: true, caption: true } } },
  });
  if (!jobRow) {
    logger.warn({ jobRowId }, "content-generation: job row no longer exists, skipping");
    return;
  }
  if (jobRow.status === "SUCCEEDED" || jobRow.status === "FAILED") {
    logger.warn({ jobRowId, status: jobRow.status }, "content-generation: job already in a terminal state, skipping");
    return;
  }

  await prisma.contentGenerationJob.update({
    where: { id: jobRowId },
    data: { status: "PROCESSING", attempts: { increment: 1 }, startedAt: new Date() },
  });

  const env = loadEnv();
  const provider = resolveAiProvider(env);
  if (!provider) {
    await prisma.contentGenerationJob.update({
      where: { id: jobRowId },
      data: {
        status: "FAILED",
        errorMessage: "AI_PROVIDER_API_KEY is not configured — cannot generate content.",
        errorCode: ERROR_CODES.CONFIGURATION_ERROR,
        completedAt: new Date(),
      },
    });
    logger.warn({ jobRowId }, "content-generation: no AI provider configured, job marked FAILED (permanent, not retried)");
    return;
  }

  try {
    let existingCaption = jobRow.content.caption;
    if (jobRow.platform) {
      const variation = await prisma.contentVariation.findUnique({
        where: { contentId_platform: { contentId: jobRow.contentId, platform: jobRow.platform } },
      });
      existingCaption = variation?.caption ?? existingCaption;
    }

    const result = await provider.generateCaption({ existingCaption, platform: jobRow.platform });

    let resultVariationId: string | null = null;
    if (jobRow.platform) {
      const variation = await prisma.contentVariation.upsert({
        where: { contentId_platform: { contentId: jobRow.contentId, platform: jobRow.platform } },
        update: { caption: result.caption, metadata: { hashtags: result.hashtags } },
        create: {
          contentId: jobRow.contentId,
          platform: jobRow.platform,
          caption: result.caption,
          metadata: { hashtags: result.hashtags },
        },
      });
      resultVariationId = variation.id;
    } else {
      await prisma.content.update({ where: { id: jobRow.contentId }, data: { caption: result.caption } });
    }

    await prisma.contentGenerationJob.update({
      where: { id: jobRowId },
      data: {
        status: "SUCCEEDED",
        resultVariationId,
        errorMessage: null,
        errorCode: null,
        usageMetadata: (result.usage ?? undefined) as unknown as Prisma.InputJsonValue,
        completedAt: new Date(),
      },
    });
    logger.info({ jobRowId, platform: jobRow.platform, usage: result.usage }, "content-generation: succeeded");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const errorCode = err instanceof AiProviderRateLimitError ? ERROR_CODES.RATE_LIMITED : null;
    await prisma.contentGenerationJob
      .update({ where: { id: jobRowId }, data: { errorMessage: message, errorCode } })
      .catch(() => {});
    throw err; // let BullMQ's attempts/backoff retry a genuinely transient failure
  }
}
