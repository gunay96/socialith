import { fetchOrThrow, throwForErrorResponse } from "../../publishing/http.js";
import { PublishError as MetricsError } from "../../publishing/types.js";
import type { AnalyticsProvider, FetchMetricsInput, FetchMetricsResult } from "../types.js";

const GRAPH_API_BASE = "https://graph.facebook.com/v19.0";

interface MediaFieldsResponse {
  like_count?: number;
  comments_count?: number;
  error?: { message?: string; code?: number; error_subcode?: number };
}

/**
 * Instagram Graph API's basic media fields — real, documented:
 * https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-media
 * `like_count`/`comments_count` are available on the basic fields; real
 * reach/impressions/saves/shares require the separate `/insights` edge
 * with additional permissions this app doesn't request — left null
 * rather than guessed, see the class doc below.
 */
export class InstagramAnalyticsProvider implements AnalyticsProvider {
  readonly platform = "INSTAGRAM" as const;

  async fetchMetrics(input: FetchMetricsInput): Promise<FetchMetricsResult> {
    const res = await fetchOrThrow(
      `${GRAPH_API_BASE}/${input.externalPostId}?fields=like_count,comments_count&access_token=${encodeURIComponent(input.accessToken)}`,
      { method: "GET" },
      "Instagram metrics fetch",
    );
    if (!res.ok) await throwForErrorResponse(res, "Instagram metrics fetch");

    const body = (await res.json()) as MediaFieldsResponse;
    if (body.error) {
      const isAuthError = body.error.code === 190 || (body.error.code !== undefined && body.error.code >= 200 && body.error.code < 300);
      throw new MetricsError(
        `Instagram metrics fetch rejected: ${body.error.message ?? "unknown Graph API error"}`,
        isAuthError ? "AUTH_ERROR" : "CONTENT_ERROR",
        false,
        res.status,
        undefined,
        { code: body.error.code, subcode: body.error.error_subcode },
      );
    }

    return {
      viewCount: null, // requires /insights (reach/impressions), not requested by this app
      likeCount: body.like_count ?? null,
      commentCount: body.comments_count ?? null,
      shareCount: null, // Instagram's Graph API does not expose a share count for owned media
      raw: {},
    };
  }
}
