import type { Platform, Prisma, PrismaClient } from "@socialith/database";
import { UploadPostError, type UploadPostClient, type UploadPostPlatformResult, type UploadPostPublishAck } from "@socialith/upload-post";
import { PublishError, type PublishSuccess } from "../publishing/types.js";
import { toPublishError } from "./client.js";
import { applyProviderStatus, interpretProviderStatus } from "./status.js";

/**
 * Immediate publication of one ContentTarget through Upload-Post (the Publishing Destination's route when
 * SocialAccount.publishingProvider = UPLOAD_POST). Socialith keeps the campaign, the content ownership and the
 * publication record; the provider only receives the media and the per-platform fields.
 *
 * Duplicate-publication protection — a ContentTarget can never become two provider jobs:
 *  - exactly ONE UploadPostPublication row per target (unique), created BEFORE the provider is called;
 *  - every request carries the row's request_id, external_id and an Idempotency-Key, all fixed for the row's
 *    "generation" (a deliberate manual retry of a FAILED target is a new generation; a BullMQ/network retry is not);
 *  - after a timeout (outcome unknown) or any retry, the provider is ASKED (status by request_id) before anything is resent;
 *  - the call is always asynchronous (async_upload=true): no request ever blocks for a long upload, and the final
 *    result arrives through the status poll, the reconciler sweep or a verified webhook.
 */

export const UPLOAD_POST_PLATFORM: Partial<Record<Platform, string>> = {
  TIKTOK: "tiktok",
  INSTAGRAM: "instagram",
  YOUTUBE: "youtube",
};

/** A music verification older than this is not trusted (chart snapshots change). */
export const MUSIC_VERIFICATION_MAX_AGE_MS = 30 * 24 * 3_600_000;

export interface UploadPostTarget {
  id: string;
  /** Publishing Center: make the track conditions blocking (fail instead of publishing without the track). */
  requireMusic?: boolean;
  contentId: string;
  attemptCount: number;
  socialAccount: {
    id: string;
    platform: Platform;
    externalAccountId: string;
    status: string;
    uploadPostAccount: {
      id: string;
      platform: string;
      providerAccountId: string;
      status: string;
      capabilities: Prisma.JsonValue;
      profile: { username: string; status: string; blocked?: boolean };
    } | null;
  };
  content: { organizationId: string; soundId: string | null };
}

export interface UploadPostPublishArgs {
  db: PrismaClient;
  client: UploadPostClient | null;
  target: UploadPostTarget;
  caption: string | null;
  title: string | null;
  assets: { type: string; url: string }[];
  now?: Date;
}

export function externalIdFor(contentTargetId: string, generation: number): string {
  return `socialith:target:${contentTargetId}:g${generation}`;
}
export function requestIdFor(contentTargetId: string, generation: number): string {
  return `sl-${contentTargetId}-g${generation}`;
}

/** Validates that this destination may publish right now. Throws PublishError (never calls the provider). */
export function assertDestinationReady(target: UploadPostTarget): { profileUsername: string; platformKey: string; capabilities: string[] } {
  const platformKey = UPLOAD_POST_PLATFORM[target.socialAccount.platform];
  if (!platformKey) {
    throw new PublishError(`Upload-Post publishing is not supported for ${target.socialAccount.platform}.`, "CONFIGURATION_ERROR", false);
  }
  const account = target.socialAccount.uploadPostAccount;
  if (!account) {
    throw new PublishError("This destination is not linked to an Upload-Post account (it was unlinked or never enabled).", "CONFIGURATION_ERROR", false);
  }
  if (account.platform !== platformKey || account.providerAccountId !== target.socialAccount.externalAccountId) {
    throw new PublishError("The Upload-Post account behind this destination changed. Re-enable the destination after reviewing it.", "CONFIGURATION_ERROR", false);
  }
  if (account.profile.status !== "ACTIVE") {
    throw new PublishError("The Upload-Post profile of this destination no longer exists at the provider.", "CONFIGURATION_ERROR", false);
  }
  if (account.profile.blocked === true) {
    throw new PublishError("Upload-Post reports this profile as blocked. Resolve it with Upload-Post support, then retry; nothing was sent.", "CONFIGURATION_ERROR", false);
  }
  if (account.status === "DISCONNECTED") {
    throw new PublishError(`The ${platformKey} account is no longer connected in Upload-Post. Reconnect it, then retry.`, "AUTH_ERROR", false);
  }
  if (account.status === "REAUTH_REQUIRED") {
    throw new PublishError(`The ${platformKey} account must be reconnected in Upload-Post (authorization expired), then retry.`, "AUTH_ERROR", false);
  }
  const capabilities = Array.isArray(account.capabilities) ? account.capabilities.filter((c): c is string => typeof c === "string") : [];
  return { profileUsername: account.profile.username, platformKey, capabilities };
}

function clip(text: string | null | undefined, max: number): string {
  return (text ?? "").trim().slice(0, max);
}

/** Per-platform field mapping. Deliberately minimal and documented (docs/UPLOAD_POST_API_MAPPING.md): unspecified fields keep the provider/account defaults. */
export function buildPlatformFields(
  platformKey: string,
  caption: string | null,
  title: string | null,
): { title: string; description?: string; extra: Record<string, string> } {
  switch (platformKey) {
    case "tiktok":
      return { title: clip(caption ?? title, 2200), extra: { tiktok_title: clip(caption ?? title, 2200) } };
    case "youtube": {
      const yt = clip(title ?? caption?.split("\n")[0], 100) || "Untitled";
      return { title: yt, description: clip(caption, 5000), extra: { youtube_title: yt } };
    }
    default: // instagram
      return { title: clip(caption ?? title, 2200), extra: {} };
  }
}

/** Decides whether a track may be attached. Returns the id to send, or null with a human reason (publishing then proceeds WITHOUT music). */
export async function resolveTikTokMusic(
  db: PrismaClient,
  target: UploadPostTarget,
  platformKey: string,
  capabilities: string[],
  now: Date,
): Promise<{ musicId: string | null; note: string | null }> {
  const soundId = target.content.soundId;
  if (platformKey !== "tiktok" || !soundId) return { musicId: null, note: null };

  const mappings = await db.soundMusicMapping.findMany({
    where: { soundId, provider: "UPLOAD_POST_TIKTOK", organizationId: target.content.organizationId },
    orderBy: { updatedAt: "desc" },
  });
  if (mappings.length === 0) return { musicId: null, note: "Music not attached: this track has no verified TikTok music mapping." };
  if (!capabilities.includes("music")) {
    return { musicId: null, note: "Music not attached: the TikTok account lacks the 'music' capability (reconnect it in Upload-Post)." };
  }
  const usable = mappings.find(
    (m) =>
      m.availability === "VERIFIED_AVAILABLE" &&
      m.rightsConfirmed &&
      m.verifiedAt !== null &&
      now.getTime() - m.verifiedAt.getTime() <= MUSIC_VERIFICATION_MAX_AGE_MS,
  );
  if (!usable) {
    return { musicId: null, note: "Music not attached: no mapping is verified available, rights-confirmed and recently verified." };
  }
  return { musicId: usable.providerMusicId, note: null };
}

/**
 * "Require the track" (Publishing Center): when the operator made the track mandatory for this destination and it
 * cannot be attached, the publication must NOT go out without it. Returns the reason, or null when it may proceed.
 */
export function requiredMusicProblem(target: { requireMusic?: boolean }, music: { musicId: string | null; note: string | null }): string | null {
  if (!target.requireMusic || music.musicId || !music.note) return null;
  return `The track is required for this destination but could not be attached. ${music.note}`;
}

export function chooseMedia(assets: { type: string; url: string }[]): { kind: "video"; url: string } | { kind: "photos"; urls: string[] } | null {
  const video = assets.find((a) => a.type === "VIDEO");
  if (video) return { kind: "video", url: video.url };
  const images = assets.filter((a) => a.type === "IMAGE").map((a) => a.url);
  return images.length > 0 ? { kind: "photos", urls: images } : null;
}

function ackToSuccess(ack: UploadPostPublishAck, requestId: string, externalId: string): PublishSuccess | { final: UploadPostPlatformResult[] } {
  if (ack.kind === "ACCEPTED_ASYNC") {
    return {
      externalPostId: ack.requestId,
      externalPostUrl: null,
      responseMetadata: { provider: "upload-post", requestId: ack.requestId, externalId, totalPlatforms: ack.totalPlatforms },
      pendingConfirmation: true,
    };
  }
  if (ack.kind === "COMPLETED_SYNC") return { final: ack.results };
  throw new PublishError("Upload-Post answered an immediate publication with a scheduled job id; refusing to treat it as published.", "PLATFORM_ERROR", false, undefined, undefined, { provider: "upload-post", requestId });
}

export async function publishViaUploadPost(args: UploadPostPublishArgs): Promise<PublishSuccess> {
  const { db, client, target } = args;
  const now = args.now ?? new Date();

  if (!client) throw new PublishError("Upload-Post is not configured (UPLOAD_POST_API_KEY is missing).", "CONFIGURATION_ERROR", false);
  const { profileUsername, platformKey, capabilities } = assertDestinationReady(target);

  const media = chooseMedia(args.assets);
  if (!media) throw new PublishError("This content has no video or image asset to publish.", "CONTENT_ERROR", false);

  // ---- the correlation row (exactly one per target) -------------------------------------------
  let publication = await db.uploadPostPublication.findUnique({ where: { contentTargetId: target.id } });

  if (publication && (publication.status === "FAILED" || publication.status === "CANCELLED")) {
    // A deliberate retry of a finished-unsuccessfully target: a NEW provider job (new generation, new ids).
    const generation = publication.generation + 1;
    publication = await db.uploadPostPublication.update({
      where: { id: publication.id },
      data: {
        generation,
        externalId: externalIdFor(target.id, generation),
        requestId: requestIdFor(target.id, generation),
        idempotencyKey: `sl-idem-${target.id}-g${generation}`,
        status: "PENDING",
        mode: "IMMEDIATE",
        providerJobId: null,
        scheduledFor: null,
        handedOffAt: null,
        completedAt: null,
        lastErrorKind: null,
        lastErrorMessage: null,
        lastProviderStatus: null,
        profileUsername,
        platform: platformKey,
      },
    });
  } else if (publication?.status === "SCHEDULED_AT_PROVIDER" && publication.providerJobId) {
    // The provider still owns a schedule for this target but Socialith now wants it published: take it back first.
    try {
      await client.cancelScheduled(publication.providerJobId);
    } catch (err) {
      if (err instanceof UploadPostError && err.kind === "CONFLICT") {
        throw new PublishError("Upload-Post is publishing this scheduled job right now; waiting for its result.", "NETWORK_ERROR", true);
      }
      throw toPublishError(err);
    }
    const generation = publication.generation + 1;
    publication = await db.uploadPostPublication.update({
      where: { id: publication.id },
      data: {
        generation,
        externalId: externalIdFor(target.id, generation),
        requestId: requestIdFor(target.id, generation),
        idempotencyKey: `sl-idem-${target.id}-g${generation}`,
        status: "PENDING",
        mode: "IMMEDIATE",
        providerJobId: null,
        scheduledFor: null,
        handedOffAt: null,
      },
    });
  } else if (!publication) {
    try {
      publication = await db.uploadPostPublication.create({
        data: {
          organizationId: target.content.organizationId,
          contentTargetId: target.id,
          mode: "IMMEDIATE",
          status: "PENDING",
          generation: 1,
          externalId: externalIdFor(target.id, 1),
          requestId: requestIdFor(target.id, 1),
          idempotencyKey: `sl-idem-${target.id}-g1`,
          profileUsername,
          platform: platformKey,
        },
      });
    } catch (err) {
      if ((err as { code?: string }).code !== "P2002") throw err;
      // A concurrent delivery of the same job created it first: use that row (never a second one).
      publication = await db.uploadPostPublication.findUniqueOrThrow({ where: { contentTargetId: target.id } });
    }
  }
  if (!publication) throw new PublishError("Could not create the Upload-Post publication record.", "PLATFORM_ERROR", true);

  // ---- ask before (re)sending: a retry or an unknown outcome must never create a second job ----
  if (publication.status === "PENDING" || publication.status === "UNKNOWN_OUTCOME" || publication.status === "PROCESSING" || publication.status === "COMPLETED") {
    let known = null;
    if (publication.submittedAt || publication.status !== "PENDING") {
      try {
        known = await client.getStatus({ requestId: publication.requestId });
      } catch (err) {
        throw toPublishError(err);
      }
    }
    if (known && known.status !== "not_found") {
      const outcome = interpretProviderStatus(publication.platform, known);
      if (outcome.kind === "IN_FLIGHT") {
        await db.uploadPostPublication.update({ where: { id: publication.id }, data: { status: "PROCESSING", lastProviderStatus: outcome.providerStatus, lastSyncedAt: now } });
        return {
          externalPostId: publication.requestId,
          externalPostUrl: null,
          responseMetadata: { provider: "upload-post", requestId: publication.requestId, externalId: publication.externalId, adopted: true },
          pendingConfirmation: true,
        };
      }
      await applyProviderStatus(db, { id: publication.id, contentTargetId: target.id, platform: publication.platform, status: publication.status }, known, now);
      if (outcome.kind === "COMPLETED") {
        return {
          externalPostId: outcome.platformPostId ?? publication.requestId,
          externalPostUrl: outcome.postUrl,
          responseMetadata: { provider: "upload-post", requestId: publication.requestId, externalId: publication.externalId, adopted: true },
        };
      }
      throw new PublishError(outcome.kind === "FAILED" ? outcome.reason : "Upload-Post could not find this publication.", "CONTENT_ERROR", false, undefined, undefined, {
        provider: "upload-post",
        requestId: publication.requestId,
      });
    }
    // not found at the provider: it never arrived — safe to send (same request_id/Idempotency-Key anyway).
  }

  // ---- build and send ------------------------------------------------------------------------
  const fields = buildPlatformFields(platformKey, args.caption, args.title);
  const music = await resolveTikTokMusic(db, target, platformKey, capabilities, now);
  const missingMusic = requiredMusicProblem(target, music);
  if (missingMusic) {
    await db.uploadPostPublication.update({ where: { id: publication.id }, data: { status: "FAILED", completedAt: now, lastErrorKind: "MUSIC_REQUIRED", lastErrorMessage: missingMusic } });
    throw new PublishError(missingMusic, "CONFIGURATION_ERROR", false);
  }
  const extraFields: Record<string, string> = { ...fields.extra };
  if (music.musicId) extraFields.tiktok_music_id = music.musicId;

  await db.uploadPostPublication.update({
    where: { id: publication.id },
    data: { status: "PENDING", submittedAt: now, tiktokMusicId: music.musicId, notes: music.note, lastErrorKind: null, lastErrorMessage: null },
  });

  const common = {
    profile: profileUsername,
    platforms: [platformKey],
    externalId: publication.externalId,
    requestId: publication.requestId,
    idempotencyKey: publication.idempotencyKey,
    title: fields.title,
    description: fields.description,
    extraFields,
  };

  let ack: UploadPostPublishAck;
  try {
    ack = media.kind === "video" ? await client.publishVideo({ ...common, videoUrl: media.url }) : await client.publishPhotos({ ...common, photoUrls: media.urls });
  } catch (err) {
    if (err instanceof UploadPostError) {
      const unknown = err.outcomeUnknown;
      const permanent = !err.retryable;
      await db.uploadPostPublication.update({
        where: { id: publication.id },
        data: {
          status: unknown ? "UNKNOWN_OUTCOME" : permanent ? "FAILED" : "PENDING",
          lastErrorKind: err.kind,
          lastErrorMessage: err.message.slice(0, 1000),
          ...(permanent ? { completedAt: now } : {}),
        },
      });
    } else {
      // The provider ANSWERED, but with something that cannot be interpreted (an HTML error page, an empty body, JSON
      // without any id). It may well have created the job, so this is an unknown outcome — exactly like a timeout: the
      // retry asks the provider by request_id first and only re-sends (same Idempotency-Key) if nothing exists.
      await db.uploadPostPublication.update({
        where: { id: publication.id },
        data: { status: "UNKNOWN_OUTCOME", lastErrorKind: "INVALID_RESPONSE", lastErrorMessage: (err instanceof Error ? err.message : String(err)).slice(0, 1000) },
      });
    }
    throw toPublishError(err);
  }

  const result = ackToSuccess(ack, publication.requestId, publication.externalId);
  if ("final" in result) {
    const r = result.final.find((x) => x.platform === platformKey);
    if (r && r.success) {
      await db.uploadPostPublication.update({ where: { id: publication.id }, data: { status: "COMPLETED", completedAt: now, lastProviderStatus: "completed", lastSyncedAt: now } });
      return {
        externalPostId: r.platformPostId ?? publication.requestId,
        externalPostUrl: r.postUrl,
        responseMetadata: { provider: "upload-post", requestId: publication.requestId, externalId: publication.externalId, sync: true },
      };
    }
    const reason = r?.error ?? r?.message ?? "Upload-Post reported the publication failed.";
    await db.uploadPostPublication.update({ where: { id: publication.id }, data: { status: "FAILED", completedAt: now, lastErrorKind: "PROVIDER_FAILED", lastErrorMessage: reason.slice(0, 1000) } });
    throw new PublishError(reason, "CONTENT_ERROR", false, undefined, undefined, { provider: "upload-post", requestId: publication.requestId });
  }

  await db.uploadPostPublication.update({ where: { id: publication.id }, data: { status: "PROCESSING", lastProviderStatus: "accepted", lastSyncedAt: now } });
  return result;
}

/** One poll of an Upload-Post-published target. Returns "pending" while the provider is still working. */
export async function pollUploadPostTarget(
  db: PrismaClient,
  client: UploadPostClient | null,
  contentTargetId: string,
  now: Date = new Date(),
): Promise<"pending" | "done"> {
  const publication = await db.uploadPostPublication.findUnique({ where: { contentTargetId } });
  if (!publication) return "done";
  if (!client) throw new PublishError("Upload-Post is not configured (UPLOAD_POST_API_KEY is missing).", "CONFIGURATION_ERROR", false);

  let status;
  try {
    status = await client.getStatus(publication.providerJobId && publication.mode === "PROVIDER_SCHEDULED" ? { jobId: publication.providerJobId } : { requestId: publication.requestId });
  } catch (err) {
    throw toPublishError(err);
  }
  const outcome = await applyProviderStatus(db, { id: publication.id, contentTargetId, platform: publication.platform, status: publication.status }, status, now);
  return outcome.kind === "IN_FLIGHT" || outcome.kind === "NOT_FOUND" ? "pending" : "done";
}
