import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@socialith/database";
import { buildTargetPayload } from "@socialith/publishing";
import { UploadPostClient, defaultProfiles, startMockUploadPostServer, type MockUploadPostHandle } from "@socialith/upload-post";

// The processors obtain their client from this module; point it at the contract double.
const holder = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("../upload-post/client.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../upload-post/client.js")>();
  return { ...original, getUploadPostClient: () => holder.client };
});
// A native provider must never be reached for an Upload-Post destination.
vi.mock("../publishing/resolve-provider.js", () => ({
  resolvePublishingProvider: vi.fn(() => {
    throw new Error("NATIVE PROVIDER MUST NOT BE REACHED");
  }),
}));

import { processPublishing } from "../processors/publishing.processor.js";
import { processPublishStatusPoll } from "../processors/publish-status-poll.processor.js";
import { processUploadPost } from "../processors/upload-post.processor.js";
import { syncUploadPostProfiles } from "../upload-post/sync.js";
import { PublishError } from "../publishing/types.js";

/**
 * REAL MySQL + the real HTTP client against the in-memory Upload-Post contract double.
 * Nothing here ever reaches the live service, and nothing is "published" anywhere.
 */
const enabled = Boolean(process.env.MYSQL_INTEGRATION_URL && process.env.REDIS_INTEGRATION_URL);
const suite = enabled ? describe : describe.skip;
const silent = { info: () => undefined, warn: () => undefined };
const KEY = "test-key-0000000000";
let mock: MockUploadPostHandle;

function makeClient(overrides: Partial<ConstructorParameters<typeof UploadPostClient>[0]> = {}) {
  return new UploadPostClient({ apiKey: KEY, baseUrl: mock.baseUrl, sleep: async () => {}, maxReadRetries: 0, ...overrides });
}

async function setup(platform: "tiktok" | "instagram" | "youtube" = "tiktok", assetType: "VIDEO" | "IMAGE" = "VIDEO", profile = "acme_music") {
  const org = await prisma.organization.create({ data: { name: "IT UPP", slug: `it-upp-${randomUUID().slice(0, 8)}` } });
  await syncUploadPostProfiles({ db: prisma, client: makeClient(), log: silent }, org.id, "MANUAL");
  const profileRow = await prisma.uploadPostProfile.findUniqueOrThrow({ where: { organizationId_username: { organizationId: org.id, username: profile } } });
  const acc = await prisma.uploadPostConnectedAccount.findUniqueOrThrow({ where: { profileId_platform: { profileId: profileRow.id, platform } } });
  const social = await prisma.socialAccount.create({
    data: { organizationId: org.id, platform: platform.toUpperCase() as "TIKTOK", externalAccountId: acc.providerAccountId, handle: acc.handle ?? "", displayName: acc.displayName ?? "", publishingProvider: "UPLOAD_POST" },
  });
  await prisma.uploadPostConnectedAccount.update({ where: { id: acc.id }, data: { socialAccountId: social.id } });
  const content = await prisma.content.create({ data: { organizationId: org.id, caption: "Launch day #newmusic", status: "PUBLISHING" } });
  await prisma.contentAsset.create({ data: { contentId: content.id, type: assetType, url: assetType === "VIDEO" ? "https://media.example.test/v.mp4" : "https://media.example.test/p.jpg" } });
  const target = await prisma.contentTarget.create({ data: { contentId: content.id, socialAccountId: social.id, status: "PUBLISHING" } });
  return { org, social, content, target, acc };
}

const run = (targetId: string) => processPublishing({ data: { contentTargetId: targetId } } as never);
const poll = (targetId: string, attempt = 1) => processPublishStatusPoll({ data: { contentTargetId: targetId, attempt } } as never);
const target = (id: string) => prisma.contentTarget.findUniqueOrThrow({ where: { id } });
const publication = (targetId: string) => prisma.uploadPostPublication.findUniqueOrThrow({ where: { contentTargetId: targetId } });
const providerRequests = (path: string) => mock.state.requests.filter((r) => r.method === "POST" && r.path === path);

suite("Upload-Post publishing (real MySQL, contract double)", () => {
  beforeAll(async () => {
    mock = await startMockUploadPostServer({ apiKey: KEY });
  });
  afterAll(async () => {
    await mock.close();
    await prisma.organization.deleteMany({ where: { slug: { startsWith: "it-upp-" } } });
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await prisma.organization.deleteMany({ where: { slug: { startsWith: "it-" } } });
    mock.state.profiles = defaultProfiles();
    mock.state.publications.clear();
    mock.state.jobs.clear();
    mock.state.idempotency.clear();
    mock.state.requests.length = 0;
    mock.setDelay(0);
    mock.setResponseDelay(0);
    holder.client = makeClient();
  });

  it("publishes a video asynchronously, correlates by external_id, and finalizes through the status poll", async () => {
    const { target: t, content } = await setup();
    await run(t.id);

    const pub = await publication(t.id);
    expect(pub).toMatchObject({ status: "PROCESSING", mode: "IMMEDIATE", generation: 1, profileUsername: "acme_music", platform: "tiktok" });
    expect(pub.externalId).toBe(`socialith:target:${t.id}:g1`);
    const provider = mock.state.publications.get(pub.requestId)!;
    expect(provider.externalId).toBe(pub.externalId); // correlation by external_id, never by title
    expect(provider.platforms).toEqual(["tiktok"]);
    expect(provider.fields.async_upload).toBe("true");
    expect(provider.fields.video).toBe("https://media.example.test/v.mp4");
    expect(provider.fields.tiktok_title).toBe("Launch day #newmusic");

    // not published yet: Socialith waits for the provider
    expect(await target(t.id)).toMatchObject({ status: "PUBLISHING", externalPostId: pub.requestId, attemptCount: 1 });
    expect(await prisma.publishAttempt.count({ where: { contentTargetId: t.id, status: "SUCCEEDED" } })).toBe(1);

    expect(await poll(t.id)).toBeUndefined();
    expect((await target(t.id)).status).toBe("PUBLISHING"); // provider still pending

    mock.finishPublication(pub.requestId, "completed");
    await poll(t.id, 2);
    expect(await target(t.id)).toMatchObject({ status: "PUBLISHED", externalPostUrl: expect.stringContaining("https://example.test/tiktok/") });
    expect((await publication(t.id)).status).toBe("COMPLETED");
    expect((await prisma.content.findUniqueOrThrow({ where: { id: content.id } })).status).toBe("PUBLISHED");
  });

  it("publishes photos through the photo endpoint", async () => {
    const { target: t } = await setup("instagram", "IMAGE");
    await run(t.id);
    const pub = await publication(t.id);
    expect(providerRequests("/upload_photos")).toHaveLength(1);
    expect(providerRequests("/upload")).toHaveLength(0);
    expect(mock.state.publications.get(pub.requestId)!.mediaType).toBe("photo");
  });

  it("DUPLICATE PROTECTION: a redelivered job never creates a second provider publication", async () => {
    const { target: t } = await setup();
    await run(t.id);
    await run(t.id); // BullMQ redelivery / reconciler re-enqueue
    await run(t.id);
    expect(mock.state.publications.size).toBe(1);
    expect(providerRequests("/upload")).toHaveLength(1);
    expect(await prisma.uploadPostPublication.count({ where: { contentTargetId: t.id } })).toBe(1);
  });

  it("DUPLICATE PROTECTION: a timeout (outcome unknown) is retried by ASKING the provider first — never by blind resend", async () => {
    const { target: t } = await setup();
    holder.client = makeClient({ writeTimeoutMs: 60 });
    mock.setResponseDelay(250); // the provider receives and PROCESSES the request, but its answer reaches us too late
    await expect(run(t.id)).rejects.toThrow();
    expect((await publication(t.id)).status).toBe("UNKNOWN_OUTCOME");

    await new Promise((r) => setTimeout(r, 400)); // the provider finished creating it meanwhile
    expect(mock.state.publications.size).toBe(1);

    mock.setResponseDelay(0);
    holder.client = makeClient();
    await run(t.id); // BullMQ retry
    expect(mock.state.publications.size).toBe(1); // adopted, not re-created
    expect(providerRequests("/upload")).toHaveLength(1);
    expect((await publication(t.id)).status).toBe("PROCESSING");
  });

  it("an unknown outcome that never reached the provider is safely re-sent (same request id and Idempotency-Key)", async () => {
    const { target: t } = await setup();
    mock.script({ status: 503, body: { success: false, message: "temporary" } });
    await expect(run(t.id)).rejects.toThrow();
    expect(mock.state.publications.size).toBe(0);
    await run(t.id);
    expect(mock.state.publications.size).toBe(1);
    const sent = providerRequests("/upload");
    expect(sent).toHaveLength(2);
    expect(sent[0]!.headers["idempotency-key"]).toBe(sent[1]!.headers["idempotency-key"]);
  });

  describe("invalid provider responses are an UNKNOWN outcome — never a success, never a blind resend", () => {
    const upload = (m: string, p: string) => m === "POST" && p === "/upload";
    for (const [label, body] of [["an HTML error page", "<html><body>502 Bad Gateway</body></html>"], ["an empty answer", ""], ["JSON without any id", { success: true }]] as const) {
      it(`HTTP 200 with ${label}: marked UNKNOWN_OUTCOME, the target is not published, and the retry asks the provider before re-sending (same Idempotency-Key)`, async () => {
        const { target: t } = await setup();
        mock.script({ match: upload, status: 200, body });
        await expect(run(t.id)).rejects.toThrow();
        expect(await publication(t.id)).toMatchObject({ status: "UNKNOWN_OUTCOME", lastErrorKind: "INVALID_RESPONSE" });
        expect((await target(t.id)).status).toBe("PUBLISHING"); // neither published nor failed: nobody knows yet
        expect(mock.state.publications.size).toBe(0); // it never reached the provider in this scenario

        await run(t.id); // the retry
        expect(mock.state.publications.size).toBe(1);
        const sent = providerRequests("/upload");
        expect(sent).toHaveLength(2); // the status check found nothing, so it is re-sent …
        expect(sent[0]!.headers["idempotency-key"]).toBe(sent[1]!.headers["idempotency-key"]); // … with the SAME key
        expect((await publication(t.id)).status).toBe("PROCESSING");
      });
    }

    it("if the provider DID create the job although its answer was unreadable, the retry adopts it: still exactly one provider job", async () => {
      const { target: t } = await setup();
      mock.script({ match: upload, status: 200, body: "<html>proxy error</html>" });
      await expect(run(t.id)).rejects.toThrow();
      const pub = await publication(t.id);
      // the provider had in fact accepted it (the answer was mangled on the way back)
      mock.state.publications.set(pub.requestId, { requestId: pub.requestId, externalId: pub.externalId, profile: "acme_music", platforms: ["tiktok"], status: "processing", results: [], fields: {}, mediaType: "video" });
      mock.state.requests.length = 0;
      await run(t.id);
      expect(providerRequests("/upload")).toHaveLength(0); // adopted, not re-sent
      expect(mock.state.publications.size).toBe(1);
      expect((await publication(t.id)).status).toBe("PROCESSING");
    });

    it("an unreadable STATUS answer never marks anything published", async () => {
      const { target: t } = await setup();
      await run(t.id);
      mock.script({ match: (m, p) => m === "GET" && p === "/uploadposts/status", status: 200, body: "<html>maintenance</html>" }, 1); // exactly the one status request the poll makes: a scripted answer must never outlive its test
      await poll(t.id, 2).catch(() => undefined);
      expect((await target(t.id)).status).toBe("PUBLISHING");
      expect((await publication(t.id)).status).not.toBe("COMPLETED");
    });
  });
  it("a provider-side failure finalizes the target and content as FAILED with the provider's reason", async () => {
    const { target: t, content } = await setup();
    await run(t.id);
    const pub = await publication(t.id);
    mock.finishPublication(pub.requestId, "failed");
    await poll(t.id);
    expect(await target(t.id)).toMatchObject({ status: "FAILED", errorMessage: "Platform rejected the upload" });
    expect((await prisma.content.findUniqueOrThrow({ where: { id: content.id } })).status).toBe("FAILED");
    expect((await publication(t.id)).status).toBe("FAILED");
  });

  it("a deliberate retry of a FAILED target is a NEW provider job (generation 2), not a resend of the old one", async () => {
    const { target: t } = await setup();
    await run(t.id);
    const first = await publication(t.id);
    mock.finishPublication(first.requestId, "failed");
    await poll(t.id);
    await prisma.contentTarget.update({ where: { id: t.id }, data: { status: "PUBLISHING", errorMessage: null } }); // what "Retry" does
    await run(t.id);
    const second = await publication(t.id);
    expect(second.generation).toBe(2);
    expect(second.externalId).toBe(`socialith:target:${t.id}:g2`);
    expect(second.requestId).not.toBe(first.requestId);
    expect(mock.state.publications.size).toBe(2);
  });

  describe("provider error classification", () => {
    async function failWith(status: number, body: object, headers?: Record<string, string>) {
      const { target: t, social } = await setup();
      mock.script({ status, body, headers });
      let error: unknown;
      try {
        await run(t.id);
      } catch (err) {
        error = err;
      }
      return { t, social, error, attempt: await prisma.publishAttempt.findFirst({ where: { contentTargetId: t.id }, orderBy: { attemptNumber: "desc" } }) };
    }

    it("a rejected API key is a CONFIGURATION_ERROR (permanent) and does NOT flag the social account", async () => {
      const r = await failWith(401, { success: false, message: "Invalid or expired token" });
      expect(r.attempt).toMatchObject({ errorCode: "CONFIGURATION_ERROR", retryable: false });
      expect((await target(r.t.id)).status).toBe("FAILED");
      expect((await prisma.socialAccount.findUniqueOrThrow({ where: { id: r.social.id } })).status).toBe("CONNECTED");
    });

    it("a reconnect-required account is an AUTH_ERROR (permanent) and DOES flag the destination", async () => {
      const r = await failWith(409, { success: false, reauth_required: true, message: "Token expired" });
      expect(r.attempt).toMatchObject({ errorCode: "AUTH_ERROR", retryable: false });
      expect((await prisma.socialAccount.findUniqueOrThrow({ where: { id: r.social.id } })).status).toBe("ERROR");
    });

    it("a rate limit is retryable: the target stays PUBLISHING, the error is thrown for BullMQ, Retry-After is recorded", async () => {
      const r = await failWith(429, { success: false, message: "slow down" }, { "Retry-After": "120" });
      expect(r.error).toBeInstanceOf(Error);
      expect(r.attempt).toMatchObject({ errorCode: "RATE_LIMITED", retryable: true });
      expect(r.attempt!.rateLimitResetAt).not.toBeNull();
      expect((await target(r.t.id)).status).toBe("PUBLISHING");
    });

    it("a plan/quota limit is permanent; a 5xx is retryable; a validation error is a CONTENT_ERROR", async () => {
      expect((await failWith(429, { success: false, message: "Monthly limit exceeded", usage: { count: 10, limit: 10 } })).attempt).toMatchObject({ errorCode: "CONFIGURATION_ERROR", retryable: false });
      expect((await failWith(503, { success: false, message: "down" })).attempt).toMatchObject({ errorCode: "PLATFORM_ERROR", retryable: true });
      expect((await failWith(400, { success: false, message: "bad media" })).attempt).toMatchObject({ errorCode: "CONTENT_ERROR", retryable: false });
    });
  });

  describe("destination safety (the provider is never called)", () => {
    it("refuses a destination whose account needs reconnecting, is disconnected, or whose identity changed", async () => {
      for (const [patch, code] of [
        [{ status: "REAUTH_REQUIRED" as const }, "AUTH_ERROR"],
        [{ status: "DISCONNECTED" as const }, "AUTH_ERROR"],
        [{ providerAccountId: "someone-else" }, "CONFIGURATION_ERROR"],
      ] as const) {
        const { target: t, acc } = await setup();
        await prisma.uploadPostConnectedAccount.update({ where: { id: acc.id }, data: patch });
        mock.state.requests.length = 0;
        await run(t.id);
        expect((await prisma.publishAttempt.findFirstOrThrow({ where: { contentTargetId: t.id } })).errorCode).toBe(code);
        expect((await target(t.id)).status).toBe("FAILED");
        expect(providerRequests("/upload")).toHaveLength(0);
      }
    });

    it("refuses a destination whose profile the provider reports as blocked, without any provider call", async () => {
      const { target: t, acc } = await setup();
      await prisma.uploadPostProfile.update({ where: { id: acc.profileId }, data: { blocked: true } });
      mock.state.requests.length = 0;
      await run(t.id);
      const attempt = await prisma.publishAttempt.findFirstOrThrow({ where: { contentTargetId: t.id } });
      expect(attempt.errorCode).toBe("CONFIGURATION_ERROR");
      expect(attempt.errorMessage).toMatch(/blocked/);
      expect((await target(t.id)).status).toBe("FAILED");
      expect(providerRequests("/upload")).toHaveLength(0);
    });

    it("refuses an unlinked destination and content with nothing to publish", async () => {
      const { target: t, acc } = await setup();
      await prisma.uploadPostConnectedAccount.update({ where: { id: acc.id }, data: { socialAccountId: null } });
      await run(t.id);
      expect((await prisma.publishAttempt.findFirstOrThrow({ where: { contentTargetId: t.id } })).errorCode).toBe("CONFIGURATION_ERROR");

      const b = await setup();
      await prisma.contentAsset.deleteMany({ where: { contentId: b.content.id } });
      await run(b.target.id);
      expect((await prisma.publishAttempt.findFirstOrThrow({ where: { contentTargetId: b.target.id } })).errorCode).toBe("CONTENT_ERROR");
      expect(providerRequests("/upload")).toHaveLength(0);
    });

    it("never publishes a demo/seed account (the existing guard still runs first)", async () => {
      const { target: t, social } = await setup();
      await prisma.socialAccount.update({ where: { id: social.id }, data: { providerMetadata: { seed: true } } });
      await run(t.id);
      expect(providerRequests("/upload")).toHaveLength(0);
      expect((await prisma.publishAttempt.findFirstOrThrow({ where: { contentTargetId: t.id } })).errorCode).toBe("CONFIGURATION_ERROR");
    });
  });

  describe("Publishing Center: approval gate, destination-specific text, required track", () => {
    async function requireApproval(orgId: string) {
      await prisma.publishingSettings.create({ data: { organizationId: orgId, requireApproval: true } });
    }
    async function approveNow(targetId: string) {
      const t = await prisma.contentTarget.findUniqueOrThrow({ where: { id: targetId }, include: { socialAccount: { select: { platform: true } }, content: { include: { variations: true, assets: true } } } });
      const payload = buildTargetPayload({ platform: t.socialAccount.platform, captionOverride: t.captionOverride, titleOverride: t.titleOverride, content: { caption: t.content.caption, soundId: t.content.soundId, variations: t.content.variations, assets: t.content.assets } });
      await prisma.contentTarget.update({ where: { id: targetId }, data: { approvalStatus: "APPROVED", approvedPayload: payload } });
    }

    it("an unapproved publication never reaches the provider, whichever path started it (retry, recovery)", async () => {
      const { org, target: t } = await setup();
      await requireApproval(org.id);
      await run(t.id);
      const attempt = await prisma.publishAttempt.findFirstOrThrow({ where: { contentTargetId: t.id } });
      expect(attempt).toMatchObject({ status: "FAILED", errorCode: "CONFIGURATION_ERROR", retryable: false });
      expect(attempt.errorMessage).toMatch(/not been approved/);
      expect((await target(t.id)).status).toBe("FAILED");
      expect(providerRequests("/upload")).toHaveLength(0);
    });

    it("an approved publication goes out; content edited after approval does not", async () => {
      const ok = await setup();
      await requireApproval(ok.org.id);
      await approveNow(ok.target.id);
      await run(ok.target.id);
      expect(providerRequests("/upload")).toHaveLength(1);

      mock.state.requests.length = 0;
      const changed = await setup();
      await requireApproval(changed.org.id);
      await approveNow(changed.target.id);
      await prisma.content.update({ where: { id: changed.content.id }, data: { caption: "edited after approval" } });
      await run(changed.target.id);
      expect((await prisma.publishAttempt.findFirstOrThrow({ where: { contentTargetId: changed.target.id } })).errorMessage).toMatch(/changed after it was approved/);
      expect(providerRequests("/upload")).toHaveLength(0);
    });

    it("the destination's own caption and title are what is sent, not the shared caption", async () => {
      const { target: t } = await setup();
      await prisma.contentTarget.update({ where: { id: t.id }, data: { captionOverride: "Written for this page only" } });
      await run(t.id);
      const pub = await publication(t.id);
      expect(mock.state.publications.get(pub.requestId)!.fields.tiktok_title).toBe("Written for this page only");
    });

    it("'require the track': a missing/unverified track makes the publication fail BEFORE any provider call instead of going out without it", async () => {
      const { org, content, target: t } = await setup();
      const sound = await prisma.sound.create({ data: { organizationId: org.id, title: "Neon Skyline", artist: "Wave Theory", platform: "TIKTOK" } });
      await prisma.content.update({ where: { id: content.id }, data: { soundId: sound.id } });
      await prisma.contentTarget.update({ where: { id: t.id }, data: { requireMusic: true } });
      await run(t.id);
      const attempt = await prisma.publishAttempt.findFirstOrThrow({ where: { contentTargetId: t.id } });
      expect(attempt).toMatchObject({ status: "FAILED", errorCode: "CONFIGURATION_ERROR", retryable: false });
      expect(attempt.errorMessage).toMatch(/track is required/);
      expect(providerRequests("/upload")).toHaveLength(0);
      expect(await publication(t.id)).toMatchObject({ status: "FAILED", lastErrorKind: "MUSIC_REQUIRED" });
    });

    it("without 'require the track' the same situation publishes without the track and records why (unchanged behaviour)", async () => {
      const { org, content, target: t } = await setup();
      const sound = await prisma.sound.create({ data: { organizationId: org.id, title: "Neon Skyline", artist: "Wave Theory", platform: "TIKTOK" } });
      await prisma.content.update({ where: { id: content.id }, data: { soundId: sound.id } });
      await run(t.id);
      expect(providerRequests("/upload")).toHaveLength(1);
      expect((await publication(t.id)).notes).toMatch(/Music not attached/);
    });
  });
  describe("TikTok music", () => {
    async function withSound(mapping: Partial<{ availability: "VERIFIED_AVAILABLE" | "UNVERIFIED" | "UNAVAILABLE"; rightsConfirmed: boolean; verifiedAt: Date | null }> | null) {
      const s = await setup();
      const sound = await prisma.sound.create({ data: { organizationId: s.org.id, title: "Neon Skyline", artist: "Wave Theory", platform: "TIKTOK" } });
      await prisma.content.update({ where: { id: s.content.id }, data: { soundId: sound.id } });
      if (mapping) {
        await prisma.soundMusicMapping.create({
          data: { organizationId: s.org.id, soundId: sound.id, providerMusicId: "7012345678901234567", providerTitle: "Neon Skyline", availability: "UNVERIFIED", ...mapping },
        });
      }
      return s;
    }

    it("attaches the mapped track only when it is verified available, rights-confirmed and recently verified — and records the id used", async () => {
      const s = await withSound({ availability: "VERIFIED_AVAILABLE", rightsConfirmed: true, verifiedAt: new Date() });
      await run(s.target.id);
      const pub = await publication(s.target.id);
      expect(pub.tiktokMusicId).toBe("7012345678901234567");
      expect(mock.state.publications.get(pub.requestId)!.fields.tiktok_music_id).toBe("7012345678901234567");
      expect(pub.notes).toBeNull();
    });

    it.each([
      ["no mapping at all", null],
      ["available but rights NOT confirmed", { availability: "VERIFIED_AVAILABLE" as const, rightsConfirmed: false, verifiedAt: new Date() }],
      ["rights confirmed but never verified available", { availability: "UNVERIFIED" as const, rightsConfirmed: true, verifiedAt: null }],
      ["verification older than 30 days", { availability: "VERIFIED_AVAILABLE" as const, rightsConfirmed: true, verifiedAt: new Date(Date.now() - 31 * 86_400_000) }],
      ["marked unavailable", { availability: "UNAVAILABLE" as const, rightsConfirmed: true, verifiedAt: new Date() }],
    ])("publishes WITHOUT music and says why: %s", async (_label, mapping) => {
      const s = await withSound(mapping);
      await run(s.target.id);
      const pub = await publication(s.target.id);
      expect(pub.tiktokMusicId).toBeNull();
      expect(mock.state.publications.get(pub.requestId)!.fields.tiktok_music_id).toBeUndefined();
      expect(pub.notes).toMatch(/Music not attached/);
    });

    it("does not send music when the TikTok account lacks the 'music' capability", async () => {
      const s = await withSound({ availability: "VERIFIED_AVAILABLE", rightsConfirmed: true, verifiedAt: new Date() });
      await prisma.uploadPostConnectedAccount.update({ where: { id: s.acc.id }, data: { capabilities: ["comments"] } });
      await run(s.target.id);
      expect((await publication(s.target.id)).notes).toMatch(/lacks the 'music' capability/);
    });
  });

  it("webhook-triggered reconcile re-reads the authoritative status and finalizes the target (by external_id, request_id or job_id)", async () => {
    const { target: t } = await setup();
    await run(t.id);
    const pub = await publication(t.id);
    mock.finishPublication(pub.requestId, "completed");
    await processUploadPost({ data: { kind: "reconcile", externalId: pub.externalId } } as never);
    expect((await target(t.id)).status).toBe("PUBLISHED");

    // a hint that matches nothing changes nothing
    await processUploadPost({ data: { kind: "reconcile", requestId: "unknown" } } as never);
  });

  it("reports 'not configured' instead of failing when no client exists", async () => {
    const { target: t } = await setup();
    holder.client = null;
    await run(t.id);
    const attempt = await prisma.publishAttempt.findFirstOrThrow({ where: { contentTargetId: t.id } });
    expect(attempt).toMatchObject({ errorCode: "CONFIGURATION_ERROR", retryable: false });
    expect(attempt.errorMessage).toMatch(/not configured/i);
    expect(PublishError).toBeDefined();
  });
});
