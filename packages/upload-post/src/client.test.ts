import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { UploadPostClient, UploadPostError, startMockUploadPostServer, type MockUploadPostHandle } from "./index.js";

let mock: MockUploadPostHandle;
const KEY = "test-key-0000000000";
const logged: string[] = [];
const logger = {
  debug: (f: Record<string, unknown>, m: string) => logged.push(JSON.stringify({ f, m })),
  warn: (f: Record<string, unknown>, m: string) => logged.push(JSON.stringify({ f, m })),
};
const noSleep = async () => {};

function client(overrides: Partial<ConstructorParameters<typeof UploadPostClient>[0]> = {}) {
  return new UploadPostClient({ apiKey: KEY, baseUrl: mock.baseUrl, logger, sleep: noSleep, ...overrides });
}

async function expectError(promise: Promise<unknown>): Promise<UploadPostError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(UploadPostError);
    return err as UploadPostError;
  }
  throw new Error("expected an UploadPostError");
}

beforeAll(async () => {
  mock = await startMockUploadPostServer({ apiKey: KEY });
});
afterAll(async () => {
  await mock.close();
});
beforeEach(() => {
  mock.setDelay(0);
  mock.state.requests.length = 0;
  logged.length = 0;
});

describe("construction", () => {
  it("refuses a missing key and a non-https, non-loopback base URL", () => {
    expect(() => new UploadPostClient({ apiKey: "" })).toThrowError(/not configured/);
    expect(() => new UploadPostClient({ apiKey: KEY, baseUrl: "http://api.upload-post.com/api" })).toThrowError(/https/);
    expect(() => new UploadPostClient({ apiKey: KEY, baseUrl: "not a url" })).toThrowError(/valid URL/);
    expect(() => new UploadPostClient({ apiKey: KEY, baseUrl: "https://api.upload-post.com/api" })).not.toThrow();
  });
});

describe("authentication and account (GET /uploadposts/me)", () => {
  it("validates the key and returns plan information", async () => {
    const me = await client().getMe();
    expect(me.plan).toBe("Business");
    expect(me.email).toBe("owner@acme.test");
    expect(me.analyzeShorts).toMatchObject({ limit: 300, remaining: 288 });
    expect(mock.state.requests[0]).toMatchObject({ method: "GET", path: "/uploadposts/me", authorized: true });
  });

  it("maps a rejected key to AUTH without retrying and without leaking the key", async () => {
    const bad = client({ apiKey: "wrong-key-123456789" });
    const err = await expectError(bad.getMe());
    expect(err.kind).toBe("AUTH");
    expect(err.httpStatus).toBe(401);
    expect(err.retryable).toBe(false);
    expect(err.message).not.toContain("wrong-key-123456789");
    expect(mock.state.requests).toHaveLength(1); // 401 is not retried
  });

  it("ping() reports failure as data instead of throwing, with latency", async () => {
    const ok = await client().ping();
    expect(ok.ok).toBe(true);
    const bad = await client({ apiKey: "wrong-key-123456789" }).ping();
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.kind).toBe("AUTH");
    expect(bad.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

describe("secure logging", () => {
  it("never logs the API key, headers or bodies — and redacts a key echoed back in an error message", async () => {
    mock.script({ status: 500, body: { success: false, message: `boom while using ${KEY}` } }, 4);
    const err = await expectError(client().getMe());
    expect(err.kind).toBe("SERVER");
    expect(err.message).not.toContain(KEY);
    await client().getMe();
    const everything = logged.join("\n") + err.message + String(err.stack ?? "").split("\n")[0];
    expect(everything).not.toContain(KEY);
    expect(everything).not.toMatch(/authorization/i);
    expect(logged.length).toBeGreaterThan(0);
  });
});

describe("profiles (GET /uploadposts/users)", () => {
  it("normalizes profiles, stable provider ids vs changeable handles, reauth flags, capabilities and pending platforms", async () => {
    const list = await client().listProfiles();
    // capacity/plan come from the provider response, never from a constant
    expect(list.profileLimit).toBe(225);
    expect(list.plan).toBe("business");
    expect(list.profiles.map((p) => p.username)).toEqual(["acme_music", "label_two"]);

    const acme = list.profiles[0]!;
    expect(acme.displayName).toBe("Acme Music");
    expect(acme.createdAt?.toISOString()).toBe("2025-04-02T17:44:33.229Z");
    const tiktok = acme.accounts.find((a) => a.platform === "tiktok")!;
    expect(tiktok.providerAccountId).toBe("-000g91dgwXgwtNwcStableOpenId1"); // stable id (open_id)
    expect(tiktok.handle).toBe("acme.music"); // public, changeable
    expect(tiktok.capabilities).toContain("music");
    expect(tiktok.reauthRequired).toBe(false);
    expect(acme.accounts.find((a) => a.platform === "youtube")!.reauthRequired).toBe(true);
    expect(acme.accounts.map((a) => a.platform).sort()).toEqual(["instagram", "tiktok", "youtube"]); // facebook "" ignored

    const label = list.profiles[1]!;
    expect(label.displayName).toBeNull();
    expect(label.createdAt?.toISOString()).toBe("2025-05-02T21:43:14.000Z"); // RFC-1123 form
    expect(label.accounts).toHaveLength(1);
  });

  it("changes in the public handle do not change the stable id", async () => {
    mock.state.profiles[0]!.social_accounts.tiktok = {
      ...(mock.state.profiles[0]!.social_accounts.tiktok as object),
      username: "-000g91dgwXgwtNwcStableOpenId1",
      handle: "acme.renamed",
    } as never;
    const t = (await client().listProfiles()).profiles[0]!.accounts.find((a) => a.platform === "tiktok")!;
    expect(t.providerAccountId).toBe("-000g91dgwXgwtNwcStableOpenId1");
    expect(t.handle).toBe("acme.renamed");
    mock.state.profiles[0]!.social_accounts.tiktok = { ...(mock.state.profiles[0]!.social_accounts.tiktok as object), handle: "acme.music" } as never;
  });

  it("getProfile returns null for an unknown profile; createProfile surfaces conflicts and plan limits", async () => {
    expect(await client().getProfile("nope")).toBeNull();
    expect((await client().getProfile("acme_music"))?.username).toBe("acme_music");
    expect((await expectError(client().createProfile("acme_music"))).kind).toBe("CONFLICT");
    const before = mock.state.profileLimit;
    mock.state.profileLimit = mock.state.profiles.length;
    const limited = await expectError(client().createProfile("brand_new"));
    expect(limited.kind).toBe("FORBIDDEN_PLAN");
    expect(limited.errorCode).toBe("PROFILE_LIMIT_REACHED");
    mock.state.profileLimit = before;
  });
});

describe("timeouts, rate limits and retries", () => {
  it("times out a slow read, retries it, and reports TIMEOUT (retryable, outcome not unknown for reads)", async () => {
    mock.setDelay(200);
    const err = await expectError(client({ timeoutMs: 40, maxReadRetries: 2 }).getMe());
    expect(err.kind).toBe("TIMEOUT");
    expect(err.retryable).toBe(true);
    expect(err.outcomeUnknown).toBe(false);
    await new Promise((r) => setTimeout(r, 650));
    expect(mock.state.requests.filter((r) => r.path === "/uploadposts/me")).toHaveLength(3); // 1 + 2 retries
  });

  it("retries a short 429 using Retry-After and then succeeds", async () => {
    const sleeps: number[] = [];
    mock.script({ status: 429, body: { success: false, message: "slow down" }, headers: { "Retry-After": "2" } });
    const me = await client({ sleep: async (ms) => void sleeps.push(ms) }).getMe();
    expect(me.plan).toBe("Business");
    expect(sleeps).toEqual([2000]);
  });

  it("does not wait out a long Retry-After inside the client: it surfaces RATE_LIMITED with retryAfterMs for the queue", async () => {
    const sleeps: number[] = [];
    mock.script({ status: 429, body: { success: false, message: "slow down" }, headers: { "Retry-After": "120" } });
    const err = await expectError(client({ sleep: async (ms) => void sleeps.push(ms) }).getMe());
    expect(err).toMatchObject({ kind: "RATE_LIMITED", retryable: true, retryAfterMs: 120_000 });
    expect(sleeps).toEqual([]);
  });

  it("reads retry_after_seconds from the body when there is no header", async () => {
    mock.script({ status: 429, body: { success: false, message: "paused", retry_after_seconds: 900 } });
    const err = await expectError(client().getMe());
    expect(err.retryAfterMs).toBe(900_000);
  });

  it("treats a plan/quota 429 as QUOTA_EXCEEDED and never retries it", async () => {
    mock.script({ status: 429, body: { success: false, message: "Monthly limit exceeded", usage: { count: 10, limit: 10 } } });
    const err = await expectError(client().getMe());
    expect(err).toMatchObject({ kind: "QUOTA_EXCEEDED", retryable: false });
    mock.script({ status: 429, body: { success: false, error_code: "SCHEDULED_POSTS_LIMIT", message: "limit" } });
    expect((await expectError(client().getMe())).kind).toBe("QUOTA_EXCEEDED");
  });

  it("retries 5xx on reads, then gives up as SERVER", async () => {
    mock.script({ status: 503, body: { success: false, message: "temporary" } }, 3);
    const err = await expectError(client().getMe());
    expect(err).toMatchObject({ kind: "SERVER", httpStatus: 503, retryable: true });
    mock.script({ status: 503, body: { success: false, message: "temporary" } }, 1);
    expect((await client().getMe()).plan).toBe("Business"); // recovers after one 503
  });

  it("maps a refused connection to NETWORK", async () => {
    const err = await expectError(new UploadPostClient({ apiKey: KEY, baseUrl: "http://127.0.0.1:1/api", sleep: noSleep, maxReadRetries: 0 }).getMe());
    expect(err.kind).toBe("NETWORK");
    expect(err.retryable).toBe(true);
  });
});

describe("publishing correlation and duplicate protection", () => {
  const base = {
    profile: "acme_music",
    platforms: ["tiktok", "instagram"],
    externalId: "socialith:target:t1",
    requestId: "sl-req-0001",
    idempotencyKey: "sl-idem-0001",
    title: "Launch day",
  };

  it("sends external_id, request_id and an Idempotency-Key, always async, and returns the request id", async () => {
    const ack = await client().publishVideo({ ...base, videoUrl: "https://media.example.test/v.mp4" });
    expect(ack).toEqual({ kind: "ACCEPTED_ASYNC", requestId: "sl-req-0001", totalPlatforms: 2 });
    const pub = mock.state.publications.get("sl-req-0001")!;
    expect(pub.externalId).toBe("socialith:target:t1");
    expect(pub.fields.async_upload).toBe("true");
    expect(pub.fields.video).toBe("https://media.example.test/v.mp4");
    expect(pub.platforms).toEqual(["tiktok", "instagram"]);
    const sent = mock.state.requests.find((r) => r.path === "/upload")!;
    expect(sent.headers["idempotency-key"]).toBe("sl-idem-0001");
    expect(sent.headers["x-external-id"]).toBe("socialith:target:t1");
  });

  it("a retry with the same Idempotency-Key does NOT create a second provider job", async () => {
    const input = { ...base, requestId: "sl-req-0002", idempotencyKey: "sl-idem-0002", videoUrl: "https://media.example.test/v.mp4" };
    const first = await client().publishVideo(input);
    const before = mock.state.publications.size;
    const second = await client().publishVideo(input);
    expect(second).toEqual(first);
    expect(mock.state.publications.size).toBe(before);
    expect(mock.state.duplicatesPrevented).toBeGreaterThanOrEqual(1);
  });

  it("correlates by external_id (not title) through status and history", async () => {
    await client().publishVideo({ ...base, requestId: "sl-req-0003", idempotencyKey: "sl-idem-0003", title: "Same title", videoUrl: "https://m.example.test/a.mp4" });
    await client().publishVideo({ ...base, externalId: "socialith:target:t2", requestId: "sl-req-0004", idempotencyKey: "sl-idem-0004", title: "Same title", videoUrl: "https://m.example.test/b.mp4" });
    mock.finishPublication("sl-req-0003", "completed");
    mock.finishPublication("sl-req-0004", "failed");

    const s3 = await client().getStatus({ requestId: "sl-req-0003" });
    expect(s3).toMatchObject({ status: "completed", externalId: "socialith:target:t1", completed: 2, total: 2 });
    expect(s3.results[0]).toMatchObject({ platform: "tiktok", success: true });
    expect(s3.results[0]!.postUrl).toContain("https://example.test/tiktok/");

    const h = await client().getHistory({ externalId: "socialith:target:t2" });
    expect(h.items.length).toBe(2);
    expect(h.items.every((i) => i.externalId === "socialith:target:t2" && !i.success)).toBe(true);
    expect(h.items[0]!.errorMessage).toBe("Platform rejected the upload");
  });

  it("returns not_found (not an exception) for an unknown request id", async () => {
    const s = await client().getStatus({ requestId: "does-not-exist" });
    expect(s.status).toBe("not_found");
  });

  it("a publish that times out reports outcomeUnknown and is NOT retried by the client", async () => {
    mock.setDelay(200);
    const err = await expectError(
      client({ writeTimeoutMs: 40 }).publishVideo({ ...base, requestId: "sl-req-0005", idempotencyKey: "sl-idem-0005", videoUrl: "https://m.example.test/c.mp4" }),
    );
    expect(err).toMatchObject({ kind: "TIMEOUT", outcomeUnknown: true });
    await new Promise((r) => setTimeout(r, 350));
    expect(mock.state.requests.filter((r) => r.path === "/upload" && r.headers["idempotency-key"] === "sl-idem-0005")).toHaveLength(1);
  });

  it("surfaces a platform that is not connected to the profile as a validation error, and external_id length limits", async () => {
    const err = await expectError(client().publishVideo({ ...base, platforms: ["facebook"], requestId: "sl-req-0006", idempotencyKey: "sl-idem-0006", videoUrl: "https://m.example.test/d.mp4" }));
    expect(err.kind).toBe("VALIDATION");
    const tooLong = await expectError(client().publishVideo({ ...base, externalId: "x".repeat(256), videoUrl: "https://m.example.test/e.mp4" }));
    expect(tooLong.kind).toBe("VALIDATION");
  });

  it("publishes photos with photos[] URLs", async () => {
    const ack = await client().publishPhotos({ ...base, requestId: "sl-req-0007", idempotencyKey: "sl-idem-0007", photoUrls: ["https://m.example.test/1.jpg", "https://m.example.test/2.jpg"] });
    expect(ack.kind).toBe("ACCEPTED_ASYNC");
    expect(mock.state.publications.get("sl-req-0007")!.mediaType).toBe("photo");
  });
});

describe("scheduling endpoints", () => {
  const future = () => new Date(Date.now() + 3 * 86_400_000).toISOString();
  const base = { profile: "acme_music", platforms: ["tiktok"], title: "Later", videoUrl: "https://m.example.test/s.mp4" };

  it("schedules (job_id), lists, edits, and cancels; cancelling twice is reported as already gone", async () => {
    const ack = await client().publishVideo({ ...base, externalId: "socialith:target:s1", requestId: "sl-req-s1", idempotencyKey: "sl-idem-s1", scheduledDate: future() });
    expect(ack.kind).toBe("SCHEDULED");
    if (ack.kind !== "SCHEDULED") return;
    expect(mock.state.publications.has("sl-req-s1")).toBe(false); // nothing is published now

    const list = await client().listScheduled({ profile: "acme_music" });
    expect(list.jobs.find((j) => j.jobId === ack.jobId)).toMatchObject({ externalId: "socialith:target:s1", platforms: ["tiktok"] });

    const newDate = new Date(Date.now() + 5 * 86_400_000).toISOString();
    await client().editScheduled(ack.jobId, { scheduledDate: newDate, timezone: "UTC" });
    expect(mock.state.jobs.get(ack.jobId)!.scheduledDate).toBe(newDate);

    expect(await client().cancelScheduled(ack.jobId)).toMatchObject({ cancelled: true, alreadyGone: false });
    expect(await client().cancelScheduled(ack.jobId)).toMatchObject({ cancelled: false, alreadyGone: true });
    expect((await client().getStatus({ jobId: ack.jobId })).status).toBe("failed"); // cancelled jobs never publish
  });

  it("editing a job that is publishing now / due within 60 s is a CONFLICT", async () => {
    const soon = new Date(Date.now() + 30_000).toISOString();
    const ack = await client().publishVideo({ ...base, externalId: "socialith:target:s2", requestId: "sl-req-s2", idempotencyKey: "sl-idem-s2", scheduledDate: soon });
    if (ack.kind !== "SCHEDULED") throw new Error("expected scheduled");
    const err = await expectError(client().editScheduled(ack.jobId, { scheduledDate: future() }));
    expect(err).toMatchObject({ kind: "CONFLICT", errorCode: "scheduled_post_in_progress" });
  });

  it("a scheduled job reports completed with results once it has run", async () => {
    const ack = await client().publishVideo({ ...base, externalId: "socialith:target:s3", requestId: "sl-req-s3", idempotencyKey: "sl-idem-s3", scheduledDate: future() });
    if (ack.kind !== "SCHEDULED") throw new Error("expected scheduled");
    expect((await client().getStatus({ jobId: ack.jobId })).status).toBe("pending");
    mock.runScheduledJob(ack.jobId);
    const done = await client().getStatus({ jobId: ack.jobId });
    expect(done).toMatchObject({ status: "completed", externalId: "socialith:target:s3" });
    expect(done.results[0]!.platformPostId).toContain(ack.jobId);
  });
});

describe("TikTok settings and music (capability gated)", () => {
  it("reads publishing settings", async () => {
    const s = await client().getTikTokSettings("acme_music");
    expect(s.privacyLevelOptions).toContain("PUBLIC_TO_EVERYONE");
    expect(s.maxVideoPostDurationSec).toBe(600);
  });

  it("searches and lists trending tracks, labelled as Commercial Music Library chart data", async () => {
    const found = await client().searchTikTokMusic({ profile: "acme_music", query: "neon" });
    expect(found.tracks.map((t) => t.id)).toEqual(["7012345678901234567"]);
    expect(found.tracks[0]).toMatchObject({ title: "Neon Skyline", artist: "Wave Theory", commercialMusicId: "6987654321098765432" });
    expect(found.scope).toBe("COMMERCIAL_MUSIC_LIBRARY_CHARTS");
    const trending = await client().trendingTikTokMusic({ profile: "acme_music" });
    expect(trending.tracks).toHaveLength(2);
  });

  it("a profile whose TikTok connection lacks the music capability is REAUTH_REQUIRED (reconnect), never a silent empty list", async () => {
    const err = await expectError(client().searchTikTokMusic({ profile: "label_two", query: "x" }));
    expect(err).toMatchObject({ kind: "REAUTH_REQUIRED", errorCode: "tiktok_reconnect_required" });
  });

  it("an expired TikTok token (409 reauth_required) is REAUTH_REQUIRED", async () => {
    const tt = mock.state.profiles[0]!.social_accounts.tiktok as { reauth_required?: boolean };
    tt.reauth_required = true;
    const err = await expectError(client().getTikTokSettings("acme_music"));
    tt.reauth_required = false;
    expect(err.kind).toBe("REAUTH_REQUIRED");
  });
});
