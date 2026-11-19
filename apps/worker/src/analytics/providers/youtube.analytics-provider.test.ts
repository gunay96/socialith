import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { YouTubeAnalyticsProvider } from "./youtube.analytics-provider.js";
import type { FetchMetricsInput } from "../types.js";

const BASE_INPUT: FetchMetricsInput = {
  externalPostId: "yt-video-123",
  externalAccountId: "UC_test_channel",
  accessToken: "test-access-token",
};

describe("YouTubeAnalyticsProvider", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches real statistics and coerces string counts to numbers", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ items: [{ id: "yt-video-123", statistics: { viewCount: "500", likeCount: "40", commentCount: "3" } }] }),
        { status: 200 },
      ),
    );
    const provider = new YouTubeAnalyticsProvider();
    const result = await provider.fetchMetrics(BASE_INPUT);
    expect(result).toMatchObject({ viewCount: 500, likeCount: 40, commentCount: 3, shareCount: null });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("youtube/v3/videos");
    expect(url).toContain("id=yt-video-123");
  });

  it("throws CONTENT_ERROR when no matching video is returned", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ items: [] }), { status: 200 }));
    const provider = new YouTubeAnalyticsProvider();
    await expect(provider.fetchMetrics(BASE_INPUT)).rejects.toMatchObject({ code: "CONTENT_ERROR", retryable: false });
  });

  it("classifies a 403 as a permanent AUTH_ERROR", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "quota" }), { status: 403 }));
    const provider = new YouTubeAnalyticsProvider();
    await expect(provider.fetchMetrics(BASE_INPUT)).rejects.toMatchObject({ code: "AUTH_ERROR", retryable: false });
  });
});
