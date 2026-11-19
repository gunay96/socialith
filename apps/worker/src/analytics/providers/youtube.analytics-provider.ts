import { fetchOrThrow, throwForErrorResponse } from "../../publishing/http.js";
import { PublishError as MetricsError } from "../../publishing/types.js";
import type { AnalyticsProvider, FetchMetricsInput, FetchMetricsResult } from "../types.js";

interface YouTubeVideosResponse {
  items?: { id: string; statistics?: { viewCount?: string; likeCount?: string; commentCount?: string } }[];
}

/**
 * YouTube Data API v3's videos.list with part=statistics — real,
 * documented: https://developers.google.com/youtube/v3/docs/videos/list
 * Note the API returns counts as strings, not numbers. YouTube exposes
 * no share-count metric at all — left null, never guessed.
 */
export class YouTubeAnalyticsProvider implements AnalyticsProvider {
  readonly platform = "YOUTUBE" as const;

  async fetchMetrics(input: FetchMetricsInput): Promise<FetchMetricsResult> {
    const res = await fetchOrThrow(
      `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${encodeURIComponent(input.externalPostId)}`,
      { headers: { Authorization: `Bearer ${input.accessToken}` } },
      "YouTube metrics fetch",
    );
    if (!res.ok) await throwForErrorResponse(res, "YouTube metrics fetch");

    const body = (await res.json()) as YouTubeVideosResponse;
    const video = body.items?.find((v) => v.id === input.externalPostId);
    if (!video) {
      throw new MetricsError("YouTube metrics fetch returned no matching video.", "CONTENT_ERROR", false, res.status);
    }

    const stats = video.statistics ?? {};
    return {
      viewCount: stats.viewCount !== undefined ? Number(stats.viewCount) : null,
      likeCount: stats.likeCount !== undefined ? Number(stats.likeCount) : null,
      commentCount: stats.commentCount !== undefined ? Number(stats.commentCount) : null,
      shareCount: null, // not exposed by the YouTube Data API
      raw: {},
    };
  }
}
