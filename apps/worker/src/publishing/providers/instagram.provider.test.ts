import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { InstagramProvider } from "./instagram.provider.js";
import type { PublishInput } from "../types.js";

const BASE_INPUT: PublishInput = {
  contentId: "content-1",
  contentTargetId: "target-1",
  socialAccountId: "account-1",
  externalAccountId: "17841400000000000",
  accessToken: "test-access-token",
  caption: "hello world",
  title: null,
  assets: [{ type: "VIDEO", url: "https://media.example.com/source.mp4", platform: "INSTAGRAM" }],
  sound: null,
};

describe("InstagramProvider", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("publishes successfully through the real two-step container -> publish flow and fetches the permalink", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "container-123" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "media-456" }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ permalink: "https://www.instagram.com/reel/abc/" }), { status: 200 }),
      );

    const provider = new InstagramProvider();
    const result = await provider.publish(BASE_INPUT);

    expect(result.externalPostId).toBe("media-456");
    expect(result.externalPostUrl).toBe("https://www.instagram.com/reel/abc/");
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const [containerUrl, containerInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(containerUrl).toBe("https://graph.facebook.com/v19.0/17841400000000000/media");
    const containerBody = JSON.parse(containerInit.body as string);
    expect(containerBody.media_type).toBe("REELS");
    expect(containerBody.video_url).toBe("https://media.example.com/source.mp4");

    const [publishUrl, publishInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(publishUrl).toBe("https://graph.facebook.com/v19.0/17841400000000000/media_publish");
    expect(JSON.parse(publishInit.body as string).creation_id).toBe("container-123");
  });

  it("still reports success when the best-effort permalink lookup fails", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "container-123" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "media-456" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "not found" } }), { status: 400 }));

    const provider = new InstagramProvider();
    const result = await provider.publish(BASE_INPUT);
    expect(result.externalPostId).toBe("media-456");
    expect(result.externalPostUrl).toBeNull();
  });

  it("classifies a Meta OAuth error (code 190) as a permanent AUTH_ERROR", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: "Error validating access token", code: 190 } }), { status: 200 }),
    );
    const provider = new InstagramProvider();
    await expect(provider.publish(BASE_INPUT)).rejects.toMatchObject({ code: "AUTH_ERROR", retryable: false });
  });

  it("classifies a generic Graph API business error as a permanent CONTENT_ERROR", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: "Media type not supported", code: 9004 } }), { status: 200 }),
    );
    const provider = new InstagramProvider();
    await expect(provider.publish(BASE_INPUT)).rejects.toMatchObject({ code: "CONTENT_ERROR", retryable: false });
  });

  it("throws CONTENT_ERROR when there is no VIDEO or IMAGE asset", async () => {
    const provider = new InstagramProvider();
    await expect(provider.publish({ ...BASE_INPUT, assets: [] })).rejects.toMatchObject({
      code: "CONTENT_ERROR",
      retryable: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
