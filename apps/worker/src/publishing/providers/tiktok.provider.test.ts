import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { TikTokProvider } from "./tiktok.provider.js";
import type { PublishInput } from "../types.js";

const BASE_INPUT: PublishInput = {
  contentId: "content-1",
  contentTargetId: "target-1",
  socialAccountId: "account-1",
  externalAccountId: "tiktok-user-1",
  accessToken: "test-access-token",
  caption: "hello world",
  title: "My video",
  assets: [{ type: "VIDEO", url: "https://media.example.com/source.mp4", platform: null }],
  sound: null,
};

describe("TikTokProvider", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("publishes via the real Upload/Inbox endpoint (this app's real scope is video.upload, not video.publish)", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: { publish_id: "v_inbox_file~v2.abc123" }, error: { code: "ok", message: "" } }), {
        status: 200,
      }),
    );

    const provider = new TikTokProvider();
    const result = await provider.publish(BASE_INPUT);

    expect(result.externalPostId).toBe("v_inbox_file~v2.abc123");
    expect(result.externalPostUrl).toBeNull();
    expect(result.pendingConfirmation).toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1); // no preliminary creator_info call — the Upload flow doesn't need one
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://open.tiktokapis.com/v2/post/publish/inbox/video/init/");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-access-token");
    const body = JSON.parse(init.body as string);
    // The real, documented request shape has ONLY source_info — no
    // post_info/title/privacy_level (those are Direct Post-only fields).
    expect(body).toEqual({ source_info: { source: "PULL_FROM_URL", video_url: "https://media.example.com/source.mp4" } });
  });

  it("records that the caption/title were prepared but not transmitted (the Upload API has no field for them)", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: { publish_id: "v_inbox_file~v2.abc123" }, error: { code: "ok", message: "" } }), {
        status: 200,
      }),
    );
    const provider = new TikTokProvider();
    const result = await provider.publish(BASE_INPUT);
    expect(result.responseMetadata.captionNotTransmitted).toBe(true);
    expect(result.responseMetadata.flow).toBe("UPLOAD_INBOX");
  });

  it("throws CONTENT_ERROR when there is no VIDEO asset", async () => {
    const provider = new TikTokProvider();
    await expect(provider.publish({ ...BASE_INPUT, assets: [] })).rejects.toMatchObject({
      code: "CONTENT_ERROR",
      retryable: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("classifies a 401 response as a permanent AUTH_ERROR", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "invalid token" }), { status: 401 }));
    const provider = new TikTokProvider();
    await expect(provider.publish(BASE_INPUT)).rejects.toMatchObject({ code: "AUTH_ERROR", retryable: false });
  });

  it("treats a 200 response with a business-logic error.code as a permanent failure", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "spam_risk_too_many_posts", message: "Too many posts" } }), {
        status: 200,
      }),
    );
    const provider = new TikTokProvider();
    await expect(provider.publish(BASE_INPUT)).rejects.toMatchObject({ code: "CONTENT_ERROR", retryable: false });
  });

  it("classifies a 500 response as a retryable PLATFORM_ERROR", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "server error" }), { status: 500 }));
    const provider = new TikTokProvider();
    await expect(provider.publish(BASE_INPUT)).rejects.toMatchObject({ code: "PLATFORM_ERROR", retryable: true });
  });

  it("publishes successfully even with a Sound attached, but honestly records it as not applied (no API support)", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: { publish_id: "v_inbox_file~v2.abc123" }, error: { code: "ok", message: "" } }), {
        status: 200,
      }),
    );
    const provider = new TikTokProvider();
    const result = await provider.publish({
      ...BASE_INPUT,
      sound: { title: "Alroca - X", artist: "Alroca", externalSoundId: "7123456789012345678", soundUrl: "https://www.tiktok.com/music/Alroca-X-7123456789012345678" },
    });

    expect(result.externalPostId).toBe("v_inbox_file~v2.abc123");
    const soundMeta = result.responseMetadata.sound as Record<string, unknown>;
    expect(soundMeta.capability).toBe("NOT_SUPPORTED_BY_API");
    expect((soundMeta.requested as Record<string, unknown>).title).toBe("Alroca - X");

    // Never sent as a request field — there is nowhere for it to go in the real API contract.
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sentBody = JSON.parse(init.body as string);
    expect(sentBody.sound_id).toBeUndefined();
    expect(sentBody.music_id).toBeUndefined();
  });
});

describe("TikTokProvider.checkPublishStatus", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("hits the real Get Post Status endpoint with the publish_id", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: { status: "PROCESSING_DOWNLOAD" }, error: { code: "ok", message: "" } }), { status: 200 }),
    );
    const provider = new TikTokProvider();
    await provider.checkPublishStatus("access-token", "v_inbox_file~v2.abc123");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://open.tiktokapis.com/v2/post/publish/status/fetch/");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ publish_id: "v_inbox_file~v2.abc123" });
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer access-token");
  });

  it.each(["PROCESSING_UPLOAD", "PROCESSING_DOWNLOAD"])("treats a real %s response as still PROCESSING", async (status) => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: { status }, error: { code: "ok", message: "" } }), { status: 200 }),
    );
    const provider = new TikTokProvider();
    const result = await provider.checkPublishStatus("access-token", "v_inbox_file~v2.abc123");
    expect(result.status).toBe("PROCESSING");
  });

  it("SEND_TO_USER_INBOX is a real terminal COMPLETE — this app's real Upload/Inbox flow never auto-publishes", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: { status: "SEND_TO_USER_INBOX" }, error: { code: "ok", message: "" } }), { status: 200 }),
    );
    const provider = new TikTokProvider();
    const result = await provider.checkPublishStatus("access-token", "v_inbox_file~v2.abc123");
    expect(result.status).toBe("COMPLETE");
    expect(result.externalPostId).toBe("v_inbox_file~v2.abc123"); // no real public post id exists yet
    expect(result.externalPostUrl).toBeNull();
    expect(result.deliveryNote).toMatch(/inbox/i);
    expect(result.deliveryNote).toMatch(/not public/i);
  });

  it("PUBLISH_COMPLETE with a real publicaly_available_post_id returns the exact real post id, with no int64 precision loss", async () => {
    // Built as a raw string, deliberately NOT via JSON.stringify(jsObject)
    // — a JS number literal this large (7.1e18, past Number.MAX_SAFE_INTEGER)
    // would already lose precision the moment the *test* wrote it, before
    // the provider's own code ever ran. This raw string simulates the
    // real wire bytes TikTok would actually send.
    fetchMock.mockResolvedValue(
      new Response(
        '{"data":{"status":"PUBLISH_COMPLETE","publicaly_available_post_id":[7123456789012345678]},"error":{"code":"ok","message":""}}',
        { status: 200 },
      ),
    );
    const provider = new TikTokProvider();
    const result = await provider.checkPublishStatus("access-token", "v_inbox_file~v2.abc123");
    expect(result.status).toBe("COMPLETE");
    expect(result.externalPostId).toBe("7123456789012345678");
    expect(result.deliveryNote).toBeUndefined(); // a real Direct-Post-style completion has no "not public yet" caveat
    // Never a guessed/constructed permalink — TikTok's status response doesn't provide one.
    expect(result.externalPostUrl).toBeNull();
  });

  it("FAILED returns the real fail_reason", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ data: { status: "FAILED", fail_reason: "video_duration_too_long" }, error: { code: "ok", message: "" } }),
        { status: 200 },
      ),
    );
    const provider = new TikTokProvider();
    const result = await provider.checkPublishStatus("access-token", "v_inbox_file~v2.abc123");
    expect(result.status).toBe("FAILED");
    expect(result.failReason).toBe("video_duration_too_long");
  });

  it("classifies invalid_publish_id as a permanent CONTENT_ERROR", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "invalid_publish_id", message: "Publish id not found" } }), { status: 200 }),
    );
    const provider = new TikTokProvider();
    await expect(provider.checkPublishStatus("access-token", "bogus-id")).rejects.toMatchObject({
      code: "CONTENT_ERROR",
      retryable: false,
    });
  });

  it("classifies a real rate_limit_exceeded response as retryable", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "rate_limit_exceeded", message: "Too many requests" } }), { status: 200 }),
    );
    const provider = new TikTokProvider();
    await expect(provider.checkPublishStatus("access-token", "v_inbox_file~v2.abc123")).rejects.toMatchObject({
      code: "PLATFORM_ERROR",
      retryable: true,
    });
  });

  it("treats a 401 HTTP response as a permanent AUTH_ERROR", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "invalid token" }), { status: 401 }));
    const provider = new TikTokProvider();
    await expect(provider.checkPublishStatus("access-token", "v_inbox_file~v2.abc123")).rejects.toMatchObject({
      code: "AUTH_ERROR",
      retryable: false,
    });
  });
});
