import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { YouTubeProvider } from "./youtube.provider.js";
import type { PublishInput } from "../types.js";

const BASE_INPUT: PublishInput = {
  contentId: "content-1",
  contentTargetId: "target-1",
  socialAccountId: "account-1",
  externalAccountId: "UC_test_channel",
  accessToken: "test-access-token",
  caption: "description text",
  title: "My video title",
  assets: [{ type: "VIDEO", url: "https://media.example.com/source.mp4", platform: null }],
  sound: null,
};

describe("YouTubeProvider", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs the real resumable-upload flow: init -> fetch source -> PUT bytes -> parse video id", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(null, { status: 200, headers: { location: "https://upload.example.com/session/abc" } }),
      )
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "yt-video-123" }), { status: 200 }));

    const provider = new YouTubeProvider();
    const result = await provider.publish(BASE_INPUT);

    expect(result.externalPostId).toBe("yt-video-123");
    expect(result.externalPostUrl).toBe("https://www.youtube.com/watch?v=yt-video-123");

    const [initUrl, initInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(initUrl).toContain("googleapis.com/upload/youtube/v3/videos");
    expect(initUrl).toContain("uploadType=resumable");
    const initBody = JSON.parse(initInit.body as string);
    expect(initBody.snippet.title).toBe("My video title");
    expect(initBody.status.privacyStatus).toBe("private");

    const [putUrl, putInit] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(putUrl).toBe("https://upload.example.com/session/abc");
    expect(putInit.method).toBe("PUT");
  });

  it("throws PLATFORM_ERROR (retryable) when the init response has no Location header", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    const provider = new YouTubeProvider();
    await expect(provider.publish(BASE_INPUT)).rejects.toMatchObject({ code: "PLATFORM_ERROR", retryable: true });
  });

  it("classifies a 401 on session init as a permanent AUTH_ERROR", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "invalid_grant" }), { status: 401 }));
    const provider = new YouTubeProvider();
    await expect(provider.publish(BASE_INPUT)).rejects.toMatchObject({ code: "AUTH_ERROR", retryable: false });
  });

  it("classifies a 403 quota-exceeded response on upload as a permanent AUTH_ERROR", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(null, { status: 200, headers: { location: "https://upload.example.com/session/abc" } }),
      )
      .mockResolvedValueOnce(new Response(new Uint8Array([1]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "quota exceeded" }), { status: 403 }));

    const provider = new YouTubeProvider();
    await expect(provider.publish(BASE_INPUT)).rejects.toMatchObject({ code: "AUTH_ERROR", retryable: false });
  });

  it("throws CONTENT_ERROR when there is no VIDEO asset", async () => {
    const provider = new YouTubeProvider();
    await expect(provider.publish({ ...BASE_INPUT, assets: [] })).rejects.toMatchObject({
      code: "CONTENT_ERROR",
      retryable: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
