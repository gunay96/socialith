import { prisma } from "@socialith/database";
import { loadEnv, type Env } from "@socialith/config";
import { INTEGRATION_ORGANIZATION_MESSAGES, resolveIntegrationOrganization, UploadPostError } from "@socialith/upload-post";
import type { Job } from "bullmq";
import type { UploadPostJobData } from "@socialith/types";
import { logger } from "../logger.js";
import { assetUrlsAreDurable, resolveAssetUrl } from "../publishing/assets.js";
import { getUploadPostClient } from "../upload-post/client.js";
import { applyProviderStatus } from "../upload-post/status.js";
import { sweepUploadPost, type SweepConfig, type SweepMaterial } from "../upload-post/sweep.js";
import { syncUploadPostProfiles } from "../upload-post/sync.js";

/** One long-lived unconfirmed window for provider-run publications (see sweep.ts). */
const UNCONFIRMED_AFTER_MS = 6 * 3_600_000;
const MIN_HANDOFF_LEAD_MS = 10 * 60_000;

export function buildSweepConfig(env: Pick<Env, "UPLOAD_POST_SCHEDULE_HANDOFF_ENABLED" | "UPLOAD_POST_SCHEDULE_HANDOFF_WINDOW_HOURS">): SweepConfig {
  return {
    handoffEnabled: env.UPLOAD_POST_SCHEDULE_HANDOFF_ENABLED,
    handoffWindowMs: env.UPLOAD_POST_SCHEDULE_HANDOFF_WINDOW_HOURS * 3_600_000,
    minLeadMs: MIN_HANDOFF_LEAD_MS,
    unconfirmedAfterMs: UNCONFIRMED_AFTER_MS,
  };
}

async function integrationOrganizationId(env: Env): Promise<string | null> {
  const orgs = await prisma.organization.findMany({ where: { status: "ACTIVE" }, select: { id: true }, take: 3 });
  const resolved = resolveIntegrationOrganization(orgs.map((o) => o.id), env.UPLOAD_POST_ORGANIZATION_ID);
  if (!resolved.ok) {
    logger.warn({ reason: resolved.reason }, `upload-post: ${INTEGRATION_ORGANIZATION_MESSAGES[resolved.reason]}`);
    return null;
  }
  return resolved.organizationId;
}

async function resolveMaterial(env: Env, targetId: string): Promise<SweepMaterial | null> {
  const target = await prisma.contentTarget.findUnique({
    where: { id: targetId },
    include: { content: { include: { variations: true, assets: true } }, socialAccount: { select: { platform: true } } },
  });
  if (!target) return null;
  const platform = target.socialAccount.platform;
  const variation = target.content.variations.find((v) => v.platform === platform) ?? null;
  const relevant = [...target.content.assets.filter((a) => a.platform === platform), ...target.content.assets.filter((a) => a.platform === null)];
  const assets = await Promise.all(relevant.map(async (a) => ({ type: a.type, url: await resolveAssetUrl(env, a) })));
  return { caption: variation?.caption ?? target.content.caption, title: variation?.title ?? null, assets, durable: assetUrlsAreDurable(env) };
}

/** Processor for QUEUE_NAMES.UPLOAD_POST: sync, sweep and webhook-triggered reconcile jobs. A missing API key is "not configured", never an error loop. */
export async function processUploadPost(job: Job<UploadPostJobData>): Promise<void> {
  const env = loadEnv();
  const client = getUploadPostClient(env);
  if (!client) {
    logger.debug({ kind: job.data.kind }, "upload-post: not configured (no API key); skipping");
    return;
  }

  switch (job.data.kind) {
    case "sync": {
      const organizationId = job.data.organizationId ?? (await integrationOrganizationId(env));
      if (!organizationId) return;
      await syncUploadPostProfiles({ db: prisma, client }, organizationId, job.data.trigger);
      return;
    }
    case "sweep": {
      await sweepUploadPost({ db: prisma, client, config: buildSweepConfig(env), resolveMaterial: (t) => resolveMaterial(env, t.id) });
      return;
    }
    case "reconcile": {
      const { requestId, jobId, externalId } = job.data;
      const publication = await prisma.uploadPostPublication.findFirst({
        where: {
          OR: [
            ...(externalId ? [{ externalId }] : []),
            ...(requestId ? [{ requestId }] : []),
            ...(jobId ? [{ providerJobId: jobId }] : []),
          ],
        },
      });
      if (!publication) {
        logger.info({ requestId, jobId, hasExternalId: Boolean(externalId) }, "upload-post reconcile: no matching publication (not ours or already removed)");
        return;
      }
      try {
        // The webhook payload is only a hint: the authoritative status is re-read before anything changes.
        const status = await client.getStatus(publication.providerJobId && publication.mode === "PROVIDER_SCHEDULED" ? { jobId: publication.providerJobId } : { requestId: publication.requestId });
        await applyProviderStatus(prisma, { id: publication.id, contentTargetId: publication.contentTargetId, platform: publication.platform, status: publication.status }, status);
      } catch (err) {
        if (err instanceof UploadPostError && !err.retryable) {
          logger.warn({ publicationId: publication.id, kind: err.kind }, "upload-post reconcile: status lookup failed permanently");
          return;
        }
        throw err; // retryable: BullMQ retries
      }
      return;
    }
  }
}
