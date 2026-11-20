import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Queue } from "bullmq";
import Redis from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@socialith/database";
import { hashPassword } from "@socialith/auth";
import { QUEUE_NAMES } from "@socialith/types";
import { computeWebhookSignature, startMockUploadPostServer, type MockUploadPostHandle } from "@socialith/upload-post";
import { createApp } from "../app.js";
import { deriveProviderStatus } from "../services/upload-post.service.js";
import { resetUploadPostClientForTests } from "../lib/upload-post.js";

/**
 * Upload-Post API against REAL MySQL + REAL Redis/BullMQ, through the REAL express app (sessions, RBAC, raw-body
 * webhook), with the in-repo contract double standing in for the provider. Nothing here reaches the live service.
 */
const enabled = Boolean(process.env.MYSQL_INTEGRATION_URL && process.env.REDIS_INTEGRATION_URL);
const suite = enabled ? describe : describe.skip;
const PASSWORD = "Correct-Horse-Battery-1";
const KEY = "test-key-0000000000";
const WEBHOOK_SECRET = "whsec_integration_secret_value_1";
const PREVIOUS_SECRET = "whsec_integration_previous_value_2";

let server: Server;
let base = "";
let mock: MockUploadPostHandle;
let queue: Queue;
let redis: Redis;

type Session = { cookie: string; orgId: string; userId: string };

async function http(method: string, path: string, opts: { cookie?: string; body?: unknown; raw?: string; headers?: Record<string, string> } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(opts.raw === undefined && opts.body !== undefined ? { "Content-Type": "application/json" } : {}), ...(opts.raw !== undefined ? { "Content-Type": "application/json" } : {}), ...(opts.cookie ? { Cookie: opts.cookie } : {}), ...opts.headers },
    body: opts.raw !== undefined ? opts.raw : opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json: { success?: boolean; data?: any; error?: { code: string; message: string } } = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json, text };
}

async function login(email: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: PASSWORD }) });
  expect(res.status).toBe(200);
  return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
}

async function makeOrg(role: "OWNER" | "ADMIN" | "EDITOR" | "VIEWER" = "ADMIN"): Promise<Session> {
  const org = await prisma.organization.create({ data: { name: "IT UPA", slug: `it-upa-${randomUUID().slice(0, 8)}` } });
  const email = `${role.toLowerCase()}-${randomUUID().slice(0, 8)}@it-upa.test`;
  const user = await prisma.user.create({ data: { organizationId: org.id, name: role, email, passwordHash: await hashPassword(PASSWORD), role, status: "ACTIVE" } });
  return { cookie: await login(email), orgId: org.id, userId: user.id };
}
async function addUser(orgId: string, role: "EDITOR" | "VIEWER" | "ADMIN"): Promise<string> {
  const email = `${role.toLowerCase()}-${randomUUID().slice(0, 8)}@it-upa.test`;
  await prisma.user.create({ data: { organizationId: orgId, name: role, email, passwordHash: await hashPassword(PASSWORD), role, status: "ACTIVE" } });
  return login(email);
}

/** Provider rows as the worker's sync would leave them. */
async function seedProvider(orgId: string) {
  const profile = await prisma.uploadPostProfile.create({ data: { organizationId: orgId, username: "acme_music", displayName: "Acme Music", lastSyncedAt: new Date() } });
  const make = (platform: string, id: string, extra: Record<string, unknown> = {}) =>
    prisma.uploadPostConnectedAccount.create({ data: { organizationId: orgId, profileId: profile.id, platform, providerAccountId: id, handle: `${platform}.acme`, displayName: `Acme ${platform}`, lastSeenAt: new Date(), ...extra } });
  const tiktok = await make("tiktok", "-000g91dgwXgwtNwcStableOpenId1", { capabilities: ["music", "location"] });
  const instagram = await make("instagram", "17841400000000001");
  const youtube = await make("youtube", "UCacmeMusicChannel0001", { status: "REAUTH_REQUIRED", reauthRequired: true });
  const facebook = await make("facebook", "fb-1");
  return { profile, tiktok, instagram, youtube, facebook };
}

const sign = (secret: string, body: string, ts = String(Math.floor(Date.now() / 1000))) => ({
  "x-upload-post-signature": computeWebhookSignature(secret, ts, body),
  "x-upload-post-timestamp": ts,
});

suite("Upload-Post API (real MySQL + Redis, real express app, contract double)", () => {
  beforeAll(async () => {
    mock = await startMockUploadPostServer({ apiKey: KEY, port: 39870 });
    redis = new Redis(process.env.REDIS_INTEGRATION_URL!, { maxRetriesPerRequest: null });
    queue = new Queue(QUEUE_NAMES.UPLOAD_POST, { connection: redis });
    const app = createApp(null);
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise((r) => server.close(r));
    await mock.close();
    await queue.obliterate({ force: true }).catch(() => undefined);
    await prisma.uploadPostWebhookDelivery.deleteMany({ where: { deliveryId: { startsWith: "d-" } } });
    await queue.close();
    redis.disconnect();
    await prisma.organization.deleteMany({ where: { slug: { startsWith: "it-upa-" } } });
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await prisma.organization.deleteMany({ where: { slug: { startsWith: "it-" } } });
    await queue.obliterate({ force: true }).catch(() => undefined);
    // deliveries are not organization-scoped, so deleting organizations does not clear them
    await prisma.uploadPostWebhookDelivery.deleteMany({ where: { deliveryId: { startsWith: "d-" } } });
    mock.state.requests.length = 0;
    mock.state.apiKey = KEY;
    resetUploadPostClientForTests();
  });

  describe("access control", () => {
    it("requires a session; read for every role; changes need ADMIN; music lookups EDITOR; rights confirmation ADMIN", async () => {
      const admin = await makeOrg("ADMIN");
      const viewer = await addUser(admin.orgId, "VIEWER");
      const editor = await addUser(admin.orgId, "EDITOR");

      expect((await http("GET", "/api/upload-post/overview")).status).toBe(401);
      expect((await http("POST", "/api/upload-post/sync")).status).toBe(401);

      for (const path of ["/api/upload-post/overview", "/api/upload-post/profiles", "/api/upload-post/accounts", "/api/upload-post/publications", "/api/upload-post/scheduled", "/api/upload-post/plan", "/api/upload-post/health", "/api/upload-post/capabilities", "/api/managed-pages", "/api/creators"]) {
        expect((await http("GET", path, { cookie: viewer })).status, path).toBe(200);
      }
      expect((await http("POST", "/api/upload-post/sync", { cookie: viewer })).status).toBe(403);
      expect((await http("POST", "/api/managed-pages", { cookie: editor, body: { name: "X page" } })).status).toBe(403);
      expect((await http("PATCH", "/api/upload-post/profiles/x/mapping", { cookie: editor, body: { managedPageId: null } })).status).toBe(403);
      expect((await http("POST", "/api/upload-post/accounts/x/destination", { cookie: editor })).status).toBe(403);
      expect((await http("POST", "/api/music-mappings/x/rights", { cookie: editor, body: { confirmed: true } })).status).toBe(403);
      expect((await http("GET", "/api/upload-post/tiktok/music?profileId=x", { cookie: viewer })).status).toBe(403);
      expect((await http("GET", "/api/upload-post/tiktok/music?profileId=nope", { cookie: editor })).status).toBe(404); // allowed role, unknown profile
      expect((await http("POST", "/api/managed-pages", { cookie: admin.cookie, body: { name: "X page" } })).status).toBe(201);
    });

    it("never exposes the API key or webhook secret in any response", async () => {
      const a = await makeOrg("ADMIN");
      await seedProvider(a.orgId);
      const bodies = await Promise.all(
        ["/api/upload-post/overview", "/api/upload-post/health?refresh=true", "/api/upload-post/plan", "/api/upload-post/profiles", "/api/upload-post/accounts"].map((p) => http("GET", p, { cookie: a.cookie })),
      );
      for (const b of bodies) {
        expect(b.text).not.toContain(KEY);
        expect(b.text).not.toContain(WEBHOOK_SECRET);
        expect(b.text).not.toMatch(/apikey/i);
      }
    });
  });

  describe("health, overview and plan", () => {
    it("health probes the provider (GET /uploadposts/me), reports latency and plan, and shows the account e-mail to admins only", async () => {
      const admin = await makeOrg("ADMIN");
      const viewer = await addUser(admin.orgId, "VIEWER");
      const h = await http("GET", "/api/upload-post/health?refresh=true", { cookie: admin.cookie });
      expect(h.json.data.provider).toMatchObject({ configured: true, ok: true, account: { plan: "Business", email: "owner@acme.test" } });
      expect(h.json.data.provider.latencyMs).toBeGreaterThanOrEqual(0);
      expect(mock.state.requests.some((r) => r.path === "/uploadposts/me" && r.authorized)).toBe(true);
      const v = await http("GET", "/api/upload-post/health", { cookie: viewer });
      expect(v.json.data.provider.account.email).toBeNull();
    });

    it("a rejected key is reported as data (ok:false, kind AUTH) — not an error response, and without the key", async () => {
      const admin = await makeOrg("ADMIN");
      mock.state.apiKey = "a-different-key-123456";
      const h = await http("GET", "/api/upload-post/health?refresh=true", { cookie: admin.cookie });
      expect(h.status).toBe(200);
      expect(h.json.data.provider).toMatchObject({ configured: true, ok: false, errorKind: "AUTH" });
      expect(h.text).not.toContain(KEY);
      const o = await http("GET", "/api/upload-post/overview", { cookie: admin.cookie });
      expect(o.json.data.status).toBe("DISCONNECTED");
    });

    it("derives the headline status: DISCONNECTED > SYNC_FAILED > LIMIT_REACHED > SYNC_PENDING > CONNECTED", () => {
      const ok = { configured: true, organizationOwnsKey: true, probeOk: true, lastRun: { status: "SUCCEEDED" }, lastSuccess: {}, profileLimit: 225, activeProfiles: 3 };
      expect(deriveProviderStatus(ok)).toBe("CONNECTED");
      expect(deriveProviderStatus({ ...ok, configured: false })).toBe("DISCONNECTED");
      expect(deriveProviderStatus({ ...ok, organizationOwnsKey: false })).toBe("DISCONNECTED");
      expect(deriveProviderStatus({ ...ok, probeOk: false })).toBe("DISCONNECTED");
      expect(deriveProviderStatus({ ...ok, lastRun: { status: "FAILED" } })).toBe("SYNC_FAILED");
      expect(deriveProviderStatus({ ...ok, profileLimit: 3 })).toBe("LIMIT_REACHED");
      expect(deriveProviderStatus({ ...ok, lastSuccess: null, lastRun: null })).toBe("SYNC_PENDING");
      expect(deriveProviderStatus({ ...ok, lastRun: { status: "RUNNING" } })).toBe("SYNC_PENDING");
      expect(deriveProviderStatus({ ...ok, probeOk: null })).toBe("CONNECTED");
    });

    it("overview moves SYNC_PENDING → CONNECTED → SYNC_FAILED → LIMIT_REACHED as sync history changes, and counts rows", async () => {
      const a = await makeOrg("ADMIN");
      await seedProvider(a.orgId);
      const status = async () => (await http("GET", "/api/upload-post/overview?x=" + Math.random(), { cookie: a.cookie })).json.data;
      expect((await status()).status).toBe("SYNC_PENDING");

      await prisma.uploadPostSyncRun.create({ data: { organizationId: a.orgId, trigger: "MANUAL", status: "SUCCEEDED", finishedAt: new Date(), profilesSeen: 1, plan: "business", profileLimit: 225 } });
      const connected = await status();
      expect(connected.status).toBe("CONNECTED");
      expect(connected.profiles).toMatchObject({ active: 1, limit: 225, unmapped: 1 });
      expect(connected.accounts.byStatus).toMatchObject({ CONNECTED: 3, REAUTH_REQUIRED: 1 });
      expect(connected.accounts.byPlatform).toMatchObject({ tiktok: 1, instagram: 1, youtube: 1, facebook: 1 });
      expect(connected.lastSuccessfulSyncAt).not.toBeNull();

      await prisma.uploadPostSyncRun.create({ data: { organizationId: a.orgId, trigger: "SCHEDULED", status: "FAILED", finishedAt: new Date(), errorKind: "SERVER", errorMessage: "boom", startedAt: new Date(Date.now() + 1000) } });
      expect((await status()).status).toBe("SYNC_FAILED");

      await prisma.uploadPostSyncRun.create({ data: { organizationId: a.orgId, trigger: "SCHEDULED", status: "SUCCEEDED", finishedAt: new Date(), plan: "basic", profileLimit: 1, startedAt: new Date(Date.now() + 2000) } });
      expect((await status()).status).toBe("LIMIT_REACHED");
    });

    it("plan and capacity come from the provider/last sync — never a constant", async () => {
      const a = await makeOrg("ADMIN");
      await seedProvider(a.orgId);
      await prisma.uploadPostSyncRun.create({ data: { organizationId: a.orgId, trigger: "MANUAL", status: "SUCCEEDED", finishedAt: new Date(), plan: "business", profileLimit: 10 } });
      let plan = (await http("GET", "/api/upload-post/plan", { cookie: a.cookie })).json.data;
      expect(plan).toMatchObject({ plan: "Business", profileLimit: 10, profilesUsed: 1, profilesRemaining: 9, limitReached: false, source: "live" });
      await prisma.uploadPostSyncRun.create({ data: { organizationId: a.orgId, trigger: "MANUAL", status: "SUCCEEDED", finishedAt: new Date(), plan: "business", profileLimit: 1, startedAt: new Date(Date.now() + 1000) } });
      plan = (await http("GET", "/api/upload-post/plan", { cookie: a.cookie })).json.data;
      expect(plan).toMatchObject({ profileLimit: 1, profilesRemaining: 0, limitReached: true });
      expect(JSON.stringify(plan)).not.toContain("225");
    });

    it("the manual sync is queued on the Upload-Post queue (once at a time) and audited; viewers cannot", async () => {
      const a = await makeOrg("ADMIN");
      const first = await http("POST", "/api/upload-post/sync", { cookie: a.cookie });
      expect(first.status).toBe(202);
      expect(first.json.data).toMatchObject({ queued: true });
      const second = await http("POST", "/api/upload-post/sync", { cookie: a.cookie });
      expect(second.json.data).toMatchObject({ queued: false, alreadyQueued: true });
      const jobs = await queue.getJobs(["waiting", "delayed", "active"]);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.data).toMatchObject({ kind: "sync", trigger: "MANUAL", organizationId: a.orgId });
      expect(await prisma.auditLog.count({ where: { organizationId: a.orgId, action: "UPLOAD_POST_SYNC_REQUESTED" } })).toBeGreaterThanOrEqual(1);
    });

    it("refuses to sync for an organization that does not own the key when the deployment has several", async () => {
      const a = await makeOrg("ADMIN");
      await makeOrg("ADMIN"); // a second organization: ownership is now ambiguous without UPLOAD_POST_ORGANIZATION_ID
      const r = await http("POST", "/api/upload-post/sync", { cookie: a.cookie });
      expect(r.status).toBe(409);
      expect(r.json.error!.message).toMatch(/UPLOAD_POST_ORGANIZATION_ID/);
      expect(await queue.getJobs(["waiting", "delayed", "active"])).toHaveLength(0);
    });
  });

  describe("profiles and accounts", () => {
    it("lists profiles with their accounts, searches by profile name and by account handle, and filters by mapping", async () => {
      const a = await makeOrg("ADMIN");
      const seeded = await seedProvider(a.orgId);
      await prisma.uploadPostProfile.create({ data: { organizationId: a.orgId, username: "label_two", displayName: null } });
      const all = (await http("GET", "/api/upload-post/profiles", { cookie: a.cookie })).json.data;
      expect(all.total).toBe(2);
      const acme = all.items.find((p: any) => p.username === "acme_music");
      expect(acme.accounts.map((x: any) => x.platform)).toEqual(["facebook", "instagram", "tiktok", "youtube"]);
      expect((await http("GET", "/api/upload-post/profiles?search=label", { cookie: a.cookie })).json.data.total).toBe(1);
      expect((await http("GET", "/api/upload-post/profiles?search=tiktok.acme", { cookie: a.cookie })).json.data.items[0].username).toBe("acme_music");
      const page = await prisma.managedPage.create({ data: { organizationId: a.orgId, name: "P", slug: "p" } });
      await prisma.uploadPostProfile.update({ where: { id: seeded.profile.id }, data: { managedPageId: page.id } });
      expect((await http("GET", "/api/upload-post/profiles?mapped=true", { cookie: a.cookie })).json.data.items.map((p: any) => p.username)).toEqual(["acme_music"]);
      expect((await http("GET", "/api/upload-post/profiles?mapped=false", { cookie: a.cookie })).json.data.items.map((p: any) => p.username)).toEqual(["label_two"]);
      expect((await http("GET", "/api/upload-post/profiles?pageSize=0", { cookie: a.cookie })).status).toBe(400);
    });

    it("filters accounts by platform, status, creator mapping and destination; marks unsupported platforms and shared accounts", async () => {
      const a = await makeOrg("ADMIN");
      const s = await seedProvider(a.orgId);
      const other = await prisma.uploadPostProfile.create({ data: { organizationId: a.orgId, username: "second", displayName: "Second" } });
      await prisma.uploadPostConnectedAccount.create({ data: { organizationId: a.orgId, profileId: other.id, platform: "tiktok", providerAccountId: s.tiktok.providerAccountId, handle: "same.account" } });

      const get = async (q: string) => (await http("GET", `/api/upload-post/accounts${q}`, { cookie: a.cookie })).json.data;
      expect((await get("")).total).toBe(5);
      expect((await get("?platform=tiktok")).total).toBe(2);
      expect((await get("?status=REAUTH_REQUIRED")).items.map((x: any) => x.platform)).toEqual(["youtube"]);
      const tt = (await get("?platform=tiktok")).items;
      expect(tt.every((x: any) => x.sharedAcrossProfiles)).toBe(true); // same real account in two profiles is surfaced
      expect((await get("?platform=instagram")).items[0]).toMatchObject({ sharedAcrossProfiles: false, publishable: true });
      expect((await get("?platform=facebook")).items[0].publishable).toBe(false);
      expect((await get("?search=same.account")).total).toBe(1);
      expect((await get("?destination=true")).total).toBe(0);
      expect((await get("?mapped=false")).total).toBe(5);
    });

    it("is organization-scoped: another organization sees nothing and gets 404 (never 403) for foreign ids", async () => {
      const a = await makeOrg("ADMIN");
      const s = await seedProvider(a.orgId);
      const b = await makeOrg("ADMIN");
      expect((await http("GET", "/api/upload-post/profiles", { cookie: b.cookie })).json.data.total).toBe(0);
      expect((await http("GET", "/api/upload-post/accounts", { cookie: b.cookie })).json.data.total).toBe(0);
      expect((await http("PATCH", `/api/upload-post/accounts/${s.tiktok.id}/mapping`, { cookie: b.cookie, body: { creatorId: null } })).status).toBe(404);
      expect((await http("POST", `/api/upload-post/accounts/${s.tiktok.id}/destination`, { cookie: b.cookie })).status).toBe(404);
      expect((await http("PATCH", `/api/upload-post/profiles/${s.profile.id}/mapping`, { cookie: b.cookie, body: { managedPageId: null } })).status).toBe(404);
    });
  });

  describe("mapping: ManagedPage and Creator", () => {
    it("creates pages/creators (unique slug/name), maps a profile to a page and an account to a creator, and audits changes", async () => {
      const a = await makeOrg("ADMIN");
      const s = await seedProvider(a.orgId);
      const page = (await http("POST", "/api/managed-pages", { cookie: a.cookie, body: { name: "Çocuk Müzik Sayfası" } })).json.data;
      expect(page.slug).toBe("cocuk-muzik-sayfasi");
      expect((await http("POST", "/api/managed-pages", { cookie: a.cookie, body: { name: "Other", slug: "cocuk-muzik-sayfasi" } })).status).toBe(409);
      const creator = (await http("POST", "/api/creators", { cookie: a.cookie, body: { name: "Acme Artist" } })).json.data;
      expect((await http("POST", "/api/creators", { cookie: a.cookie, body: { name: "acme artist" } })).status).toBe(409); // case-insensitive duplicate

      const pm = await http("PATCH", `/api/upload-post/profiles/${s.profile.id}/mapping`, { cookie: a.cookie, body: { managedPageId: page.id } });
      expect(pm.status).toBe(200);
      expect(pm.json.data.managedPage).toMatchObject({ id: page.id });
      const am = await http("PATCH", `/api/upload-post/accounts/${s.tiktok.id}/mapping`, { cookie: a.cookie, body: { creatorId: creator.id } });
      expect(am.json.data.creator).toMatchObject({ id: creator.id, name: "Acme Artist" });
      // clearing works
      expect((await http("PATCH", `/api/upload-post/accounts/${s.tiktok.id}/mapping`, { cookie: a.cookie, body: { creatorId: null } })).json.data.creator).toBeNull();
      expect(await prisma.auditLog.count({ where: { organizationId: a.orgId, action: "UPLOAD_POST_MAPPING_CHANGED" } })).toBe(3);
    });

    it("refuses archived targets, unknown targets, foreign targets and creator assignment on unsupported platforms", async () => {
      const a = await makeOrg("ADMIN");
      const s = await seedProvider(a.orgId);
      const page = (await http("POST", "/api/managed-pages", { cookie: a.cookie, body: { name: "Page P" } })).json.data;
      const creator = (await http("POST", "/api/creators", { cookie: a.cookie, body: { name: "C" } })).json.data;
      await http("PATCH", `/api/managed-pages/${page.id}`, { cookie: a.cookie, body: { status: "ARCHIVED" } });
      await http("PATCH", `/api/creators/${creator.id}`, { cookie: a.cookie, body: { status: "ARCHIVED" } });
      expect((await http("PATCH", `/api/upload-post/profiles/${s.profile.id}/mapping`, { cookie: a.cookie, body: { managedPageId: page.id } })).status).toBe(409);
      expect((await http("PATCH", `/api/upload-post/accounts/${s.tiktok.id}/mapping`, { cookie: a.cookie, body: { creatorId: creator.id } })).status).toBe(409);
      expect((await http("PATCH", `/api/upload-post/accounts/${s.tiktok.id}/mapping`, { cookie: a.cookie, body: { creatorId: "nope" } })).status).toBe(404);
      const live = (await http("POST", "/api/creators", { cookie: a.cookie, body: { name: "Live" } })).json.data;
      expect((await http("PATCH", `/api/upload-post/accounts/${s.facebook.id}/mapping`, { cookie: a.cookie, body: { creatorId: live.id } })).status).toBe(409);
      const b = await makeOrg("ADMIN");
      const foreign = (await http("POST", "/api/creators", { cookie: b.cookie, body: { name: "Foreign" } })).json.data;
      expect((await http("PATCH", `/api/upload-post/accounts/${s.tiktok.id}/mapping`, { cookie: a.cookie, body: { creatorId: foreign.id } })).status).toBe(404);
      expect((await http("PATCH", `/api/upload-post/accounts/${s.tiktok.id}/mapping`, { cookie: a.cookie, body: {} })).status).toBe(400);
    });
  });

  describe("publishing destination", () => {
    it("enable creates ONE Upload-Post SocialAccount keyed by the stable provider id and links it; repeating is idempotent; disable keeps history", async () => {
      const a = await makeOrg("ADMIN");
      const s = await seedProvider(a.orgId);
      const on = await http("POST", `/api/upload-post/accounts/${s.tiktok.id}/destination`, { cookie: a.cookie });
      expect(on.status).toBe(200);
      const social = await prisma.socialAccount.findFirstOrThrow({ where: { organizationId: a.orgId } });
      expect(social).toMatchObject({ platform: "TIKTOK", externalAccountId: "-000g91dgwXgwtNwcStableOpenId1", publishingProvider: "UPLOAD_POST", status: "CONNECTED" });
      expect(on.json.data.socialAccount.id).toBe(social.id);
      expect(await prisma.platformConnection.count({ where: { socialAccountId: social.id } })).toBe(0); // no native tokens involved

      await http("POST", `/api/upload-post/accounts/${s.tiktok.id}/destination`, { cookie: a.cookie });
      expect(await prisma.socialAccount.count({ where: { organizationId: a.orgId } })).toBe(1);

      const content = await prisma.content.create({ data: { organizationId: a.orgId, caption: "c", status: "PUBLISHED" } });
      const target = await prisma.contentTarget.create({ data: { contentId: content.id, socialAccountId: social.id, status: "PUBLISHED" } });
      const off = await http("DELETE", `/api/upload-post/accounts/${s.tiktok.id}/destination`, { cookie: a.cookie });
      expect(off.status).toBe(200);
      expect(off.json.data.socialAccount).toBeNull();
      expect(await prisma.socialAccount.findUniqueOrThrow({ where: { id: social.id } })).toMatchObject({ status: "DISCONNECTED" });
      expect((await prisma.contentTarget.findUniqueOrThrow({ where: { id: target.id } })).status).toBe("PUBLISHED"); // history intact
      // enabling again relinks the SAME SocialAccount (no duplicate)
      await http("POST", `/api/upload-post/accounts/${s.tiktok.id}/destination`, { cookie: a.cookie });
      expect(await prisma.socialAccount.count({ where: { organizationId: a.orgId } })).toBe(1);
      expect((await prisma.socialAccount.findUniqueOrThrow({ where: { id: social.id } })).status).toBe("CONNECTED");
    });

    it("refuses: reconnect-required, unsupported platform, removed profile, a native account with the same id, and a duplicate through another profile", async () => {
      const a = await makeOrg("ADMIN");
      const s = await seedProvider(a.orgId);
      const r1 = await http("POST", `/api/upload-post/accounts/${s.youtube.id}/destination`, { cookie: a.cookie });
      expect([r1.status, r1.json.error!.code]).toEqual([409, "REAUTH_REQUIRED"]);
      expect((await http("POST", `/api/upload-post/accounts/${s.facebook.id}/destination`, { cookie: a.cookie })).status).toBe(409);

      await prisma.socialAccount.create({ data: { organizationId: a.orgId, platform: "INSTAGRAM", externalAccountId: s.instagram.providerAccountId, handle: "n", displayName: "n" } }); // native, same real account
      const native = await http("POST", `/api/upload-post/accounts/${s.instagram.id}/destination`, { cookie: a.cookie });
      expect(native.status).toBe(409);
      expect(native.json.error!.message).toMatch(/already connected natively/);

      await http("POST", `/api/upload-post/accounts/${s.tiktok.id}/destination`, { cookie: a.cookie });
      const second = await prisma.uploadPostProfile.create({ data: { organizationId: a.orgId, username: "second" } });
      const dup = await prisma.uploadPostConnectedAccount.create({ data: { organizationId: a.orgId, profileId: second.id, platform: "tiktok", providerAccountId: s.tiktok.providerAccountId, handle: "dup" } });
      const conflict = await http("POST", `/api/upload-post/accounts/${dup.id}/destination`, { cookie: a.cookie });
      expect(conflict.status).toBe(409);
      expect(conflict.json.error!.message).toMatch(/already a publishing destination/);

      await prisma.uploadPostProfile.update({ where: { id: s.profile.id }, data: { status: "REMOVED" } });
      expect((await http("POST", `/api/upload-post/accounts/${s.instagram.id}/destination`, { cookie: a.cookie })).status).toBe(409);
    });

    it("disable is refused while targets are still pending for the destination", async () => {
      const a = await makeOrg("ADMIN");
      const s = await seedProvider(a.orgId);
      await http("POST", `/api/upload-post/accounts/${s.tiktok.id}/destination`, { cookie: a.cookie });
      const social = await prisma.socialAccount.findFirstOrThrow({ where: { organizationId: a.orgId } });
      const content = await prisma.content.create({ data: { organizationId: a.orgId, caption: "c", status: "SCHEDULED", scheduledAt: new Date(Date.now() + 3600_000) } });
      await prisma.contentTarget.create({ data: { contentId: content.id, socialAccountId: social.id, status: "SCHEDULED" } });
      const off = await http("DELETE", `/api/upload-post/accounts/${s.tiktok.id}/destination`, { cookie: a.cookie });
      expect(off.status).toBe(409);
      expect((await prisma.uploadPostConnectedAccount.findUniqueOrThrow({ where: { id: s.tiktok.id } })).socialAccountId).toBe(social.id);
    });
  });

  describe("publications and scheduled jobs", () => {
    it("lists provider publications (no idempotency keys or raw provider payloads) and the jobs handed to the provider scheduler", async () => {
      const a = await makeOrg("ADMIN");
      const s = await seedProvider(a.orgId);
      await http("POST", `/api/upload-post/accounts/${s.tiktok.id}/destination`, { cookie: a.cookie });
      const social = await prisma.socialAccount.findFirstOrThrow({ where: { organizationId: a.orgId } });
      const mk = async (status: "COMPLETED" | "SCHEDULED_AT_PROVIDER", mode: "IMMEDIATE" | "PROVIDER_SCHEDULED") => {
        const content = await prisma.content.create({ data: { organizationId: a.orgId, caption: `cap ${status}`, status: "SCHEDULED", scheduledAt: new Date(Date.now() + 7200_000) } });
        const target = await prisma.contentTarget.create({ data: { contentId: content.id, socialAccountId: social.id, status: "SCHEDULED" } });
        return prisma.uploadPostPublication.create({
          data: { organizationId: a.orgId, contentTargetId: target.id, mode, status, externalId: `e-${target.id}`, requestId: `r-${target.id}`, idempotencyKey: "secret-idem", profileUsername: "acme_music", platform: "tiktok", scheduledFor: mode === "PROVIDER_SCHEDULED" ? new Date(Date.now() + 7200_000) : null, providerJobId: mode === "PROVIDER_SCHEDULED" ? "job_1" : null, lastProviderResult: { secret: "raw" } },
        });
      };
      await mk("COMPLETED", "IMMEDIATE");
      await mk("SCHEDULED_AT_PROVIDER", "PROVIDER_SCHEDULED");
      const pubs = await http("GET", "/api/upload-post/publications", { cookie: a.cookie });
      expect(pubs.json.data.total).toBe(2);
      expect(pubs.text).not.toContain("secret-idem");
      expect(pubs.text).not.toContain('"raw"');
      expect((await http("GET", "/api/upload-post/publications?status=COMPLETED", { cookie: a.cookie })).json.data.total).toBe(1);
      const sched = await http("GET", "/api/upload-post/scheduled", { cookie: a.cookie });
      expect(sched.json.data.total).toBe(1);
      expect(sched.json.data.items[0]).toMatchObject({ status: "SCHEDULED_AT_PROVIDER", providerJobId: "job_1", platform: "tiktok" });
    });
  });

  describe("TikTok music mapping", () => {
    async function withSound(a: Session) {
      return prisma.sound.create({ data: { organizationId: a.orgId, title: "Neon Skyline", artist: "Wave Theory", platform: "TIKTOK" } });
    }

    it("searches chart data for a music-capable TikTok profile and labels it as Commercial Music Library charts, not the full catalogue", async () => {
      const a = await makeOrg("ADMIN");
      const s = await seedProvider(a.orgId);
      const r = await http("GET", `/api/upload-post/tiktok/music?profileId=${s.profile.id}&q=neon`, { cookie: a.cookie });
      expect(r.status).toBe(200);
      expect(r.json.data.tracks.map((t: any) => t.id)).toEqual(["7012345678901234567"]);
      expect(r.json.data.scope).toBe("COMMERCIAL_MUSIC_LIBRARY_CHARTS");
      expect(r.json.data.notice).toMatch(/NOT the whole TikTok catalogue/);
      expect((await http("GET", `/api/upload-post/tiktok/music?profileId=${s.profile.id}`, { cookie: a.cookie })).json.data.tracks).toHaveLength(2); // trending
    });

    it("offers music only for accounts that report the capability (409 reconnect), never a silent empty list", async () => {
      const a = await makeOrg("ADMIN");
      const s = await seedProvider(a.orgId);
      await prisma.uploadPostConnectedAccount.update({ where: { id: s.tiktok.id }, data: { capabilities: ["comments"] } });
      const r = await http("GET", `/api/upload-post/tiktok/music?profileId=${s.profile.id}&q=x`, { cookie: a.cookie });
      expect([r.status, r.json.error!.code]).toEqual([409, "REAUTH_REQUIRED"]);
      expect(r.json.error!.message).toMatch(/music/);
      expect(mock.state.requests.some((q) => q.path.includes("/tiktok/music"))).toBe(false); // the provider was not even asked
    });

    it("a mapping starts UNVERIFIED; verification marks it available or unavailable; rights are a separate human confirmation; duplicates refused", async () => {
      const a = await makeOrg("ADMIN");
      const s = await seedProvider(a.orgId);
      const sound = await withSound(a);
      const created = await http("POST", `/api/sounds/${sound.id}/music-mappings`, {
        cookie: a.cookie,
        body: { providerMusicId: "7012345678901234567", providerTitle: "Neon Skyline", providerArtist: "Wave Theory", commercialMusicId: "6987654321098765432" },
      });
      expect(created.status).toBe(201);
      expect(created.json.data).toMatchObject({ availability: "UNVERIFIED", rightsConfirmed: false });
      expect((await http("POST", `/api/sounds/${sound.id}/music-mappings`, { cookie: a.cookie, body: { providerMusicId: "7012345678901234567", providerTitle: "x" } })).status).toBe(409);

      const verified = await http("POST", `/api/music-mappings/${created.json.data.id}/verify`, { cookie: a.cookie, body: { profileId: s.profile.id } });
      expect(verified.json.data.mapping).toMatchObject({ availability: "VERIFIED_AVAILABLE", verifiedWithProfile: "acme_music" });
      expect(verified.json.data.mapping.rightsConfirmed).toBe(false); // availability alone never grants rights

      const rights = await http("POST", `/api/music-mappings/${created.json.data.id}/rights`, { cookie: a.cookie, body: { confirmed: true, note: "Cleared with the label, promo use" } });
      expect(rights.json.data).toMatchObject({ rightsConfirmed: true, rightsNote: "Cleared with the label, promo use" });
      expect(rights.json.data.rightsConfirmedById).toBeTruthy();
      expect((await http("POST", `/api/music-mappings/${created.json.data.id}/rights`, { cookie: a.cookie, body: { confirmed: false } })).json.data.rightsConfirmed).toBe(false);

      // a track that is not in the chart data is marked UNAVAILABLE (an ISRC/Spotify URL does not make it usable)
      const ghost = await http("POST", `/api/sounds/${sound.id}/music-mappings`, { cookie: a.cookie, body: { providerMusicId: "999", providerTitle: "Not In Charts" } });
      const ghostVerified = await http("POST", `/api/music-mappings/${ghost.json.data.id}/verify`, { cookie: a.cookie, body: { profileId: s.profile.id } });
      expect(ghostVerified.json.data.mapping.availability).toBe("UNAVAILABLE");
      expect(ghostVerified.json.data.notice).toMatch(/NOT the whole TikTok catalogue/);

      const list = await http("GET", `/api/sounds/${sound.id}/music-mappings`, { cookie: a.cookie });
      expect(list.json.data).toHaveLength(2);
      expect((await http("DELETE", `/api/music-mappings/${ghost.json.data.id}`, { cookie: a.cookie })).status).toBe(200);
      expect(await prisma.auditLog.count({ where: { organizationId: a.orgId, action: { in: ["MUSIC_MAPPING_CREATED", "MUSIC_MAPPING_VERIFIED", "MUSIC_MAPPING_RIGHTS_CHANGED", "MUSIC_MAPPING_DELETED"] } } })).toBeGreaterThanOrEqual(7);
    });

    it("is organization-scoped (another organization's track/mapping is a 404)", async () => {
      const a = await makeOrg("ADMIN");
      const sound = await withSound(a);
      const b = await makeOrg("ADMIN");
      expect((await http("GET", `/api/sounds/${sound.id}/music-mappings`, { cookie: b.cookie })).status).toBe(404);
      expect((await http("POST", `/api/sounds/${sound.id}/music-mappings`, { cookie: b.cookie, body: { providerMusicId: "1", providerTitle: "x" } })).status).toBe(404);
    });
  });

  describe("webhook (POST /api/webhooks/upload-post)", () => {
    const BODY = JSON.stringify({ event: "upload_completed", request_id: "sl-req-1", external_id: "socialith:target:t1:g1", result: { success: true } });
    const post = (body: string, headers: Record<string, string>) => http("POST", "/api/webhooks/upload-post", { raw: body, headers });
    const jobs = () => queue.getJobs(["waiting", "delayed", "active"]);

    it("accepts a correctly signed event, queues a reconcile with the correlation hints, and needs no session", async () => {
      const r = await post(BODY, { ...sign(WEBHOOK_SECRET, BODY), "x-upload-post-delivery": "d-1", "x-upload-post-event": "upload_completed", "x-upload-post-attempt": "1" });
      expect(r.status).toBe(200);
      expect(r.json.data).toEqual({ outcome: "PROCESSED" });
      const queued = await jobs();
      expect(queued).toHaveLength(1);
      expect(queued[0]!.data).toMatchObject({ kind: "reconcile", requestId: "sl-req-1", externalId: "socialith:target:t1:g1", deliveryId: "d-1" });
      expect(await prisma.uploadPostWebhookDelivery.findUniqueOrThrow({ where: { deliveryId: "d-1" } })).toMatchObject({ event: "upload_completed", outcome: "PROCESSED", requestId: "sl-req-1" });
    });

    it("de-duplicates redelivery of the same delivery id (at-least-once): one job, answered 200", async () => {
      const headers = { ...sign(WEBHOOK_SECRET, BODY), "x-upload-post-delivery": "d-dup" };
      await post(BODY, headers);
      const again = await post(BODY, { ...sign(WEBHOOK_SECRET, BODY), "x-upload-post-delivery": "d-dup", "x-upload-post-attempt": "2" });
      expect(again.status).toBe(200);
      expect(again.json.data).toEqual({ duplicate: true });
      expect(await jobs()).toHaveLength(1);
      expect(await prisma.uploadPostWebhookDelivery.count({ where: { deliveryId: "d-dup" } })).toBe(1);
    });

    it("accepts the previous secret during a rotation", async () => {
      const r = await post(BODY, { ...sign(PREVIOUS_SECRET, BODY), "x-upload-post-delivery": "d-rot" });
      expect(r.status).toBe(200);
    });

    it("rejects (401, nothing queued, nothing stored) a wrong secret, a tampered body, a stale timestamp, and missing/garbled headers", async () => {
      const cases: [string, string, Record<string, string>][] = [
        ["wrong secret", BODY, sign("not-the-secret-at-all-0000", BODY)],
        ["tampered body", BODY.replace("sl-req-1", "sl-req-2"), sign(WEBHOOK_SECRET, BODY)],
        ["stale timestamp", BODY, sign(WEBHOOK_SECRET, BODY, String(Math.floor(Date.now() / 1000) - 3600))],
        ["no signature", BODY, { "x-upload-post-timestamp": String(Math.floor(Date.now() / 1000)) }],
        ["no timestamp", BODY, { "x-upload-post-signature": computeWebhookSignature(WEBHOOK_SECRET, "1", BODY) }],
        ["garbled signature", BODY, { "x-upload-post-signature": "sha256=zz", "x-upload-post-timestamp": String(Math.floor(Date.now() / 1000)) }],
      ];
      for (const [label, body, headers] of cases) {
        const r = await post(body, { ...headers, "x-upload-post-delivery": `d-bad-${label}` });
        expect(r.status, label).toBe(401);
      }
      expect(await jobs()).toHaveLength(0);
      expect(await prisma.uploadPostWebhookDelivery.count({ where: { deliveryId: { startsWith: "d-bad-" } } })).toBe(0);
    });

    it("a signed but unparsable payload is a 400, an unrelated event is acknowledged and ignored", async () => {
      const junk = "not json at all";
      expect((await post(junk, { ...sign(WEBHOOK_SECRET, junk), "x-upload-post-delivery": "d-junk" })).status).toBe(400);
      const other = JSON.stringify({ event: "dm_received", payload: {} });
      const ignored = await post(other, { ...sign(WEBHOOK_SECRET, other), "x-upload-post-delivery": "d-other" });
      expect(ignored.json.data).toEqual({ outcome: "IGNORED" });
      expect(await jobs()).toHaveLength(0);
    });

    it("connection-change events trigger a read-only re-sync", async () => {
      await makeOrg("ADMIN");
      const body = JSON.stringify({ event: "social_account_reauth_required", platform: "tiktok", profile_username: "acme_music" });
      const r = await post(body, { ...sign(WEBHOOK_SECRET, body), "x-upload-post-delivery": "d-acct" });
      expect(r.json.data).toEqual({ outcome: "PROCESSED" });
      const queued = await jobs();
      expect(queued).toHaveLength(1);
      expect(queued[0]!.data).toMatchObject({ kind: "sync", trigger: "MANUAL" });
    });

    it("works when the body is sent with unusual whitespace (signature is over the RAW bytes, not re-serialized JSON)", async () => {
      const spaced = `{ "event" : "upload_completed",\n  "request_id":"sl-req-9" }`;
      const r = await post(spaced, { ...sign(WEBHOOK_SECRET, spaced), "x-upload-post-delivery": "d-ws" });
      expect(r.status).toBe(200);
      const reserialized = JSON.stringify(JSON.parse(spaced));
      const bad = await post(spaced, { ...sign(WEBHOOK_SECRET, reserialized), "x-upload-post-delivery": "d-ws2" });
      expect(bad.status).toBe(401);
    });
  });

  describe("trial plan: empty and unconnected profiles, platform availability", () => {
    const api = (cookie: string, path: string) => http("GET", `/api/upload-post${path}`, { cookie });
    const trialRun = (orgId: string, over: Record<string, unknown> = {}) =>
      prisma.uploadPostSyncRun.create({ data: { organizationId: orgId, trigger: "MANUAL", status: "SUCCEEDED", finishedAt: new Date(), profilesSeen: 1, plan: "default", profileLimit: 2, ...over } });
    const platformsOf = (data: { platforms: { platform: string; state: string }[] }) => Object.fromEntries(data.platforms.map((p) => [p.platform, p.state]));

    it("nothing synchronized yet: no profiles, every platform UNAVAILABLE with a reason, no plan figures invented", async () => {
      const a = await makeOrg("ADMIN");
      const cap = (await api(a.cookie, "/capabilities")).json.data;
      expect(cap).toMatchObject({ synced: false, lastSyncedAt: null, plan: { name: null, profileLimit: null, profilesUsed: 0, profilesRemaining: null } });
      expect(platformsOf(cap)).toEqual({ tiktok: "UNAVAILABLE", instagram: "UNAVAILABLE", youtube: "UNAVAILABLE" });
      expect(cap.platforms[0].reason).toMatch(/not been synchronized/);
      expect((await api(a.cookie, "/profiles")).json.data).toMatchObject({ items: [], total: 0 });
      expect((await api(a.cookie, "/accounts")).json.data).toMatchObject({ items: [], total: 0 });
    });

    it("the live trial state (plan default, limit 2, one profile, no accounts) is shown as it is: capacity from the provider, every platform unavailable", async () => {
      const a = await makeOrg("ADMIN");
      const viewer = await addUser(a.orgId, "VIEWER");
      const profile = await prisma.uploadPostProfile.create({ data: { organizationId: a.orgId, username: "example_profile", lastSyncedAt: new Date() } });
      await trialRun(a.orgId);
      const previousPlan = mock.state.plan;
      mock.state.plan = "Default";
      try {
        resetUploadPostClientForTests();
        const cap = (await api(viewer, "/capabilities")).json.data;
        expect(cap).toMatchObject({ synced: true, plan: { name: "default", profileLimit: 2, profilesUsed: 1, profilesRemaining: 1 } });
        expect(platformsOf(cap)).toEqual({ tiktok: "UNAVAILABLE", instagram: "UNAVAILABLE", youtube: "UNAVAILABLE" });
        const tiktok = cap.platforms.find((p: { platform: string }) => p.platform === "tiktok");
        expect(tiktok.reason).toMatch(/has not confirmed access/);
        expect(tiktok.features[0]).toMatchObject({ key: "music", state: "UNAVAILABLE" });
        expect(tiktok.connectableProfiles).toEqual([{ id: profile.id, username: "example_profile" }]);

        const plan = (await api(viewer, "/plan")).json.data;
        expect(plan).toMatchObject({ plan: "Default", profileLimit: 2, profilesUsed: 1, profilesRemaining: 1, limitReached: false, source: "live" });
        const overview = (await api(viewer, "/overview")).json.data;
        expect(overview.status).toBe("CONNECTED"); // 1 of 2 profiles used is not "limit reached"
        expect(overview).toMatchObject({ profiles: { active: 1, limit: 2 }, accounts: { byStatus: {}, byPlatform: {}, destinations: 0 } });

        const profiles = (await api(viewer, "/profiles")).json.data;
        expect(profiles.total).toBe(1);
        expect(profiles.items[0]).toMatchObject({ username: "example_profile", blocked: false, accounts: [] });
        expect((await api(viewer, "/accounts")).json.data.total).toBe(0);
      } finally {
        mock.state.plan = previousPlan;
      }
    });

    it("the profile limit is reached only when the provider's own limit is used up (2 of 2), never from a constant", async () => {
      const a = await makeOrg("ADMIN");
      await prisma.uploadPostProfile.createMany({ data: [{ organizationId: a.orgId, username: "one" }, { organizationId: a.orgId, username: "two" }] });
      await trialRun(a.orgId, { profilesSeen: 2 });
      const overview = (await api(a.cookie, "/overview")).json.data;
      expect(overview.status).toBe("LIMIT_REACHED");
      const cap = (await api(a.cookie, "/capabilities")).json.data;
      expect(cap.plan).toMatchObject({ profileLimit: 2, profilesUsed: 2, profilesRemaining: 0 });
    });

    it("Instagram and YouTube connected, TikTok not: only those two are available, and they can be enabled; TikTok cannot exist as a destination", async () => {
      const a = await makeOrg("ADMIN");
      const profile = await prisma.uploadPostProfile.create({ data: { organizationId: a.orgId, username: "example_profile", lastSyncedAt: new Date() } });
      await trialRun(a.orgId);
      const ig = await prisma.uploadPostConnectedAccount.create({ data: { organizationId: a.orgId, profileId: profile.id, platform: "instagram", providerAccountId: "17841400000000009", handle: "my.band", lastSeenAt: new Date() } });
      await prisma.uploadPostConnectedAccount.create({ data: { organizationId: a.orgId, profileId: profile.id, platform: "youtube", providerAccountId: "UCmyBandChannel000009", handle: "mybandtv", lastSeenAt: new Date() } });

      const cap = (await api(a.cookie, "/capabilities")).json.data;
      expect(platformsOf(cap)).toEqual({ tiktok: "UNAVAILABLE", instagram: "AVAILABLE", youtube: "AVAILABLE" });
      expect(cap.platforms.find((p: { platform: string }) => p.platform === "tiktok").connectableProfiles).toHaveLength(1);
      expect(cap.platforms.find((p: { platform: string }) => p.platform === "instagram").connectableProfiles).toEqual([]);

      const enabled = await http("POST", `/api/upload-post/accounts/${ig.id}/destination`, { cookie: a.cookie });
      expect(enabled.status).toBe(200);
      const after = (await api(a.cookie, "/capabilities")).json.data;
      expect(after.platforms.find((p: { platform: string }) => p.platform === "instagram").destinations).toBe(1);
      // no TikTok account row exists, so there is nothing that could be enabled or published to
      expect(await prisma.uploadPostConnectedAccount.count({ where: { organizationId: a.orgId, platform: "tiktok" } })).toBe(0);
      expect(await prisma.socialAccount.count({ where: { organizationId: a.orgId, platform: "TIKTOK" } })).toBe(0);
    });

    it("a profile the provider reports as blocked is not usable: platforms unavailable and the destination is refused", async () => {
      const a = await makeOrg("ADMIN");
      const profile = await prisma.uploadPostProfile.create({ data: { organizationId: a.orgId, username: "blocked_profile", blocked: true, lastSyncedAt: new Date() } });
      await trialRun(a.orgId);
      const yt = await prisma.uploadPostConnectedAccount.create({ data: { organizationId: a.orgId, profileId: profile.id, platform: "youtube", providerAccountId: "UCblocked00000000001", lastSeenAt: new Date() } });
      const cap = (await api(a.cookie, "/capabilities")).json.data;
      expect(platformsOf(cap).youtube).toBe("UNAVAILABLE");
      expect(cap.platforms.find((p: { platform: string }) => p.platform === "youtube").reason).toMatch(/blocked/);
      const r = await http("POST", `/api/upload-post/accounts/${yt.id}/destination`, { cookie: a.cookie });
      expect(r.status).toBe(409);
      expect(r.json.error?.message).toMatch(/blocked/);
      expect(await prisma.socialAccount.count({ where: { organizationId: a.orgId } })).toBe(0);
    });

    it("capabilities are organization-scoped and never carry the key", async () => {
      const a = await makeOrg("ADMIN");
      const b = await makeOrg("ADMIN");
      const pa = await prisma.uploadPostProfile.create({ data: { organizationId: a.orgId, username: "only_a" } });
      await prisma.uploadPostConnectedAccount.create({ data: { organizationId: a.orgId, profileId: pa.id, platform: "instagram", providerAccountId: "1784140000000000a" } });
      await trialRun(a.orgId);
      await trialRun(b.orgId, { profilesSeen: 0 });
      const forB = await api(b.cookie, "/capabilities");
      expect(platformsOf(forB.json.data).instagram).toBe("UNAVAILABLE");
      expect(forB.json.data.platforms[0].connectableProfiles).toEqual([]);
      expect(forB.text).not.toContain(KEY);
      expect(forB.text).not.toContain("only_a");
    });
  });
});
