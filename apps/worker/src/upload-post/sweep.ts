import type { PrismaClient } from "@socialith/database";
import { UploadPostError, type UploadPostClient } from "@socialith/upload-post";
import { finalizeContentStatus } from "../publishing/finalize.js";
import { evaluateApprovalGate } from "../publishing/approval-gate.js";
import { logger as defaultLogger } from "../logger.js";
import { PublishError } from "../publishing/types.js";
import { applyProviderStatus } from "./status.js";
import {
  assertDestinationReady,
  buildPlatformFields,
  chooseMedia,
  externalIdFor,
  requestIdFor,
  requiredMusicProblem,
  resolveTikTokMusic,
  type UploadPostTarget,
} from "./publish.js";

/**
 * The Upload-Post sweep (BullMQ repeatable, every minute) — three jobs, all idempotent, all driven by the DATABASE:
 *
 *  1. resolve hand-offs whose outcome is unknown (adopt the provider job found by external_id, or release the target);
 *  2. drift: a provider-scheduled target whose Socialith schedule changed (rescheduled / cancelled / moved out of
 *     the window) is edited or cancelled at the provider — Socialith's database stays the master;
 *  3. status: in-flight publications are reconciled with the provider's authoritative status (the polling and the
 *     webhook paths converge on the same function);
 *  4. hand-off (only when enabled): targets due within the controlled window are given to the provider's scheduler.
 *
 * A target is never scheduled in both systems: see scheduling/ownership.ts for how every Socialith mechanism skips
 * provider-owned targets. Any doubt resolves in favour of Socialith owning the target (the hand-off is released),
 * never in favour of publishing twice.
 */
export interface SweepConfig {
  handoffEnabled: boolean;
  /** Only targets due within this window ahead are handed off. */
  handoffWindowMs: number;
  /** Never hand off closer to the due time than this (the provider refuses edits within 60 s of a run). */
  minLeadMs: number;
  /** A scheduled/processing publication still unresolved this long after it was due is failed as unconfirmed. */
  unconfirmedAfterMs: number;
}

export interface SweepSummary {
  handoffsResolved: number;
  driftCancelled: number;
  driftRescheduled: number;
  statusChecked: number;
  statusFinalized: number;
  unconfirmedFailed: number;
  handedOff: number;
  handoffSkipped: number;
}

export interface SweepMaterial {
  caption: string | null;
  title: string | null;
  assets: { type: string; url: string }[];
  /** False when a presigned (short-lived) URL would be handed to a provider that fetches later. */
  durable: boolean;
}

export interface SweepDeps {
  db: PrismaClient;
  client: UploadPostClient;
  config: SweepConfig;
  /** Fresh asset URLs for a target (and whether they are durable). Provided by the worker (storage-aware). */
  resolveMaterial: (target: { id: string }) => Promise<SweepMaterial | null>;
  now?: () => Date;
  log?: Pick<typeof defaultLogger, "info" | "warn">;
}

const STATUS_STALE_MS = 30_000;
const PENDING_STUCK_MS = 2 * 60_000;
const BATCH = 100;

export async function sweepUploadPost(deps: SweepDeps): Promise<SweepSummary> {
  const { db, client, config } = deps;
  const log = deps.log ?? defaultLogger;
  const now = (deps.now ?? (() => new Date()))();
  const summary: SweepSummary = {
    handoffsResolved: 0,
    driftCancelled: 0,
    driftRescheduled: 0,
    statusChecked: 0,
    statusFinalized: 0,
    unconfirmedFailed: 0,
    handedOff: 0,
    handoffSkipped: 0,
  };

  // 1. unknown / stuck hand-offs ---------------------------------------------------------------
  const stuck = await db.uploadPostPublication.findMany({
    where: {
      mode: "PROVIDER_SCHEDULED",
      OR: [{ status: "UNKNOWN_OUTCOME" }, { status: "PENDING", updatedAt: { lt: new Date(now.getTime() - PENDING_STUCK_MS) } }],
    },
    take: BATCH,
  });
  for (const pub of stuck) {
    try {
      const list = await client.listScheduled({ profile: pub.profileUsername, limit: 100 });
      const job = list.jobs.find((j) => j.externalId === pub.externalId);
      if (job) {
        await db.uploadPostPublication.update({ where: { id: pub.id }, data: { status: "SCHEDULED_AT_PROVIDER", providerJobId: job.jobId, handedOffAt: pub.handedOffAt ?? now, lastSyncedAt: now } });
        log.info({ publicationId: pub.id, jobId: job.jobId }, "upload-post sweep: adopted a hand-off whose outcome had been unknown");
      } else {
        await db.uploadPostPublication.update({ where: { id: pub.id }, data: { status: "CANCELLED", lastErrorKind: "HANDOFF_RELEASED", lastErrorMessage: "The hand-off never reached the provider; the target is owned by Socialith again." } });
        log.info({ publicationId: pub.id }, "upload-post sweep: released an unconfirmed hand-off back to Socialith");
      }
      summary.handoffsResolved++;
    } catch (err) {
      log.warn({ publicationId: pub.id, err: err instanceof Error ? err.message : String(err) }, "upload-post sweep: could not resolve a hand-off yet");
    }
  }

  // 2. drift on provider-owned schedules --------------------------------------------------------
  const scheduled = await db.uploadPostPublication.findMany({
    where: { status: "SCHEDULED_AT_PROVIDER", providerJobId: { not: null } },
    include: { contentTarget: { select: { id: true, status: true, scheduledAt: true, content: { select: { id: true, status: true, scheduledAt: true } } } } },
    take: BATCH,
  });
  for (const pub of scheduled) {
    const target = pub.contentTarget;
    const content = target.content;
    const jobId = pub.providerJobId!;
    const dueInFlight = pub.scheduledFor !== null && pub.scheduledFor.getTime() <= now.getTime();
    if (dueInFlight) continue; // the provider is running it (or ran it): status sync below decides

    // Phase 3: a target has its own time; the content's time is only the fallback for a target that has none.
    const at = target.scheduledAt ?? content.scheduledAt;
    const release =
      target.status !== "SCHEDULED" ||
      !["SCHEDULED", "PUBLISHING"].includes(content.status) ||
      !at ||
      at.getTime() - now.getTime() < config.minLeadMs ||
      at.getTime() - now.getTime() > config.handoffWindowMs;

    try {
      if (release) {
        await client.cancelScheduled(jobId); // already gone is fine
        await db.uploadPostPublication.update({ where: { id: pub.id }, data: { status: "CANCELLED", lastErrorKind: "SCHEDULE_CHANGED", lastErrorMessage: "Cancelled at the provider because the Socialith schedule changed.", lastSyncedAt: now } });
        summary.driftCancelled++;
        log.info({ publicationId: pub.id, jobId }, "upload-post sweep: cancelled a provider schedule (Socialith schedule changed)");
      } else if (at && pub.scheduledFor && Math.abs(at.getTime() - pub.scheduledFor.getTime()) > 1_000) {
        await client.editScheduled(jobId, { scheduledDate: at.toISOString(), timezone: "UTC" });
        await db.uploadPostPublication.update({ where: { id: pub.id }, data: { scheduledFor: at, lastSyncedAt: now } });
        summary.driftRescheduled++;
        log.info({ publicationId: pub.id, jobId }, "upload-post sweep: rescheduled the provider job to the new Socialith time");
      }
    } catch (err) {
      // 409 scheduled_post_in_progress and transient errors: leave it, the next sweep / status sync decides.
      log.warn({ publicationId: pub.id, kind: err instanceof UploadPostError ? err.kind : "ERROR" }, "upload-post sweep: drift action deferred");
    }
  }

  // 3. status reconciliation ------------------------------------------------------------------
  const staleBefore = new Date(now.getTime() - STATUS_STALE_MS);
  const inflight = await db.uploadPostPublication.findMany({
    where: {
      OR: [
        { status: { in: ["PROCESSING", "UNKNOWN_OUTCOME"] }, mode: "IMMEDIATE" },
        { status: "PENDING", mode: "IMMEDIATE", submittedAt: { not: null, lt: new Date(now.getTime() - PENDING_STUCK_MS) } },
        { status: "SCHEDULED_AT_PROVIDER", scheduledFor: { lte: now } },
        { status: "PROCESSING", mode: "PROVIDER_SCHEDULED" },
      ],
      AND: [{ OR: [{ lastSyncedAt: null }, { lastSyncedAt: { lt: staleBefore } }] }],
    },
    orderBy: { lastSyncedAt: "asc" },
    take: BATCH,
  });
  for (const pub of inflight) {
    summary.statusChecked++;
    try {
      const byJob = pub.mode === "PROVIDER_SCHEDULED" && pub.providerJobId;
      const status = await client.getStatus(byJob ? { jobId: pub.providerJobId! } : { requestId: pub.requestId });
      const outcome = await applyProviderStatus(db, { id: pub.id, contentTargetId: pub.contentTargetId, platform: pub.platform, status: pub.status }, status, now);
      if (outcome.kind === "COMPLETED" || outcome.kind === "FAILED") {
        summary.statusFinalized++;
        continue;
      }
      const reference = pub.scheduledFor ?? pub.submittedAt ?? pub.createdAt;
      if (now.getTime() - reference.getTime() > config.unconfirmedAfterMs) {
        const reason = "Upload-Post did not confirm this publication within the expected time. It may have completed on the platform — check the account; Socialith stopped waiting.";
        await db.$transaction(async (tx) => {
          await tx.uploadPostPublication.update({ where: { id: pub.id }, data: { status: "FAILED", completedAt: now, lastErrorKind: "UNCONFIRMED", lastErrorMessage: reason } });
          await tx.contentTarget.updateMany({ where: { id: pub.contentTargetId, status: { in: ["PUBLISHING", "SCHEDULED"] } }, data: { status: "FAILED", errorMessage: reason } });
        });
        const t = await db.contentTarget.findUnique({ where: { id: pub.contentTargetId }, select: { contentId: true } });
        if (t) await finalizeContentStatus(db, t.contentId);
        summary.unconfirmedFailed++;
      } else {
        await db.uploadPostPublication.update({ where: { id: pub.id }, data: { lastSyncedAt: now } });
      }
    } catch (err) {
      log.warn({ publicationId: pub.id, kind: err instanceof UploadPostError ? err.kind : "ERROR" }, "upload-post sweep: status check deferred");
    }
  }

  // 4. controlled hand-off ---------------------------------------------------------------------
  if (config.handoffEnabled) {
    const candidates = await db.contentTarget.findMany({
      where: {
        status: "SCHEDULED",
        socialAccount: { publishingProvider: "UPLOAD_POST" },
        content: { status: "SCHEDULED" },
        // the target's own time decides (Phase 3); a target without one falls back to its content's time
        AND: [
          {
            OR: [
              { scheduledAt: { gte: new Date(now.getTime() + config.minLeadMs), lte: new Date(now.getTime() + config.handoffWindowMs) } },
              { scheduledAt: null, content: { scheduledAt: { gte: new Date(now.getTime() + config.minLeadMs), lte: new Date(now.getTime() + config.handoffWindowMs) } } },
            ],
          },
          { OR: [{ uploadPostPublication: { is: null } }, { uploadPostPublication: { is: { status: "CANCELLED" } } }] },
        ],
      },
      include: {
        content: { select: { organizationId: true, soundId: true, scheduledAt: true } },
        socialAccount: { include: { uploadPostAccount: { include: { profile: true } } } },
        uploadPostPublication: true,
      },
      take: 50,
    });
    for (const target of candidates) {
      const outcome = await handOff(deps, target as unknown as UploadPostTarget & { scheduledAt: Date | null; content: { scheduledAt: Date | null }; uploadPostPublication: { id: string; generation: number } | null }, now);
      if (outcome === "HANDED_OFF") summary.handedOff++;
      else if (outcome === "RATE_LIMITED") break;
      else summary.handoffSkipped++;
    }
  }

  return summary;
}

async function handOff(
  deps: SweepDeps,
  target: UploadPostTarget & { scheduledAt: Date | null; content: { scheduledAt: Date | null }; uploadPostPublication: { id: string; generation: number } | null },
  now: Date,
): Promise<"HANDED_OFF" | "SKIPPED" | "RATE_LIMITED"> {
  const { db, client } = deps;
  const log = deps.log ?? defaultLogger;
  const dueAt = target.scheduledAt ?? target.content.scheduledAt;
  if (!dueAt) return "SKIPPED";

  // Never give an unapproved (or changed-since-approval) publication to the provider's scheduler.
  const gate = await evaluateApprovalGate(db, target.id);
  if (!gate.ok) {
    log.info({ contentTargetId: target.id, gate: gate.code }, "upload-post sweep: not handing off (approval gate); Socialith keeps the target");
    return "SKIPPED";
  }

  let ready;
  try {
    ready = assertDestinationReady(target);
  } catch (err) {
    log.info({ contentTargetId: target.id, reason: err instanceof PublishError ? err.message : "not ready" }, "upload-post sweep: not handing off (destination not ready); Socialith keeps the target");
    return "SKIPPED";
  }

  const material = await deps.resolveMaterial({ id: target.id });
  if (!material || !material.durable) {
    log.info({ contentTargetId: target.id }, "upload-post sweep: not handing off (media URLs are not durable); Socialith keeps the target");
    return "SKIPPED";
  }
  const media = chooseMedia(material.assets);
  if (!media) return "SKIPPED";

  const generation = (target.uploadPostPublication?.generation ?? 0) + 1;
  const common = {
    externalId: externalIdFor(target.id, generation),
    requestId: requestIdFor(target.id, generation),
    idempotencyKey: `sl-idem-${target.id}-g${generation}`,
  };
  const data = {
    mode: "PROVIDER_SCHEDULED" as const,
    status: "PENDING" as const,
    generation,
    ...common,
    profileUsername: ready.profileUsername,
    platform: ready.platformKey,
    scheduledFor: dueAt,
    submittedAt: now,
    providerJobId: null,
    handedOffAt: null,
    completedAt: null,
    lastErrorKind: null,
    lastErrorMessage: null,
  };
  let publicationId: string;
  try {
    publicationId = target.uploadPostPublication
      ? (await db.uploadPostPublication.update({ where: { id: target.uploadPostPublication.id }, data })).id
      : (await db.uploadPostPublication.create({ data: { organizationId: target.content.organizationId, contentTargetId: target.id, ...data } })).id;
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") return "SKIPPED"; // a concurrent sweep claimed it
    throw err;
  }

  const fields = buildPlatformFields(ready.platformKey, material.caption, material.title);
  const music = await resolveTikTokMusic(db, target, ready.platformKey, ready.capabilities, now);
  const missingMusic = requiredMusicProblem(target, music);
  if (missingMusic) {
    // The track is mandatory and cannot be attached: do not give it to the provider. Release the hand-off; Socialith keeps
    // the target and its own publishing job fails it with the reason instead of publishing without the track.
    await db.uploadPostPublication.update({ where: { id: publicationId }, data: { status: "CANCELLED", lastErrorKind: "HANDOFF_RELEASED", lastErrorMessage: missingMusic } });
    return "SKIPPED";
  }
  const extraFields: Record<string, string> = { ...fields.extra };
  if (music.musicId) extraFields.tiktok_music_id = music.musicId;
  await db.uploadPostPublication.update({ where: { id: publicationId }, data: { tiktokMusicId: music.musicId, notes: music.note } });

  const request = {
    profile: ready.profileUsername,
    platforms: [ready.platformKey],
    ...common,
    title: fields.title,
    description: fields.description,
    extraFields,
    scheduledDate: dueAt.toISOString(),
    timezone: "UTC",
  };
  try {
    const ack = media.kind === "video" ? await client.publishVideo({ ...request, videoUrl: media.url }) : await client.publishPhotos({ ...request, photoUrls: media.urls });
    if (ack.kind === "SCHEDULED") {
      await db.uploadPostPublication.update({ where: { id: publicationId }, data: { status: "SCHEDULED_AT_PROVIDER", providerJobId: ack.jobId, handedOffAt: now, lastSyncedAt: now } });
      log.info({ contentTargetId: target.id, jobId: ack.jobId, dueAt: dueAt.toISOString() }, "upload-post sweep: handed the target to the provider scheduler");
      return "HANDED_OFF";
    }
    // The provider ignored scheduled_date and is publishing NOW. Never ignore that: track it as an immediate publication.
    await db.uploadPostPublication.update({ where: { id: publicationId }, data: { mode: "IMMEDIATE", status: "PROCESSING", lastErrorKind: "UNEXPECTED_ACK", lastErrorMessage: "Provider accepted a scheduled request as an immediate upload.", scheduledFor: null } });
    log.warn({ contentTargetId: target.id }, "upload-post sweep: provider treated a scheduled request as immediate; tracking it");
    return "SKIPPED";
  } catch (err) {
    if (!(err instanceof UploadPostError)) throw err;
    const unknown = err.outcomeUnknown;
    await db.uploadPostPublication.update({
      where: { id: publicationId },
      data: {
        status: unknown ? "UNKNOWN_OUTCOME" : err.retryable ? "CANCELLED" : "FAILED",
        lastErrorKind: err.kind,
        lastErrorMessage: err.message.slice(0, 1000),
      },
    });
    log.warn({ contentTargetId: target.id, kind: err.kind }, "upload-post sweep: hand-off failed; Socialith keeps the target");
    return err.kind === "RATE_LIMITED" ? "RATE_LIMITED" : "SKIPPED";
  }
}
