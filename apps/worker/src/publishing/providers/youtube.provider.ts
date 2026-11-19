import { fetchOrThrow, throwForErrorResponse } from "../http.js";
import { PublishError, type PublishInput, type PublishSuccess, type PublishingProvider } from "../types.js";

const UPLOAD_INIT_URL = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status";

interface YouTubeVideoResource {
  id?: string;
}

/**
 * YouTube Data API v3's real resumable upload flow:
 * https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol
 *   1. POST the video's metadata (snippet/status) — YouTube responds with
 *      an empty 200 and a `Location` header: the actual upload URL.
 *   2. PUT the real video bytes to that URL — the final response body is
 *      the created video resource, including its id.
 * `privacyStatus: "private"` is a deliberate safe default — nothing in
 * this phase (or this environment, which has no real Google credentials)
 * ever exercises this against a real channel, but a provider that
 * defaults to public would be the wrong default to ship.
 */
export class YouTubeProvider implements PublishingProvider {
  readonly platform = "YOUTUBE" as const;

  async publish(input: PublishInput): Promise<PublishSuccess> {
    const video = input.assets.find((a) => a.type === "VIDEO");
    if (!video) {
      throw new PublishError(
        "YouTube publish requires a VIDEO asset; none is attached to this content.",
        "CONTENT_ERROR",
        false,
      );
    }

    const initRes = await fetchOrThrow(
      UPLOAD_INIT_URL,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.accessToken}`,
          "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Type": "video/*",
        },
        body: JSON.stringify({
          snippet: { title: input.title ?? input.caption ?? "Untitled", description: input.caption ?? "" },
          status: { privacyStatus: "private" },
        }),
      },
      "YouTube upload session init",
    );
    if (!initRes.ok) {
      await throwForErrorResponse(initRes, "YouTube upload session init");
    }
    const uploadUrl = initRes.headers.get("location");
    if (!uploadUrl) {
      throw new PublishError(
        "YouTube upload session init response had no Location header.",
        "PLATFORM_ERROR",
        true,
        initRes.status,
      );
    }

    const videoRes = await fetchOrThrow(video.url, {}, "YouTube source video fetch");
    if (!videoRes.ok) {
      throw new PublishError(
        `Failed to fetch source video for upload: ${videoRes.status} ${videoRes.statusText}`,
        "CONTENT_ERROR",
        false,
        videoRes.status,
      );
    }
    const videoBytes = Buffer.from(await videoRes.arrayBuffer());

    const uploadRes = await fetchOrThrow(
      uploadUrl,
      { method: "PUT", headers: { "Content-Type": "video/*" }, body: videoBytes },
      "YouTube video upload",
    );
    if (!uploadRes.ok) {
      await throwForErrorResponse(uploadRes, "YouTube video upload");
    }
    const created = (await uploadRes.json()) as YouTubeVideoResource;
    if (!created.id) {
      throw new PublishError("YouTube upload response had no video id.", "PLATFORM_ERROR", true, uploadRes.status);
    }

    return {
      externalPostId: created.id,
      externalPostUrl: `https://www.youtube.com/watch?v=${created.id}`,
      responseMetadata: {},
    };
  }
}
