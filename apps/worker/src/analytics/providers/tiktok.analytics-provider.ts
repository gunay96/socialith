import { fetchOrThrow, throwForErrorResponse } from "../../publishing/http.js";
import { PublishError as MetricsError } from "../../publishing/types.js";
import type { AnalyticsProvider, FetchMetricsInput, FetchMetricsResult } from "../types.js";

const API_BASE = "https://open.tiktokapis.com/v2";

interface TikTokVideoQueryResponse {
  data?: {
    videos?: { id: string; like_count?: number; comment_count?: number; share_count?: number; view_count?: number }[];
  };
  error?: { code?: string; message?: string; log_id?: string };
}

/**
 * TikTok's Query Video endpoint — real, documented:
 * https://developers.tiktok.com/doc/content-posting-api-reference-query-video
 * Only returns stats for videos owned by the authenticated user, which is
 * exactly the case here (the same per-account token that published it).
 */
export class TikTokAnalyticsProvider implements AnalyticsProvider {
  readonly platform = "TIKTOK" as const;

  async fetchMetrics(input: FetchMetricsInput): Promise<FetchMetricsResult> {
    const res = await fetchOrThrow(
      `${API_BASE}/video/query/?fields=id,like_count,comment_count,share_count,view_count`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.accessToken}`,
          "Content-Type": "application/json; charset=UTF-8",
        },
        body: JSON.stringify({ filters: { video_ids: [input.externalPostId] } }),
      },
      "TikTok metrics query",
    );
    if (!res.ok) await throwForErrorResponse(res, "TikTok metrics query");

    const body = (await res.json()) as TikTokVideoQueryResponse;
    if (body.error && body.error.code && body.error.code !== "ok") {
      throw new MetricsError(
        `TikTok metrics query rejected: ${body.error.message ?? body.error.code}`,
        "CONTENT_ERROR",
        false,
        res.status,
        undefined,
        { logId: body.error.log_id, code: body.error.code },
      );
    }

    const video = body.data?.videos?.find((v) => v.id === input.externalPostId);
    if (!video) {
      throw new MetricsError("TikTok metrics query returned no matching video.", "CONTENT_ERROR", false, res.status);
    }

    return {
      viewCount: video.view_count ?? null,
      likeCount: video.like_count ?? null,
      commentCount: video.comment_count ?? null,
      shareCount: video.share_count ?? null,
      raw: { logId: body.error?.log_id },
    };
  }
}
