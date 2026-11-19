import { fetchOrThrow, throwForErrorResponse } from "../http.js";
import { PublishError, type PublishInput, type PublishSuccess, type PublishingProvider } from "../types.js";

const GRAPH_API_BASE = "https://graph.facebook.com/v19.0";

interface MetaErrorBody {
  error?: { message?: string; type?: string; code?: number; error_subcode?: number; fbtrace_id?: string };
}

interface CreateContainerResponse extends MetaErrorBody {
  id?: string;
}

interface PublishMediaResponse extends MetaErrorBody {
  id?: string;
}

interface PermalinkResponse extends MetaErrorBody {
  permalink?: string;
}

/**
 * Instagram Content Publishing API (Meta Graph API), the real documented
 * two-step flow:
 * https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/content-publishing
 *   1. POST /{ig-user-id}/media       — create a media container
 *   2. POST /{ig-user-id}/media_publish — publish that container
 * `externalAccountId` is the Instagram Business Account ID
 * (SocialAccount.externalAccountId for this platform). A third, optional
 * GET fetches the real permalink for `externalPostUrl` — not guaranteed
 * by the publish response itself.
 */
export class InstagramProvider implements PublishingProvider {
  readonly platform = "INSTAGRAM" as const;

  async publish(input: PublishInput): Promise<PublishSuccess> {
    const media = input.assets.find((a) => a.type === "VIDEO") ?? input.assets.find((a) => a.type === "IMAGE");
    if (!media) {
      throw new PublishError(
        "Instagram publish requires a VIDEO or IMAGE asset; none is attached to this content.",
        "CONTENT_ERROR",
        false,
      );
    }

    const isVideo = media.type === "VIDEO";
    const containerRes = await fetchOrThrow(
      `${GRAPH_API_BASE}/${input.externalAccountId}/media`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          access_token: input.accessToken,
          caption: input.caption ?? "",
          ...(isVideo ? { media_type: "REELS", video_url: media.url } : { image_url: media.url }),
        }),
      },
      "Instagram media container creation",
    );
    if (!containerRes.ok) {
      await throwForErrorResponse(containerRes, "Instagram media container creation");
    }
    const container = (await containerRes.json()) as CreateContainerResponse;
    if (container.error) {
      throw metaBusinessError(container.error, "Instagram media container creation", containerRes.status);
    }
    if (!container.id) {
      throw new PublishError(
        "Instagram media container response had no id.",
        "PLATFORM_ERROR",
        true,
        containerRes.status,
      );
    }

    const publishRes = await fetchOrThrow(
      `${GRAPH_API_BASE}/${input.externalAccountId}/media_publish`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ access_token: input.accessToken, creation_id: container.id }),
      },
      "Instagram media publish",
    );
    if (!publishRes.ok) {
      await throwForErrorResponse(publishRes, "Instagram media publish");
    }
    const published = (await publishRes.json()) as PublishMediaResponse;
    if (published.error) {
      throw metaBusinessError(published.error, "Instagram media publish", publishRes.status);
    }
    if (!published.id) {
      throw new PublishError("Instagram media publish response had no id.", "PLATFORM_ERROR", true, publishRes.status);
    }

    // Best-effort — a permalink lookup failure shouldn't turn a genuinely
    // successful publish into a reported failure; externalPostUrl is
    // simply left null in that case.
    let permalink: string | null = null;
    try {
      const permalinkRes = await fetchOrThrow(
        `${GRAPH_API_BASE}/${published.id}?fields=permalink&access_token=${encodeURIComponent(input.accessToken)}`,
        { method: "GET" },
        "Instagram permalink lookup",
      );
      if (permalinkRes.ok) {
        const permalinkBody = (await permalinkRes.json()) as PermalinkResponse;
        permalink = permalinkBody.permalink ?? null;
      }
    } catch {
      // best-effort, see comment above
    }

    return {
      externalPostId: published.id,
      externalPostUrl: permalink,
      responseMetadata: { containerId: container.id },
    };
  }
}

function metaBusinessError(
  error: NonNullable<MetaErrorBody["error"]>,
  context: string,
  httpStatusCode: number,
): PublishError {
  // Meta's OAuth/permission error codes (190 = expired/invalid token, 200s
  // = permission errors) map to AUTH_ERROR; everything else business-
  // logic-rejected by the Graph API maps to CONTENT_ERROR. Neither is
  // retryable as-is.
  const isAuthError = error.code === 190 || (error.code !== undefined && error.code >= 200 && error.code < 300);
  return new PublishError(
    `${context} rejected: ${error.message ?? "unknown Graph API error"}`,
    isAuthError ? "AUTH_ERROR" : "CONTENT_ERROR",
    false,
    httpStatusCode,
    undefined,
    { code: error.code, subcode: error.error_subcode, fbtraceId: error.fbtrace_id },
  );
}
