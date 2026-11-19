import { fetchOrThrow, throwForErrorResponse } from "../http.js";
import {
  PublishError,
  type PublishInput,
  type PublishStatusResult,
  type PublishSuccess,
  type PublishingProvider,
} from "../types.js";

const API_BASE = "https://open.tiktokapis.com/v2";

interface TikTokInitResponse {
  data?: { publish_id?: string };
  error?: { code?: string; message?: string; log_id?: string };
}

/**
 * TikTok Content Posting API (v2) — **Upload/Inbox flow**, not Direct
 * Post. This project's real, registered TikTok app requests
 * `video.upload` + `video.list` (not `video.publish`) — confirmed by a
 * live rejection when this file previously called the Direct Post
 * endpoint with only PKCE fixed, and re-verified directly against
 * developers.tiktok.com/doc/content-posting-api-reference-upload-video
 * during this phase. Real, documented differences from Direct Post:
 *
 *   - Endpoint: POST /v2/post/publish/inbox/video/init/ (not
 *     /v2/post/publish/video/init/).
 *   - Request body is `{ source_info: { source: "PULL_FROM_URL",
 *     video_url } }` only — no `post_info`, no `title`, no
 *     `privacy_level`, no duet/comment/stitch controls. TikTok's
 *     documented request schema for this endpoint has no caption/title
 *     field for video at all, so Content.caption/title are genuinely
 *     NOT transmitted to TikTok by this flow — the user adds their own
 *     caption when they finish the post manually in the TikTok app
 *     (see checkPublishStatus's SEND_TO_USER_INBOX handling below).
 *     Because there's no post_info, this flow also needs no preliminary
 *     Query Creator Info call (that call only exists to pick a real
 *     `privacy_level`, which this flow never sets).
 *   - The video never actually publishes automatically: it's delivered
 *     to the authorizing user's TikTok inbox as a draft. TikTok's own
 *     docs are explicit that the integrating app "must inform users
 *     that they must click on inbox notifications to continue the
 *     editing flow in TikTok and complete the post" — Socialith's job
 *     ends at successful delivery to the inbox, not at the video going
 *     live, and the UI must say so rather than claim a plain "Published".
 *   - Documented real constraint: "There may be at most 5 pending
 *     shares within any 24-hour period" per authorizing user.
 *
 * Phase 09 music-seeding capability note (unchanged by the flow switch):
 * neither this endpoint's nor Direct Post's request schema has a
 * sound_id/music_id field, and TikTok exposes no official endpoint to
 * fetch a sound's actual audio bytes — see describeSoundCapability below.
 */
export class TikTokProvider implements PublishingProvider {
  readonly platform = "TIKTOK" as const;

  async publish(input: PublishInput): Promise<PublishSuccess> {
    const video = input.assets.find((a) => a.type === "VIDEO");
    if (!video) {
      throw new PublishError(
        "TikTok publish requires a VIDEO asset; none is attached to this content.",
        "CONTENT_ERROR",
        false,
      );
    }

    const res = await fetchOrThrow(
      `${API_BASE}/post/publish/inbox/video/init/`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.accessToken}`,
          "Content-Type": "application/json; charset=UTF-8",
        },
        body: JSON.stringify({
          source_info: {
            source: "PULL_FROM_URL",
            video_url: video.url,
          },
        }),
      },
      "TikTok upload",
    );

    if (!res.ok) {
      await throwForErrorResponse(res, "TikTok upload");
    }

    const body = (await res.json()) as TikTokInitResponse;
    // TikTok can return HTTP 200 with a business-logic error in the body
    // (error.code !== "ok") — this is documented API behavior, not an
    // edge case to ignore.
    if (body.error && body.error.code && body.error.code !== "ok") {
      throw new PublishError(
        `TikTok upload rejected: ${body.error.message ?? body.error.code}`,
        "CONTENT_ERROR",
        false,
        res.status,
        undefined,
        { logId: body.error.log_id, code: body.error.code },
      );
    }
    if (!body.data?.publish_id) {
      throw new PublishError("TikTok upload response had no publish_id.", "PLATFORM_ERROR", true, res.status);
    }

    return {
      externalPostId: body.data.publish_id,
      externalPostUrl: null,
      pendingConfirmation: true,
      responseMetadata: {
        logId: body.error?.log_id,
        flow: "UPLOAD_INBOX",
        // Documented, real, and worth recording per attempt: caption/title
        // were prepared in Socialith but the Upload API has no field to
        // carry them — the user must set them manually when completing
        // the post in TikTok's own app.
        captionNotTransmitted: Boolean(input.title ?? input.caption),
        ...(input.sound ? { sound: describeSoundCapability(input.sound) } : {}),
      },
    };
  }

  /**
   * Real Get Post Status call:
   * https://developers.tiktok.com/docs/en/content-posting-api-reference-get-video-status
   * (POST /v2/post/publish/status/fetch/, body {publish_id}). Verified
   * response `status` values: PROCESSING_UPLOAD, PROCESSING_DOWNLOAD,
   * SEND_TO_USER_INBOX, PUBLISH_COMPLETE, FAILED.
   *
   * For this project's real Upload/Inbox flow, **SEND_TO_USER_INBOX is
   * the real terminal success state** — the video was genuinely,
   * successfully delivered to the user's TikTok inbox; it is not still
   * "processing" and TikTok will not move it further on its own. Treating
   * it as PROCESSING (as an earlier version of this file did, written
   * before the scope/endpoint correction above) would poll forever until
   * MAX_POLL_ATTEMPTS gave up and wrongly marked a genuinely successful
   * delivery as FAILED. `deliveryNote` carries the honest, real caveat
   * through to ContentTarget/UI: delivered, but not live until the user
   * manually finishes the post in TikTok's app — never silently upgraded
   * to a plain "Published".
   *
   * PUBLISH_COMPLETE is kept handled too (not removed) in case this app
   * is later additionally approved for `video.publish`/Direct Post —
   * `publicaly_available_post_id` is that flow's real final post id, only
   * present "if the post is published for public viewership".
   */
  async checkPublishStatus(accessToken: string, publishId: string): Promise<PublishStatusResult> {
    const res = await fetchOrThrow(
      `${API_BASE}/post/publish/status/fetch/`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json; charset=UTF-8",
        },
        body: JSON.stringify({ publish_id: publishId }),
      },
      "TikTok publish status fetch",
    );
    if (!res.ok) {
      await throwForErrorResponse(res, "TikTok publish status fetch");
    }

    // publicaly_available_post_id is documented as int64 — a real TikTok
    // video id (19 digits) exceeds Number.MAX_SAFE_INTEGER, and
    // JSON.parse always parses JSON numbers as IEEE-754 doubles, silently
    // corrupting the last few digits (verified with a real 19-digit id in
    // this file's own test suite — e.g. 7123456789012345678 parses to
    // 7123456789012346000). Quoting the array's numeric entries in the
    // raw response text before JSON.parse preserves the exact digits.
    const rawText = await res.text();
    const safeText = rawText.replace(
      /"publicaly_available_post_id"\s*:\s*\[([^\]]*)\]/,
      (_match, contents: string) =>
        `"publicaly_available_post_id":[${contents
          .split(",")
          .map((n) => n.trim())
          .filter((n) => n.length > 0)
          .map((n) => `"${n}"`)
          .join(",")}]`,
    );

    const body = JSON.parse(safeText) as {
      data?: { status?: string; fail_reason?: string; publicaly_available_post_id?: string[] };
      error?: { code?: string; message?: string; log_id?: string };
    };
    if (body.error && body.error.code && body.error.code !== "ok") {
      throw new PublishError(
        `TikTok publish status fetch rejected: ${body.error.message ?? body.error.code}`,
        body.error.code === "invalid_publish_id" || body.error.code === "token_not_authorized_for_specified_publish_id"
          ? "CONTENT_ERROR"
          : "PLATFORM_ERROR",
        body.error.code !== "invalid_publish_id" && body.error.code !== "token_not_authorized_for_specified_publish_id",
        res.status,
        undefined,
        { logId: body.error.log_id, code: body.error.code },
      );
    }

    const status = body.data?.status;

    if (status === "SEND_TO_USER_INBOX") {
      return {
        status: "COMPLETE",
        externalPostId: publishId, // no real public post id exists yet — the user hasn't finished posting the draft
        externalPostUrl: null,
        deliveryNote:
          "Delivered to the connected TikTok account's inbox. The video is not public yet — the user must open the TikTok app, find the notification, and finish posting it there.",
        responseMetadata: { logId: body.error?.log_id, status },
      };
    }

    if (status === "PUBLISH_COMPLETE") {
      const publicPostIds = body.data?.publicaly_available_post_id ?? [];
      return {
        status: "COMPLETE",
        externalPostId: publicPostIds.length > 0 ? String(publicPostIds[0]) : publishId,
        externalPostUrl: null,
        responseMetadata: { logId: body.error?.log_id, status, publicaly_available_post_id: publicPostIds },
      };
    }

    if (status === "FAILED") {
      return {
        status: "FAILED",
        failReason: body.data?.fail_reason ?? "TikTok reported this publish as FAILED with no fail_reason.",
        responseMetadata: { logId: body.error?.log_id },
      };
    }

    // PROCESSING_UPLOAD / PROCESSING_DOWNLOAD, or an unrecognized future
    // value — treated as still-processing rather than guessed at, so an
    // unknown status never gets misclassified as done.
    return { status: "PROCESSING" };
  }
}

/**
 * Honest capability record for a requested Sound — see this file's class
 * comment for why "attached" is never a real option today. Kept as its
 * own function (rather than inlined) so it's the one place this
 * capability status is worded, for Phase 09's analytics/UI to key off of
 * consistently (`capability: "NOT_SUPPORTED_BY_API"`).
 */
function describeSoundCapability(sound: NonNullable<PublishInput["sound"]>): Record<string, unknown> {
  return {
    requested: { title: sound.title, artist: sound.artist, externalSoundId: sound.externalSoundId },
    capability: "NOT_SUPPORTED_BY_API",
    reason:
      "TikTok's Content Posting API has no sound_id/music_id field — the video was uploaded with its own embedded audio, not this Sound.",
  };
}
