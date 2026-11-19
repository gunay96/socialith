import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { TikTokAnalyticsProvider } from "./tiktok.analytics-provider.js";
import type { FetchMetricsInput } from "../types.js";

const BASE_INPUT: FetchMetricsInput = {
  externalPostId: "v_pub_url~abc123",
  externalAccountId: "tiktok-user-1",
  accessToken: "test-access-token",
};

describe("TikTokAnalyticsProvider", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches real metrics for the matching video id", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: { videos: [{ id: "v_pub_url~abc123", like_count: 10, comment_count: 2, share_count: 1, view_count: 100 }] },
          error: { code: "ok" },
        }),
        { status: 200 },
      ),
    );
    const provider = new TikTokAnalyticsProvider();
    const result = await provider.fetchMetrics(BASE_INPUT);
    expect(result).toMatchObject({ viewCount: 100, likeCount: 10, commentCount: 2, shareCount: 1 });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/video/query/");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-access-token");
    expect(JSON.parse(init.body as string)).toEqual({ filters: { video_ids: ["v_pub_url~abc123"] } });
  });

  it("throws CONTENT_ERROR when the response has no matching video", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: { videos: [] }, error: { code: "ok" } }), { status: 200 }),
    );
    const provider = new TikTokAnalyticsProvider();
    await expect(provider.fetchMetrics(BASE_INPUT)).rejects.toMatchObject({ code: "CONTENT_ERROR", retryable: false });
  });

  it("classifies a 401 as a permanent AUTH_ERROR", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "invalid token" }), { status: 401 }));
    const provider = new TikTokAnalyticsProvider();
    await expect(provider.fetchMetrics(BASE_INPUT)).rejects.toMatchObject({ code: "AUTH_ERROR", retryable: false });
  });
});
