import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { InstagramAnalyticsProvider } from "./instagram.analytics-provider.js";
import type { FetchMetricsInput } from "../types.js";

const BASE_INPUT: FetchMetricsInput = {
  externalPostId: "media-456",
  externalAccountId: "17841400000000000",
  accessToken: "test-access-token",
};

describe("InstagramAnalyticsProvider", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches real like/comment counts and leaves unsupported fields null", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ like_count: 25, comments_count: 4 }), { status: 200 }));
    const provider = new InstagramAnalyticsProvider();
    const result = await provider.fetchMetrics(BASE_INPUT);
    expect(result).toMatchObject({ likeCount: 25, commentCount: 4, viewCount: null, shareCount: null });

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain("/media-456");
    expect(url).toContain("fields=like_count,comments_count");
  });

  it("classifies a Meta OAuth error (code 190) as a permanent AUTH_ERROR", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "Error validating access token", code: 190 } }), { status: 200 }),
    );
    const provider = new InstagramAnalyticsProvider();
    await expect(provider.fetchMetrics(BASE_INPUT)).rejects.toMatchObject({ code: "AUTH_ERROR", retryable: false });
  });
});
