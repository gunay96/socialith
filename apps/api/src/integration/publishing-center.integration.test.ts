import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Queue } from "bullmq";
import Redis from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@socialith/database";
import { hashPassword } from "@socialith/auth";
import { PUBLICATION_STATES, addDays, derivePublicationState, zonedDayKey, zonedTimeToUtc, type PublicationState } from "@socialith/publishing";
import { QUEUE_NAMES, contentSchedulingJobId } from "@socialith/types";
import { createApp } from "../app.js";

/**
 * Publishing Center through the REAL express app against REAL MySQL + Redis/BullMQ. No provider is ever called:
 * the API only enqueues (the worker's engine is covered by the worker integration tests).
 */
const enabled = Boolean(process.env.MYSQL_INTEGRATION_URL && process.env.REDIS_INTEGRATION_URL);
const suite = enabled ? describe : describe.skip;
const PASSWORD = "Correct-Horse-Battery-1";
const HOUR = 3_600_000;
const MIN = 60_000;
const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();

let server: Server;
let base = "";
let redis: Redis;
const queues: Queue[] = [];

interface Issue { code: string; severity: string; message: string }
interface Pub {
  id: string;
  contentId: string;
  state: PublicationState;
  approvalStatus: string;
  exception: string | null;
  scheduledAt: string | null;
  schedulingOwner: string;
  allowedActions: string[];
  attemptCount: number;
  destination: { id: string; platform: string; handle: string; creator: { id: string; name: string } | null; managedPage: { id: string; name: string } | null };
  campaign: { id: string; name: string } | null;
  provider: { jobId: string | null; externalId: string; mode: string } | null;
  captionOverride: string | null;
  effective: { caption: string | null; title: string | null };
  approvedAt: string | null;
}
interface Detail extends Pub {
  approvedBy: { id: string; name: string | null } | null;
  submittedBy: { id: string; name: string | null } | null;
  events: { type: string; toState: string | null; reason: string | null; actor: { name: string } | null }[];
  revisions: { revision: number }[];
  attempts: { attemptNumber: number; errorCode: string | null }[];
  validation: { ok: boolean; issues: Issue[]; media: { status: string; unknown: string[]; known: string[] }; fullyValidated: boolean } | null;
  content: { assets: { id: string; type: string; facts: { width: number | null; height: number | null; durationSec: number | null; sizeBytes: number | null } }[] };
}
interface Paged<T> { items: T[]; total: number }
interface Envelope<T> { success?: boolean; data: T; error?: { code: string; message: string; details?: { issues?: Issue[] } } }

async function http<T = unknown>(method: string, path: string, opts: { cookie?: string; body?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}), ...(opts.cookie ? { Cookie: opts.cookie } : {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json = {} as Envelope<T>;
  try {
    json = JSON.parse(text) as Envelope<T>;
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json, text };
}

type Role = "OWNER" | "ADMIN" | "EDITOR" | "VIEWER";
interface Session { cookie: string; orgId: string; userId: string }

async function login(email: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: PASSWORD }) });
  expect(res.status).toBe(200);
  return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
}
async function addUser(orgId: string, role: Role, name = role): Promise<Session> {
  const email = `${role.toLowerCase()}-${randomUUID().slice(0, 8)}@it-pc.test`;
  const user = await prisma.user.create({ data: { organizationId: orgId, name, email, passwordHash: await hashPassword(PASSWORD), role, status: "ACTIVE" } });
  return { cookie: await login(email), orgId, userId: user.id };
}
/**
 * Approval is REQUIRED by default (product decision) and an OWNER may approve their own submission (an ADMIN may not).
 * Most tests exercise workflow/scheduling MECHANICS, so by default the organization here has EXPLICITLY saved the
 * opt-out; tests about approval turn it on, and the tests about the defaults themselves pass `{ preference: "none" }`
 * (an organization that never saved anything — exactly what a brand-new organization is).
 */
async function makeOrg(role: Role = "OWNER", opts: { preference?: "optOut" | "none" } = {}) {
  const org = await prisma.organization.create({ data: { name: "IT PC", slug: `it-pcapi-${randomUUID().slice(0, 8)}` } });
  if ((opts.preference ?? "optOut") === "optOut") await prisma.publishingSettings.create({ data: { organizationId: org.id, requireApproval: false } });
  return addUser(org.id, role);
}

/** A publishing destination as the Upload-Post integration leaves it: profile + connected account + linked SocialAccount. */
async function makeDestination(orgId: string, platform: "TIKTOK" | "INSTAGRAM" | "YOUTUBE", handle: string, opts: { status?: "CONNECTED" | "DISCONNECTED"; creatorId?: string; managedPageId?: string; demo?: boolean } = {}) {
  const lower = platform.toLowerCase();
  const providerAccountId = `pa-${randomUUID().slice(0, 10)}`;
  const profile = await prisma.uploadPostProfile.create({ data: { organizationId: orgId, username: `prof_${randomUUID().slice(0, 8)}`, managedPageId: opts.managedPageId ?? null } });
  const account = await prisma.uploadPostConnectedAccount.create({
    data: { organizationId: orgId, profileId: profile.id, platform: lower, providerAccountId, handle, capabilities: platform === "TIKTOK" ? ["music"] : [], creatorId: opts.creatorId ?? null },
  });
  const social = await prisma.socialAccount.create({
    data: { organizationId: orgId, platform, externalAccountId: providerAccountId, handle, displayName: handle, publishingProvider: "UPLOAD_POST", status: opts.status ?? "CONNECTED", providerMetadata: opts.demo ? { seed: true } : { username: handle } },
  });
  await prisma.uploadPostConnectedAccount.update({ where: { id: account.id }, data: { socialAccountId: social.id } });
  return { social, account, profile };
}

async function makeContent(orgId: string, over: { caption?: string; campaignId?: string; soundId?: string; asset?: "VIDEO" | "IMAGE" | null; unknownMedia?: boolean } = {}) {
  const content = await prisma.content.create({ data: { organizationId: orgId, caption: over.caption ?? "New single out now, go stream it everywhere tonight", campaignId: over.campaignId ?? null, soundId: over.soundId ?? null, status: "DRAFT" } });
  if (over.asset !== null) {
    await prisma.contentAsset.create({
      data: { contentId: content.id, type: over.asset ?? "VIDEO", url: "https://cdn.example.test/v.mp4", metadata: over.unknownMedia ? undefined : over.asset === "IMAGE" ? { width: 1080, height: 1350 } : { width: 1080, height: 1920, durationSec: 30, sizeBytes: 12_000_000 } },
    });
  }
  return content;
}

const get = <T,>(s: Session, path: string) => http<T>("GET", path, { cookie: s.cookie });
const post = <T = Pub,>(s: Session, path: string, body?: unknown) => http<T>("POST", path, { cookie: s.cookie, body: body ?? {} });
const act = async (s: Session, id: string, action: string, body?: unknown) => (await post<Pub>(s, `/api/publishing/publications/${id}/${action}`, body)).json.data;
const detail = async (s: Session, id: string) => (await get<Detail>(s, `/api/publishing/publications/${id}`)).json.data;
const setSettings = (s: Session, patch: Record<string, unknown>) => http("PUT", "/api/publishing/settings", { cookie: s.cookie, body: patch });

/** Creates one publication per destination through the API and returns them. */
async function createPubs(s: Session, contentId: string, destinations: { socialAccountId: string; captionOverride?: string | null; titleOverride?: string | null; requireMusic?: boolean; scheduledAt?: string | null }[]) {
  const r = await post<{ created: { publication: Pub; validation: { ok: boolean; issues: Issue[] } }[]; skipped: { socialAccountId: string; reason: string }[] }>(s, "/api/publishing/publications", { contentId, destinations });
  expect(r.status, r.text).toBe(201);
  return r.json.data;
}

const codes = (issues: Issue[], sev = "ERROR") => issues.filter((i) => i.severity === sev).map((i) => i.code);
const schedulingQueue = () => queues.find((q) => q.name === QUEUE_NAMES.CONTENT_SCHEDULING)!;

/**
 * Every describe block runs its own express app. The API has a blanket per-IP cap (300 requests/minute, in memory
 * when there is no Redis store) which must stay as it is in production; a fresh app per block gives each block its
 * own counter instead of loosening the limit for the whole suite.
 */
function useServer() {
  beforeAll(async () => {
    const app = createApp(null);
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise((r) => server.close(r));
  });
}
suite("Publishing Center API (real MySQL + Redis, real express app)", () => {
  beforeAll(async () => {
    redis = new Redis(process.env.REDIS_INTEGRATION_URL!, { maxRetriesPerRequest: null });
    for (const name of [QUEUE_NAMES.CONTENT_SCHEDULING, QUEUE_NAMES.PUBLISHING, QUEUE_NAMES.UPLOAD_POST]) queues.push(new Queue(name, { connection: redis }));
  });
  afterAll(async () => {
    for (const q of queues) await q.obliterate({ force: true }).catch(() => undefined);
    for (const q of queues) await q.close();
    redis.disconnect();
    await prisma.organization.deleteMany({ where: { slug: { startsWith: "it-pcapi-" } } });
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await prisma.organization.deleteMany({ where: { slug: { startsWith: "it-" } } });
    for (const q of queues) await q.obliterate({ force: true }).catch(() => undefined);
  });

  describe("access control and organization isolation", () => {
    useServer();
    it("needs a session; read for every role; preparing needs EDITOR; approving and settings need ADMIN", async () => {
      const admin = await makeOrg();
      const viewer = await addUser(admin.orgId, "VIEWER");
      const editor = await addUser(admin.orgId, "EDITOR");
      const { social } = await makeDestination(admin.orgId, "TIKTOK", "band");
      const content = await makeContent(admin.orgId);

      expect((await http("GET", "/api/publishing/overview")).status).toBe(401);
      for (const p of ["/overview", "/publications", "/calendar?from=2026-11-01T00:00:00Z&to=2026-11-30T00:00:00Z", "/destinations", "/settings"]) {
        expect((await get(viewer, `/api/publishing${p}`)).status, p).toBe(200);
      }
      expect((await post(viewer, "/api/publishing/publications", { contentId: content.id, destinations: [{ socialAccountId: social.id }] })).status).toBe(403);
      const [created] = (await createPubs(editor, content.id, [{ socialAccountId: social.id }])).created;
      const id = created!.publication.id;
      expect((await post(viewer, `/api/publishing/publications/${id}/submit`)).status).toBe(403);
      expect((await post(editor, `/api/publishing/publications/${id}/submit`)).status).toBe(200);
      expect((await post(editor, `/api/publishing/publications/${id}/approve`)).status).toBe(403); // an editor cannot approve
      expect((await post(editor, `/api/publishing/publications/${id}/reject`, { reason: "no" })).status).toBe(403);
      expect((await setSettings(editor, { requireApproval: true })).status).toBe(403);
      expect((await setSettings(admin, { requireApproval: true })).status).toBe(200);
    });

    it("another organization sees nothing and gets 404 (never 403) for foreign ids; foreign destinations cannot be used", async () => {
      const a = await makeOrg();
      const b = await makeOrg();
      const destA = await makeDestination(a.orgId, "TIKTOK", "a-band");
      const destB = await makeDestination(b.orgId, "TIKTOK", "b-band");
      const contentA = await makeContent(a.orgId);
      const [pubA] = (await createPubs(a, contentA.id, [{ socialAccountId: destA.social.id }])).created;
      const id = pubA!.publication.id;

      expect((await get<Paged<Pub>>(b, "/api/publishing/publications")).json.data.total).toBe(0);
      for (const action of ["submit", "approve", "schedule", "cancel", "hold", "retry"]) {
        expect((await post(b, `/api/publishing/publications/${id}/${action}`, { scheduledAt: inMs(2 * HOUR), reason: "x" })).status, action).toBe(404);
      }
      expect((await get(b, `/api/publishing/publications/${id}`)).status).toBe(404);
      // org B cannot create a publication for org A's content, nor org A for B's destination
      expect((await post(b, "/api/publishing/publications", { contentId: contentA.id, destinations: [{ socialAccountId: destB.social.id }] })).status).toBe(404);
      const r = await createPubs(a, contentA.id, [{ socialAccountId: destB.social.id }]);
      expect(r.created).toHaveLength(0);
      expect(r.skipped[0]!.reason).toMatch(/not found/);
    });
  });

  describe("publishing settings", () => {
    useServer();
    it("an organization that never saved settings gets the PRODUCT DEFAULTS: approval required, owner may self-approve, admin may not", async () => {
      const a = await makeOrg("OWNER", { preference: "none" });
      expect(await prisma.publishingSettings.count({ where: { organizationId: a.orgId } })).toBe(0);
      const s = (await get<{ source: string; requireApproval: boolean; ownerSelfApproval: boolean; adminSelfApproval: boolean; timezone: string; recommendation: string | null; maxPostsPerDestinationPerDay: number }>(a, "/api/publishing/settings")).json.data;
      expect(s).toMatchObject({ source: "default", requireApproval: true, ownerSelfApproval: true, adminSelfApproval: false, maxPostsPerDestinationPerDay: 3 });
      expect(s.timezone).toBe("Europe/Istanbul");
      expect(s.recommendation).toMatch(/product defaults/);
    });    it("saving creates the row, is audited, validates the timezone and the bounds", async () => {
      const a = await makeOrg();
      const ok = await setSettings(a, { requireApproval: true, timezone: "Europe/Istanbul", maxPostsPerDestinationPerDay: 2 });
      expect(ok.status).toBe(200);
      expect((await get<{ source: string; requireApproval: boolean }>(a, "/api/publishing/settings")).json.data).toMatchObject({ source: "configured", requireApproval: true });
      expect(await prisma.auditLog.count({ where: { organizationId: a.orgId, action: "PUBLISHING_SETTINGS_CHANGED" } })).toBe(1);
      expect((await setSettings(a, { timezone: "Mars/Olympus" })).status).toBe(400);
      expect((await setSettings(a, { similarityThresholdPct: 10 })).status).toBe(400);
      expect((await setSettings(a, {})).status).toBe(400);
    });
  });

  describe("product decisions: approval required by default, role-based self-approval, honest media validation", () => {
    useServer();
    /** a brand-new organization: nothing saved, an OWNER, an ADMIN and an EDITOR, one TikTok destination, one content item */
    async function fresh() {
      const owner = await makeOrg("OWNER", { preference: "none" });
      const admin = await addUser(owner.orgId, "ADMIN", "Ada Admin");
      const editor = await addUser(owner.orgId, "EDITOR", "Eda Editor");
      const { social } = await makeDestination(owner.orgId, "TIKTOK", "band");
      const content = await makeContent(owner.orgId);
      return { owner, admin, editor, social, content };
    }
    const audits = (orgId: string, action: string) => prisma.auditLog.findMany({ where: { organizationId: orgId, action } });

    it("a NEW organization requires approval with nothing saved: DRAFT cannot be scheduled, by the Publishing Center or by the older content API", async () => {
      const { owner, social, content } = await fresh();
      const [c] = (await createPubs(owner, content.id, [{ socialAccountId: social.id }])).created;
      expect(c!.publication.allowedActions).not.toContain("SCHEDULE");
      const direct = await post(owner, `/api/publishing/publications/${c!.publication.id}/schedule`, { scheduledAt: inMs(2 * HOUR) });
      expect(direct.status).toBe(409);
      // the older bulk path cannot be used to get around it either
      await post(owner, `/api/content/${content.id}/targets`, { socialAccountIds: [social.id] });
      const legacy = await post<unknown>(owner, `/api/content/${content.id}/schedule`, { scheduledAt: inMs(2 * HOUR) });
      expect(legacy.status).toBe(409);
      expect(legacy.json.error!.message).toMatch(/None of this content's destinations is approved/);
      expect(await prisma.contentTarget.count({ where: { contentId: content.id, status: "SCHEDULED" } })).toBe(0);
      expect((await get<{ approval: { required: boolean; source: string } }>(owner, "/api/publishing/overview")).json.data.approval).toEqual({ required: true, source: "default" });
      expect(await prisma.publishingSettings.count({ where: { organizationId: owner.orgId } })).toBe(0); // nothing was silently saved
    });

    it("an EXPLICITLY saved preference is preserved: an unrelated settings change never re-enables approval, and the opt-out is audited", async () => {
      const { owner } = await fresh();
      expect((await setSettings(owner, { requireApproval: false })).status).toBe(200);
      expect((await setSettings(owner, { timezone: "Europe/Istanbul", maxPostsPerDestinationPerDay: 5 })).status).toBe(200);
      const s = (await get<{ requireApproval: boolean; source: string }>(owner, "/api/publishing/settings")).json.data;
      expect(s).toMatchObject({ requireApproval: false, source: "configured" });
      const changes = await audits(owner.orgId, "PUBLISHING_SETTINGS_CHANGED");
      expect(JSON.stringify(changes[0]!.metadataJson)).toContain("requireApproval");
      // and switching it back on is just as explicit
      await setSettings(owner, { requireApproval: true });
      expect((await get<{ requireApproval: boolean }>(owner, "/api/publishing/settings")).json.data.requireApproval).toBe(true);
    });

    it("an OWNER can approve their own submission — and it is ALWAYS recorded as a self-approval (audit log + publication event)", async () => {
      const { owner, social, content } = await fresh();
      const [c] = (await createPubs(owner, content.id, [{ socialAccountId: social.id }])).created;
      const id = c!.publication.id;
      await act(owner, id, "submit");
      const r = (await act(owner, id, "approve", { note: "mine, checked" })) as unknown as { publication: Pub };
      expect(r.publication.state).toBe("APPROVED");
      const self = await audits(owner.orgId, "PUBLICATION_SELF_APPROVED");
      expect(self).toHaveLength(1);
      expect(self[0]).toMatchObject({ userId: owner.userId, targetId: id });
      expect(await audits(owner.orgId, "PUBLICATION_APPROVED")).toHaveLength(1);
      const d = await detail(owner, id);
      const approved = d.events.find((e) => e.type === "APPROVED") as unknown as { metadata: { selfApproval: boolean; approverRole: string } };
      expect(approved.metadata).toMatchObject({ selfApproval: true, approverRole: "OWNER" });
    });

    it("an ADMIN cannot approve their own submission by default (403, audited as denied); another approver's approval is not a self-approval", async () => {
      const { owner, admin, editor, social, content } = await fresh();
      const [c] = (await createPubs(admin, content.id, [{ socialAccountId: social.id }])).created;
      const id = c!.publication.id;
      await act(admin, id, "submit");
      const denied = await post<unknown>(admin, `/api/publishing/publications/${id}/approve`);
      expect(denied.status).toBe(403);
      expect(denied.json.error!.message).toMatch(/Admins cannot approve what they submitted themselves/);
      expect((await detail(admin, id)).state).toBe("READY_FOR_REVIEW"); // unchanged
      expect(await audits(owner.orgId, "PUBLICATION_APPROVAL_DENIED")).toHaveLength(1);
      expect(await audits(owner.orgId, "PUBLICATION_SELF_APPROVED")).toHaveLength(0);
      // an editor cannot approve at all; the owner approving the admin's work is an ordinary approval
      expect((await post(editor, `/api/publishing/publications/${id}/approve`)).status).toBe(403);
      expect(((await act(owner, id, "approve")) as unknown as { publication: Pub }).publication.state).toBe("APPROVED");
      expect(await audits(owner.orgId, "PUBLICATION_SELF_APPROVED")).toHaveLength(0);
    });

    it("the policy is configurable per organization: allow admins, forbid the owner — each takes effect, each approval is attributed", async () => {
      const { owner, admin, social } = await fresh();
      const make = async () => {
        const c2 = await makeContent(owner.orgId, { caption: `unique ${randomUUID()}` });
        const [c] = (await createPubs(owner, c2.id, [{ socialAccountId: social.id }])).created;
        return c!.publication.id;
      };
      // the owner allows admins to approve their own work; the admin submits, then approves it themselves
      expect((await setSettings(owner, { adminSelfApproval: true })).status).toBe(200);
      const a = await make();
      expect((await post<{ publication: Pub }>(admin, `/api/publishing/publications/${a}/submit`)).status).toBe(200);
      expect((await detail(admin, a)).state).toBe("READY_FOR_REVIEW");
      expect(((await act(admin, a, "approve")) as unknown as { publication: Pub }).publication.state).toBe("APPROVED");
      const adminSelf = await audits(owner.orgId, "PUBLICATION_SELF_APPROVED");
      expect(adminSelf.map((x) => x.userId)).toEqual([admin.userId]);
      // owner self-approval switched off: the owner needs someone else
      expect((await setSettings(owner, { ownerSelfApproval: false })).status).toBe(200);
      const b = await make();
      await act(owner, b, "submit");
      const refused = await post<unknown>(owner, `/api/publishing/publications/${b}/approve`);
      expect(refused.status).toBe(403);
      expect(refused.json.error!.message).toMatch(/do not allow the owner to approve their own submission/);
      expect(((await act(admin, b, "approve")) as unknown as { publication: Pub }).publication.state).toBe("APPROVED");
    });

    it("automatic scheduling happens ONLY after approval: submitting schedules nothing, approving schedules at the planned time", async () => {
      const { owner, social, content } = await fresh();
      await setSettings(owner, { autoScheduleOnApproval: true });
      const [c] = (await createPubs(owner, content.id, [{ socialAccountId: social.id, scheduledAt: inMs(4 * HOUR) }])).created;
      const id = c!.publication.id;
      await act(owner, id, "submit");
      expect((await detail(owner, id)).state).toBe("READY_FOR_REVIEW");
      expect(await schedulingQueue().getJob(contentSchedulingJobId(content.id))).toBeFalsy(); // not scheduled before approval
      const r = (await act(owner, id, "approve")) as unknown as { publication: Pub; autoScheduled: boolean };
      expect(r.autoScheduled).toBe(true);
      expect(r.publication.state).toBe("SCHEDULED");
      expect(await schedulingQueue().getJob(contentSchedulingJobId(content.id))).toBeTruthy();
    });

    it("media validation never pretends: unknown dimensions/duration are named, and the publication is NOT 'fully validated'", async () => {
      const owner = await makeOrg();
      const { social } = await makeDestination(owner.orgId, "TIKTOK", "band");
      const known = await makeContent(owner.orgId, { caption: "known facts" });
      const unknown = await makeContent(owner.orgId, { caption: "no facts recorded", unknownMedia: true });
      const [k] = (await createPubs(owner, known.id, [{ socialAccountId: social.id }])).created;
      const [u] = (await createPubs(owner, unknown.id, [{ socialAccountId: social.id }])).created;
      type V = { ok: boolean; fullyValidated: boolean; media: { status: string; unknown: string[]; known: string[] }; issues: Issue[] };
      expect(k!.validation as unknown as V).toMatchObject({ ok: true, fullyValidated: true, media: { status: "VERIFIED", unknown: [] } });
      const uv = u!.validation as unknown as V;
      expect(uv.ok).toBe(true); // nothing is KNOWN to be wrong …
      expect(uv.fullyValidated).toBe(false); // … but that is not "validated"
      expect(uv.media).toEqual({ status: "UNVERIFIED", kind: "VIDEO", known: [], unknown: ["dimensions (aspect ratio)", "duration", "file size"] });
      expect(uv.issues.find((i) => i.code === "MEDIA_FACTS_UNKNOWN")!.message).toMatch(/NOT fully verified/);
      // the detail page shows what is unknown per file (null = unknown), and the platform/provider checks stay active
      const d = await detail(owner, u!.publication.id);
      expect(d.validation!.fullyValidated).toBe(false);
      expect(d.content.assets[0]!.facts).toEqual({ width: null, height: null, durationSec: null, sizeBytes: null });
      const dk = await detail(owner, k!.publication.id);
      expect(dk.content.assets[0]!.facts).toEqual({ width: 1080, height: 1920, durationSec: 30, sizeBytes: 12_000_000 });
      await prisma.socialAccount.update({ where: { id: social.id }, data: { status: "EXPIRED" } });
      const blocked = (await post<unknown>(owner, `/api/publishing/publications/${u!.publication.id}/validate`, {})).json.data as unknown as V;
      expect(blocked.ok).toBe(false);
      expect(blocked.issues.map((i) => i.code)).toContain("ACCOUNT_NOT_CONNECTED");
    });
  });
  describe("campaign automatic-scheduling setting", () => {
    useServer();
    it("is admin-only, audited, tri-state (inherit / on / off) and organization-scoped", async () => {
      const admin = await makeOrg();
      const editor = await addUser(admin.orgId, "EDITOR");
      const other = await makeOrg();
      const campaign = await prisma.campaign.create({ data: { organizationId: admin.orgId, name: "Single launch" } });
      type Row = { id: string; autoScheduleOnApproval: boolean | null; effective: boolean };
      const list = async (s: Session) => (await get<{ organizationDefault: boolean; items: Row[] }>(s, "/api/publishing/campaigns")).json.data;
      expect((await list(editor)).items[0]).toMatchObject({ autoScheduleOnApproval: null, effective: false }); // editors can read
      expect((await http("PUT", `/api/publishing/campaigns/${campaign.id}`, { cookie: editor.cookie, body: { autoScheduleOnApproval: true } })).status).toBe(403);
      expect((await http("PUT", `/api/publishing/campaigns/${campaign.id}`, { cookie: other.cookie, body: { autoScheduleOnApproval: true } })).status).toBe(404);
      expect((await http("PUT", `/api/publishing/campaigns/${campaign.id}`, { cookie: admin.cookie, body: { autoScheduleOnApproval: "yes" } })).status).toBe(400);
      expect((await http("PUT", `/api/publishing/campaigns/${campaign.id}`, { cookie: admin.cookie, body: { autoScheduleOnApproval: true } })).status).toBe(200);
      expect((await list(admin)).items[0]).toMatchObject({ autoScheduleOnApproval: true, effective: true });
      await setSettings(admin, { autoScheduleOnApproval: true });
      await http("PUT", `/api/publishing/campaigns/${campaign.id}`, { cookie: admin.cookie, body: { autoScheduleOnApproval: false } });
      expect((await list(admin)).items[0]).toMatchObject({ autoScheduleOnApproval: false, effective: false }); // the campaign overrides the organization
      await http("PUT", `/api/publishing/campaigns/${campaign.id}`, { cookie: admin.cookie, body: { autoScheduleOnApproval: null } });
      expect((await list(admin)).items[0]).toMatchObject({ autoScheduleOnApproval: null, effective: true }); // back to inheriting
      expect(await prisma.auditLog.count({ where: { organizationId: admin.orgId, targetType: "Campaign", action: "PUBLISHING_SETTINGS_CHANGED" } })).toBe(3);
      expect((await list(other)).items).toHaveLength(0);
    });
  });
  describe("approval workflow (DRAFT → READY_FOR_REVIEW → APPROVED → SCHEDULED)", () => {
    useServer();
    it("walks the whole lifecycle with history: who, when, why — and the job follows the database", async () => {
      const admin = await makeOrg();
      const editor = await addUser(admin.orgId, "EDITOR", "Eda Editor");
      const approver = await addUser(admin.orgId, "ADMIN", "Ali Approver");
      await setSettings(admin, { requireApproval: true });
      const { social } = await makeDestination(admin.orgId, "TIKTOK", "band");
      const content = await makeContent(admin.orgId);

      const [created] = (await createPubs(editor, content.id, [{ socialAccountId: social.id }])).created;
      const id = created!.publication.id;
      expect(created!.publication).toMatchObject({ state: "DRAFT", schedulingOwner: "NONE" });
      expect(created!.publication.allowedActions).not.toContain("SCHEDULE"); // approval is required

      // cannot skip the review
      expect((await post(editor, `/api/publishing/publications/${id}/schedule`, { scheduledAt: inMs(2 * HOUR) })).status).toBe(409);
      expect((await post(approver, `/api/publishing/publications/${id}/approve`)).status).toBe(409); // approving a draft

      expect((await act(editor, id, "submit") as unknown as { publication: Pub }).publication.state).toBe("READY_FOR_REVIEW");
      const approved = (await act(approver, id, "approve", { note: "Looks good" })) as unknown as { publication: Pub; autoScheduled: boolean };
      expect(approved.publication.state).toBe("APPROVED");
      expect(approved.autoScheduled).toBe(false);

      const scheduleAt = inMs(2 * HOUR);
      const scheduled = (await act(editor, id, "schedule", { scheduledAt: scheduleAt, timezone: "Europe/Istanbul" })) as unknown as { publication: Pub };
      expect(scheduled.publication).toMatchObject({ state: "SCHEDULED", schedulingOwner: "SOCIALITH" });
      const row = await prisma.contentTarget.findUniqueOrThrow({ where: { id } });
      expect(row).toMatchObject({ status: "SCHEDULED", scheduledTimezone: "Europe/Istanbul", approvalStatus: "APPROVED" });
      expect((await prisma.content.findUniqueOrThrow({ where: { id: content.id } })).status).toBe("SCHEDULED");
      const job = await schedulingQueue().getJob(contentSchedulingJobId(content.id));
      expect(Math.abs((job!.opts.delay ?? 0) - 2 * HOUR)).toBeLessThan(15_000);

      // reschedule moves the SAME job, no second one
      await act(editor, id, "schedule", { scheduledAt: inMs(5 * HOUR) });
      const moved = await schedulingQueue().getJob(contentSchedulingJobId(content.id));
      expect(Math.abs((moved!.opts.delay ?? 0) - 5 * HOUR)).toBeLessThan(15_000);
      expect(await schedulingQueue().getJobCounts("delayed", "waiting").then((c) => (c.delayed ?? 0) + (c.waiting ?? 0))).toBe(1);

      const d = await detail(editor, id);
      expect(d.approvedBy).toMatchObject({ name: "Ali Approver" });
      expect(d.submittedBy).toMatchObject({ name: "Eda Editor" });
      expect(d.approvedAt).not.toBeNull();
      expect(d.events.map((e) => e.type).reverse()).toEqual(["CREATED", "SUBMITTED", "APPROVED", "SCHEDULED", "RESCHEDULED"]);
      expect(d.events.find((e) => e.type === "APPROVED")).toMatchObject({ reason: "Looks good", actor: { name: "Ali Approver" } });
      expect(d.revisions).toHaveLength(1); // one reviewed revision of the content
      expect(await prisma.auditLog.count({ where: { organizationId: admin.orgId, action: { in: ["PUBLICATION_SUBMITTED", "PUBLICATION_APPROVED", "PUBLICATION_SCHEDULED", "PUBLICATION_RESCHEDULED"] } } })).toBe(4);
    });

    it("rejection needs a reason, is recorded, and the item can be corrected, resubmitted and approved", async () => {
      const admin = await makeOrg();
      await setSettings(admin, { requireApproval: true });
      const { social } = await makeDestination(admin.orgId, "TIKTOK", "band");
      const content = await makeContent(admin.orgId);
      const [c] = (await createPubs(admin, content.id, [{ socialAccountId: social.id }])).created;
      const id = c!.publication.id;
      await act(admin, id, "submit");
      expect((await post(admin, `/api/publishing/publications/${id}/reject`, {})).status).toBe(400); // no reason
      expect((await post(admin, `/api/publishing/publications/${id}/reject`, { reason: "no" })).status).toBe(400); // too short
      const rejected = await act(admin, id, "reject", { reason: "Wrong release date in the caption" });
      expect(rejected.state).toBe("REJECTED");
      const d = await detail(admin, id);
      expect(d.events.find((e) => e.type === "REJECTED")).toMatchObject({ reason: "Wrong release date in the caption" });

      expect((await post(admin, `/api/publishing/publications/${id}/approve`)).status).toBe(409); // a rejected item cannot be approved as is
      await http("PATCH", `/api/publishing/publications/${id}`, { cookie: admin.cookie, body: { captionOverride: "Out Friday — new single, go stream it on every platform" } });
      expect((await act(admin, id, "submit") as unknown as { publication: Pub }).publication.state).toBe("READY_FOR_REVIEW");
      expect((await act(admin, id, "approve") as unknown as { publication: Pub }).publication.state).toBe("APPROVED");
    });

    it("withdrawing a submission returns it to DRAFT (submitter or admin only)", async () => {
      const admin = await makeOrg();
      const editorA = await addUser(admin.orgId, "EDITOR");
      const editorB = await addUser(admin.orgId, "EDITOR");
      const { social } = await makeDestination(admin.orgId, "TIKTOK", "band");
      const content = await makeContent(admin.orgId);
      const [c] = (await createPubs(editorA, content.id, [{ socialAccountId: social.id }])).created;
      const id = c!.publication.id;
      await act(editorA, id, "submit");
      expect((await post(editorB, `/api/publishing/publications/${id}/withdraw`)).status).toBe(403);
      expect((await act(editorA, id, "withdraw")).state).toBe("DRAFT");
      await act(editorA, id, "submit");
      expect((await act(admin, id, "withdraw")).state).toBe("DRAFT");
    });

    it("an approval is pinned to what was reviewed: editing the text afterwards withdraws it, and so does a change made through the content API", async () => {
      const admin = await makeOrg();
      await setSettings(admin, { requireApproval: true });
      const { social } = await makeDestination(admin.orgId, "TIKTOK", "band");
      const content = await makeContent(admin.orgId);
      const [c] = (await createPubs(admin, content.id, [{ socialAccountId: social.id }])).created;
      const id = c!.publication.id;
      await act(admin, id, "submit");
      await act(admin, id, "approve");

      // 1. an edit through the Publishing Center
      const edited = (await http<Pub>("PATCH", `/api/publishing/publications/${id}`, { cookie: admin.cookie, body: { captionOverride: "Changed my mind about the caption entirely" } })).json.data;
      expect(edited.state).toBe("DRAFT");
      expect((await detail(admin, id)).events.map((e) => e.type)).toContain("INVALIDATED");

      // 2. content edited behind its back (the older content API), then scheduling is attempted
      await act(admin, id, "submit");
      await act(admin, id, "approve");
      await prisma.content.update({ where: { id: content.id }, data: { caption: "edited elsewhere" } });
      await prisma.contentTarget.update({ where: { id }, data: { captionOverride: null } }); // so the base caption is what counts
      const r = await post(admin, `/api/publishing/publications/${id}/schedule`, { scheduledAt: inMs(2 * HOUR) });
      expect(r.status).toBe(409);
      expect((r.json as Envelope<unknown>).error!.message).toMatch(/changed after it was approved/);
      expect((await detail(admin, id)).state).toBe("DRAFT");
    });

    it("a SCHEDULED publication whose content changes behind its back loses its approval AND its schedule when someone reschedules it (job removed, provider swept)", async () => {
      const admin = await makeOrg();
      await setSettings(admin, { requireApproval: true });
      const { social } = await makeDestination(admin.orgId, "TIKTOK", "band");
      const content = await makeContent(admin.orgId);
      const [c] = (await createPubs(admin, content.id, [{ socialAccountId: social.id }])).created;
      const id = c!.publication.id;
      await act(admin, id, "submit");
      await act(admin, id, "approve");
      await act(admin, id, "schedule", { scheduledAt: inMs(3 * HOUR) });
      expect(await schedulingQueue().getJob(contentSchedulingJobId(content.id))).toBeTruthy();

      await prisma.content.update({ where: { id: content.id }, data: { caption: "edited through the content API after approval" } });
      const r = await post(admin, `/api/publishing/publications/${id}/schedule`, { scheduledAt: inMs(5 * HOUR) });
      expect(r.status).toBe(409);
      const d = await detail(admin, id);
      expect(d.state).toBe("DRAFT"); // not "scheduled" on an approval that no longer applies
      expect(d.events.map((e) => e.type)).toContain("INVALIDATED");
      expect(await schedulingQueue().getJob(contentSchedulingJobId(content.id))).toBeFalsy();
      expect((await prisma.content.findUniqueOrThrow({ where: { id: content.id } })).status).toBe("READY");
    });
    it("an organization that EXPLICITLY saved the opt-out can schedule straight from DRAFT", async () => {
      const admin = await makeOrg();
      expect((await setSettings(admin, { requireApproval: false })).status).toBe(200); // an explicit, audited preference
      const { social } = await makeDestination(admin.orgId, "TIKTOK", "band");
      const content = await makeContent(admin.orgId);
      const [c] = (await createPubs(admin, content.id, [{ socialAccountId: social.id }])).created;
      expect(c!.publication.allowedActions).toContain("SCHEDULE");
      const s = (await act(admin, c!.publication.id, "schedule", { scheduledAt: inMs(2 * HOUR) })) as unknown as { publication: Pub };
      expect(s.publication.state).toBe("SCHEDULED");
    });
  });

  describe("scheduling operations: reschedule, unschedule, hold, release, cancel, reopen, retry", () => {
    useServer();
    async function scheduled(requireApproval = false) {
      const admin = await makeOrg();
      if (requireApproval) await setSettings(admin, { requireApproval: true });
      const dest = await makeDestination(admin.orgId, "TIKTOK", "band");
      const content = await makeContent(admin.orgId);
      const [c] = (await createPubs(admin, content.id, [{ socialAccountId: dest.social.id }])).created;
      const id = c!.publication.id;
      if (requireApproval) {
        await act(admin, id, "submit");
        await act(admin, id, "approve");
      }
      await act(admin, id, "schedule", { scheduledAt: inMs(3 * HOUR) });
      return { admin, id, content, dest };
    }

    it("unschedule returns to the approved/draft state, keeps the plan and removes the job", async () => {
      const { admin, id, content } = await scheduled(true);
      const p = await act(admin, id, "unschedule");
      expect(p.state).toBe("APPROVED");
      expect(p.scheduledAt).not.toBeNull(); // the plan is kept
      expect(await schedulingQueue().getJob(contentSchedulingJobId(content.id))).toBeFalsy();
      expect((await prisma.content.findUniqueOrThrow({ where: { id: content.id } })).status).toBe("READY");
    });

    it("hold parks it (HELD, no job); release schedules it again at the same time; a past time must be rescheduled instead", async () => {
      const { admin, id, content } = await scheduled(true);
      expect((await act(admin, id, "hold", { reason: "Artist asked to wait" })).state).toBe("HELD");
      expect(await schedulingQueue().getJob(contentSchedulingJobId(content.id))).toBeFalsy();
      expect((await act(admin, id, "release") as unknown as { publication: Pub }).publication.state).toBe("SCHEDULED");
      expect(await schedulingQueue().getJob(contentSchedulingJobId(content.id))).toBeTruthy();

      await act(admin, id, "hold");
      await prisma.contentTarget.update({ where: { id }, data: { scheduledAt: new Date(Date.now() - HOUR) } });
      expect((await post(admin, `/api/publishing/publications/${id}/release`)).status).toBe(409);
      expect(((await act(admin, id, "schedule", { scheduledAt: inMs(4 * HOUR) })) as unknown as { publication: Pub }).publication.state).toBe("SCHEDULED"); // reschedule from HELD
    });

    it("cancel is recorded with its reason and leaves only 'reopen'; reopening restores the approval state", async () => {
      const { admin, id } = await scheduled(true);
      const c = await act(admin, id, "cancel", { reason: "Campaign postponed" });
      expect(c).toMatchObject({ state: "CANCELLED", allowedActions: ["REOPEN"] });
      expect((await detail(admin, id)).events.find((e) => e.type === "CANCELLED")).toMatchObject({ reason: "Campaign postponed" });
      expect((await post(admin, `/api/publishing/publications/${id}/schedule`, { scheduledAt: inMs(2 * HOUR) })).status).toBe(409);
      expect((await act(admin, id, "reopen")).state).toBe("APPROVED");
    });

    it("illegal transitions are refused with a clear message and change nothing", async () => {
      const { admin, id } = await scheduled(true);
      for (const [action, body] of [["submit", {}], ["approve", {}], ["reject", { reason: "no way" }], ["withdraw", {}], ["release", {}], ["reopen", {}], ["retry", {}]] as const) {
        const r = await post(admin, `/api/publishing/publications/${id}/${action}`, body);
        expect(r.status, action).toBe(409);
        expect((r.json as Envelope<unknown>).error!.message, action).toMatch(/Cannot|not been|approved/);
      }
      expect((await detail(admin, id)).state).toBe("SCHEDULED");
    });

    it("nothing can be done to a publication that is in flight or published", async () => {
      const admin = await makeOrg();
      const dest = await makeDestination(admin.orgId, "TIKTOK", "band");
      const content = await makeContent(admin.orgId);
      const mk = (status: "PUBLISHING" | "PUBLISHED", attemptCount: number) => prisma.contentTarget.create({ data: { contentId: content.id, socialAccountId: dest.social.id, status, attemptCount } });
      const inflight = await mk("PUBLISHING", 1);
      for (const action of ["cancel", "hold", "unschedule", "submit", "retry"]) {
        expect((await post(admin, `/api/publishing/publications/${inflight.id}/${action}`, {})).status, action).toBe(409);
      }
      await prisma.contentTarget.delete({ where: { id: inflight.id } });
      const done = await mk("PUBLISHED", 1);
      for (const action of ["cancel", "hold", "reopen", "retry"]) expect((await post(admin, `/api/publishing/publications/${done.id}/${action}`, {})).status, action).toBe(409);
      expect((await http("PATCH", `/api/publishing/publications/${done.id}`, { cookie: admin.cookie, body: { captionOverride: "x" } })).status).toBe(409);
    });

    it("retry of a FAILED publication queues ONE publishing job (QUEUED) and clears the failure; STALE can retry or be rescheduled", async () => {
      const admin = await makeOrg();
      const dest = await makeDestination(admin.orgId, "TIKTOK", "band");
      const content = await makeContent(admin.orgId);
      const failed = await prisma.contentTarget.create({ data: { contentId: content.id, socialAccountId: dest.social.id, status: "FAILED", errorMessage: "boom", attemptCount: 2 } });
      expect((await detail(admin, failed.id)).state).toBe("FAILED");
      const r = await act(admin, failed.id, "retry");
      expect(r.state).toBe("PUBLISHING"); // attemptCount 2: an attempt has already been made
      const publishing = queues.find((q) => q.name === QUEUE_NAMES.PUBLISHING)!;
      expect(await publishing.getJob(failed.id)).toBeTruthy();
      await publishing.remove(failed.id);

      const dest2 = await makeDestination(admin.orgId, "INSTAGRAM", "band.ig");
      const stale = await prisma.contentTarget.create({ data: { contentId: content.id, socialAccountId: dest2.social.id, status: "FAILED", exception: "STALE", errorMessage: "Missed its scheduled time" } });
      const d = await detail(admin, stale.id);
      expect(d.state).toBe("STALE");
      expect(d.allowedActions).toEqual(expect.arrayContaining(["RETRY", "RESCHEDULE"]));
      const back = (await act(admin, stale.id, "schedule", { scheduledAt: inMs(3 * HOUR) })) as unknown as { publication: Pub };
      expect(back.publication.state).toBe("SCHEDULED");
      expect((await prisma.contentTarget.findUniqueOrThrow({ where: { id: stale.id } })).exception).toBeNull();
    });

    it("retry respects approval: an unapproved failed publication is refused", async () => {
      const admin = await makeOrg();
      await setSettings(admin, { requireApproval: true });
      const dest = await makeDestination(admin.orgId, "TIKTOK", "band");
      const content = await makeContent(admin.orgId);
      const failed = await prisma.contentTarget.create({ data: { contentId: content.id, socialAccountId: dest.social.id, status: "FAILED", errorMessage: "boom" } });
      const r = await post(admin, `/api/publishing/publications/${failed.id}/retry`);
      expect(r.status).toBe(409);
      expect((r.json as Envelope<unknown>).error!.message).toMatch(/not been approved/);
    });
  });

  describe("provider-side scheduled jobs (hand-off)", () => {
    useServer();
    async function handedOff(minutesAhead: number) {
      const admin = await makeOrg();
      const dest = await makeDestination(admin.orgId, "TIKTOK", "band");
      const content = await makeContent(admin.orgId);
      const at = new Date(Date.now() + minutesAhead * MIN);
      const t = await prisma.contentTarget.create({ data: { contentId: content.id, socialAccountId: dest.social.id, status: "SCHEDULED", scheduledAt: at } });
      await prisma.content.update({ where: { id: content.id }, data: { status: "SCHEDULED", scheduledAt: at } });
      await prisma.uploadPostPublication.create({
        data: { organizationId: admin.orgId, contentTargetId: t.id, mode: "PROVIDER_SCHEDULED", status: "SCHEDULED_AT_PROVIDER", externalId: `socialith:target:${t.id}:g1`, requestId: `sl-${t.id}-g1`, idempotencyKey: "k", profileUsername: "p", platform: "tiktok", providerJobId: "job_77", scheduledFor: at },
      });
      return { admin, id: t.id };
    }
    const sweepQueued = async () => (await queues.find((q) => q.name === QUEUE_NAMES.UPLOAD_POST)!.getJob("upload-post-manual-sweep")) !== undefined;

    it("is shown as PROVIDER-owned (distinct from a Socialith-queued job) with the provider job id preserved", async () => {
      const { admin, id } = await handedOff(180);
      const d = await detail(admin, id);
      expect(d).toMatchObject({ state: "SCHEDULED", schedulingOwner: "PROVIDER", providerOwned: true });
      expect(d.provider).toMatchObject({ jobId: "job_77", mode: "PROVIDER_SCHEDULED" });
      expect((await get<Paged<Pub>>(admin, "/api/publishing/publications?owner=PROVIDER")).json.data.total).toBe(1);
      expect((await get<Paged<Pub>>(admin, "/api/publishing/publications?owner=SOCIALITH")).json.data.total).toBe(0);
    });

    it("cancelling or rescheduling it queues an immediate sweep so the provider job is cancelled / edited (the database stays the master)", async () => {
      const a = await handedOff(180);
      expect((await act(a.admin, a.id, "cancel", { reason: "pulled" })).state).toBe("CANCELLED");
      expect(await sweepQueued()).toBe(true);
      await queues.find((q) => q.name === QUEUE_NAMES.UPLOAD_POST)!.obliterate({ force: true });

      const b = await handedOff(180);
      await act(b.admin, b.id, "schedule", { scheduledAt: inMs(6 * HOUR) });
      expect(await sweepQueued()).toBe(true);
    });

    it("refuses to touch a provider job that is about to run (the provider can no longer edit or cancel it)", async () => {
      const { admin, id } = await handedOff(1);
      for (const [action, body] of [["cancel", {}], ["hold", {}], ["unschedule", {}], ["schedule", { scheduledAt: inMs(5 * HOUR) }]] as const) {
        const r = await post(admin, `/api/publishing/publications/${id}/${action}`, body);
        expect(r.status, action).toBe(409);
        expect((r.json as Envelope<unknown>).error!.message, action).toMatch(/about to run/);
      }
      expect((await detail(admin, id)).state).toBe("SCHEDULED");
    });
  });

  describe("platform validation before scheduling", () => {
    useServer();
    async function submitWith(over: { platform?: "TIKTOK" | "INSTAGRAM" | "YOUTUBE"; destination?: Parameters<typeof makeDestination>[3]; content?: Parameters<typeof makeContent>[1]; caption?: string; title?: string; requireMusic?: boolean }) {
      const admin = await makeOrg();
      const platform = over.platform ?? "TIKTOK";
      const dest = await makeDestination(admin.orgId, platform, "band", over.destination);
      const content = await makeContent(admin.orgId, over.content);
      const [c] = (await createPubs(admin, content.id, [{ socialAccountId: dest.social.id, captionOverride: over.caption ?? null, titleOverride: over.title ?? null, requireMusic: over.requireMusic }])).created;
      const r = await post<{ publication: Pub; validation: { issues: Issue[] } }>(admin, `/api/publishing/publications/${c!.publication.id}/submit`);
      return { admin, id: c!.publication.id, r, issues: (r.status === 422 ? r.json.error?.details?.issues : r.json.data.validation.issues) ?? [], create: c! };
    }

    it("a clean TikTok publication submits; problems come back as a structured, actionable list (422) before anything is scheduled", async () => {
      expect((await submitWith({})).r.status).toBe(200);

      const long = await submitWith({ caption: "x".repeat(2300) });
      expect(long.r.status).toBe(422);
      expect(long.r.json.error!.code).toBe("VALIDATION_FAILED");
      expect(codes(long.issues)).toEqual(["CAPTION_TOO_LONG"]);
      expect(long.issues[0]!.message).toMatch(/2300 characters.*allows at most 2200/);
      expect((await detail(long.admin, long.id)).state).toBe("DRAFT"); // nothing moved
    });

    it("platforms differ: YouTube cannot publish an image; Instagram caps hashtags; a disconnected account blocks", async () => {
      expect(codes((await submitWith({ platform: "YOUTUBE", title: "t", content: { asset: "IMAGE" } })).issues)).toEqual(["MEDIA_UNSUPPORTED"]);
      expect(codes((await submitWith({ platform: "TIKTOK", content: { asset: "IMAGE" } })).issues)).toEqual([]); // TikTok accepts photos
      const tags = Array.from({ length: 31 }, (_, i) => `#t${i}`).join(" ");
      expect(codes((await submitWith({ platform: "INSTAGRAM", caption: tags })).issues)).toEqual(["TOO_MANY_HASHTAGS"]);
      expect(codes((await submitWith({ destination: { status: "DISCONNECTED" } })).issues)).toContain("ACCOUNT_NOT_CONNECTED");
      expect(codes((await submitWith({ destination: { demo: true } })).issues)).toContain("ACCOUNT_DEMO");
      expect(codes((await submitWith({ content: { asset: null } })).issues)).toEqual(["MEDIA_MISSING"]);
    });

    it("provider status: an account needing reauthorization or a blocked profile cannot be submitted", async () => {
      const admin = await makeOrg();
      const dest = await makeDestination(admin.orgId, "TIKTOK", "band");
      await prisma.uploadPostConnectedAccount.update({ where: { id: dest.account.id }, data: { status: "REAUTH_REQUIRED", reauthRequired: true } });
      const content = await makeContent(admin.orgId);
      const [c] = (await createPubs(admin, content.id, [{ socialAccountId: dest.social.id }])).created;
      expect(codes(c!.validation.issues)).toContain("PROVIDER_REAUTH_REQUIRED");
      await prisma.uploadPostConnectedAccount.update({ where: { id: dest.account.id }, data: { status: "CONNECTED", reauthRequired: false } });
      await prisma.uploadPostProfile.update({ where: { id: dest.profile.id }, data: { blocked: true } });
      const r = await post<unknown>(admin, `/api/publishing/publications/${c!.publication.id}/submit`);
      expect(r.status).toBe(422);
      expect(codes(r.json.error!.details!.issues!)).toEqual(["PROVIDER_PROFILE_BLOCKED"]);
    });

    it("time validity: past, too soon and too far are refused with their own codes; a valid time schedules", async () => {
      const admin = await makeOrg();
      const dest = await makeDestination(admin.orgId, "TIKTOK", "band");
      const content = await makeContent(admin.orgId);
      const [c] = (await createPubs(admin, content.id, [{ socialAccountId: dest.social.id }])).created;
      const id = c!.publication.id;
      const attempt = async (scheduledAt: string) => {
        const r = await post<unknown>(admin, `/api/publishing/publications/${id}/schedule`, { scheduledAt });
        return { status: r.status, codes: r.status === 422 ? codes(r.json.error!.details!.issues!) : [] };
      };
      expect(await attempt(inMs(-HOUR))).toEqual({ status: 422, codes: ["SCHEDULE_IN_PAST"] });
      expect(await attempt(inMs(2 * MIN))).toEqual({ status: 422, codes: ["SCHEDULE_TOO_SOON"] });
      expect(await attempt(inMs(400 * 24 * HOUR))).toEqual({ status: 422, codes: ["SCHEDULE_TOO_FAR"] });
      expect((await post(admin, `/api/publishing/publications/${id}/schedule`, { scheduledAt: "not a date at all" })).status).toBe(400);
      expect((await attempt(inMs(2 * HOUR))).status).toBe(200);
    });

    it("publishing limits per destination, in the ORGANIZATION's day (Europe/Istanbul): minimum spacing, then the daily cap", async () => {
      const admin = await makeOrg();
      await setSettings(admin, { maxPostsPerDestinationPerDay: 2, minMinutesBetweenPosts: 60, timezone: "Europe/Istanbul" });
      const dest = await makeDestination(admin.orgId, "TIKTOK", "band");
      const day = addDays(zonedDayKey(new Date(), "Europe/Istanbul"), 2); // far enough ahead to satisfy the minimum lead
      const [y, m, d] = day.split("-").map(Number) as [number, number, number];
      const local = (hour: number, minute = 0) => zonedTimeToUtc({ year: y, month: m, day: d, hour, minute }, "Europe/Istanbul").toISOString();
      const plan = async (at: string) => {
        const content = await makeContent(admin.orgId, { caption: `a different post ${randomUUID()}` });
        const [c] = (await createPubs(admin, content.id, [{ socialAccountId: dest.social.id }])).created;
        const r = await post<unknown>(admin, `/api/publishing/publications/${c!.publication.id}/schedule`, { scheduledAt: at });
        return { status: r.status, codes: r.status === 422 ? codes(r.json.error!.details!.issues!) : [] };
      };
      expect(await plan(local(10, 0))).toEqual({ status: 200, codes: [] });
      expect(await plan(local(10, 20))).toEqual({ status: 422, codes: ["LIMIT_SPACING"] }); // only 20 minutes after the first
      expect(await plan(local(14, 0))).toEqual({ status: 200, codes: [] }); // second of the day
      expect(await plan(local(18, 0))).toEqual({ status: 422, codes: ["LIMIT_DAILY_CAP"] }); // third: the cap of 2 is reached
      // the next local day starts fresh: 00:30 the following day is a different day even though it is only hours later
      const nextDay = addDays(day, 1);
      const [ny, nm, nd] = nextDay.split("-").map(Number) as [number, number, number];
      expect(await plan(zonedTimeToUtc({ year: ny, month: nm, day: nd, hour: 0, minute: 30 }, "Europe/Istanbul").toISOString())).toEqual({ status: 200, codes: [] });
    });
    it("the TikTok track: warnings by default (the post would go out without it); 'require the track' makes them blocking; a verified, rights-confirmed mapping clears them", async () => {
      const admin = await makeOrg();
      const dest = await makeDestination(admin.orgId, "TIKTOK", "band");
      const sound = await prisma.sound.create({ data: { organizationId: admin.orgId, title: "Neon Skyline", artist: "Wave Theory", platform: "TIKTOK" } });
      const content = await makeContent(admin.orgId, { soundId: sound.id });
      const [soft] = (await createPubs(admin, content.id, [{ socialAccountId: dest.social.id }])).created;
      expect(soft!.validation.ok).toBe(true);
      expect(codes(soft!.validation.issues, "WARNING")).toContain("MUSIC_NO_MAPPING");

      const dest2 = await makeDestination(admin.orgId, "TIKTOK", "band2");
      const [hard] = (await createPubs(admin, content.id, [{ socialAccountId: dest2.social.id, requireMusic: true, captionOverride: "A completely different caption for the second page" }])).created;
      expect(hard!.validation.ok).toBe(false);
      expect(codes(hard!.validation.issues)).toContain("MUSIC_NO_MAPPING");

      await prisma.soundMusicMapping.create({ data: { organizationId: admin.orgId, soundId: sound.id, providerMusicId: "7012345678901234567", providerTitle: "Neon Skyline", availability: "VERIFIED_AVAILABLE", rightsConfirmed: true, verifiedAt: new Date() } });
      const d = await detail(admin, hard!.publication.id);
      expect(d.validation!.issues.filter((i) => i.field === ("music" as unknown))).toEqual([]);
      expect(d.validation!.issues.map((i) => i.code).filter((c) => c.startsWith("MUSIC_"))).toEqual([]);
    });
  });

  describe("multi-account operations: independent publications, no repetitive distribution", () => {
    useServer();
    it("one content, several destinations: each is its own publication with its own state; acting on one never changes the others", async () => {
      const admin = await makeOrg();
      await setSettings(admin, { requireApproval: true });
      const d1 = await makeDestination(admin.orgId, "TIKTOK", "page.one");
      const d2 = await makeDestination(admin.orgId, "TIKTOK", "page.two");
      const d3 = await makeDestination(admin.orgId, "INSTAGRAM", "page.three");
      const content = await makeContent(admin.orgId);
      const { created } = await createPubs(admin, content.id, [
        { socialAccountId: d1.social.id, captionOverride: "Caption written for page one only" },
        { socialAccountId: d2.social.id, captionOverride: "Another caption, for page two this time" },
        { socialAccountId: d3.social.id },
      ]);
      const [p1, p2, p3] = created.map((c) => c.publication.id) as [string, string, string];
      expect(new Set([p1, p2, p3]).size).toBe(3);

      await act(admin, p1, "submit");
      await act(admin, p2, "submit");
      await act(admin, p1, "approve");
      await act(admin, p1, "schedule", { scheduledAt: inMs(3 * HOUR) });
      await act(admin, p2, "reject", { reason: "Needs a different hook" });
      expect((await detail(admin, p1)).state).toBe("SCHEDULED");
      expect((await detail(admin, p2)).state).toBe("REJECTED");
      expect((await detail(admin, p3)).state).toBe("DRAFT"); // untouched

      // scheduling p3 later does not move p1; the content's single job follows the EARLIEST target
      await act(admin, p3, "submit");
      await act(admin, p3, "approve");
      await act(admin, p3, "schedule", { scheduledAt: inMs(9 * HOUR) });
      const job = await schedulingQueue().getJob(contentSchedulingJobId(content.id));
      expect(Math.abs((job!.opts.delay ?? 0) - 3 * HOUR)).toBeLessThan(15_000);
      expect(Math.abs(new Date((await detail(admin, p1)).scheduledAt!).getTime() - Date.now() - 3 * HOUR)).toBeLessThan(30_000);
      // cancelling p1 re-arms the job for p3
      await act(admin, p1, "cancel", {});
      const rearmed = await schedulingQueue().getJob(contentSchedulingJobId(content.id));
      expect(Math.abs((rearmed!.opts.delay ?? 0) - 9 * HOUR)).toBeLessThan(15_000);
      expect((await detail(admin, p3)).state).toBe("SCHEDULED");
    });

    it("the same asset with the same text on several destinations of one platform is BLOCKED; a caption of its own fixes it", async () => {
      const admin = await makeOrg();
      const dests = await Promise.all([1, 2, 3].map((n) => makeDestination(admin.orgId, "TIKTOK", `page.${n}`)));
      const content = await makeContent(admin.orgId);
      const { created } = await createPubs(admin, content.id, dests.map((d) => ({ socialAccountId: d.social.id })));
      const dupes = created.map((c) => c.validation.issues.filter((i) => i.code === "DUPLICATE_CONTENT").length);
      expect(dupes).toEqual([0, 1, 1]); // the first keeps the text, the next two are repeats
      const second = created[1]!.publication.id;
      const refused = await post<unknown>(admin, `/api/publishing/publications/${second}/submit`);
      expect(refused.status).toBe(422);
      expect(refused.json.error!.details!.issues!.find((i) => i.code === "DUPLICATE_CONTENT")!.message).toMatch(/Write a caption for this page/);

      await http("PATCH", `/api/publishing/publications/${second}`, { cookie: admin.cookie, body: { captionOverride: "Behind the scenes of the new single, only on this page" } });
      expect((await post(admin, `/api/publishing/publications/${second}/submit`)).status).toBe(200);
    });

    it("the guard can be a warning or off, and different platforms never count as repeats of each other", async () => {
      const admin = await makeOrg();
      const tt = await makeDestination(admin.orgId, "TIKTOK", "t1");
      const tt2 = await makeDestination(admin.orgId, "TIKTOK", "t2");
      const ig = await makeDestination(admin.orgId, "INSTAGRAM", "i1");
      const content = await makeContent(admin.orgId);
      const run = async (guard: "BLOCK" | "WARN" | "OFF") => {
        await setSettings(admin, { duplicateGuard: guard });
        await prisma.contentTarget.deleteMany({ where: { contentId: content.id } });
        const { created } = await createPubs(admin, content.id, [{ socialAccountId: tt.social.id }, { socialAccountId: tt2.social.id }, { socialAccountId: ig.social.id }]);
        return created.map((c) => c.validation.issues.find((i) => i.code === "DUPLICATE_CONTENT")?.severity ?? null);
      };
      expect(await run("BLOCK")).toEqual([null, "ERROR", null]); // Instagram is another platform: not a repeat
      expect(await run("WARN")).toEqual([null, "WARNING", null]);
      expect(await run("OFF")).toEqual([null, null, null]);
    });

    it("a cancelled or rejected sibling does not make another destination a repeat", async () => {
      const admin = await makeOrg();
      const [d1, d2] = await Promise.all([makeDestination(admin.orgId, "TIKTOK", "p1"), makeDestination(admin.orgId, "TIKTOK", "p2")]);
      const content = await makeContent(admin.orgId);
      const { created } = await createPubs(admin, content.id, [{ socialAccountId: d1.social.id }, { socialAccountId: d2.social.id }]);
      await act(admin, created[0]!.publication.id, "cancel", {});
      const v = (await post<{ ok: boolean; issues: Issue[] }>(admin, `/api/publishing/publications/${created[1]!.publication.id}/validate`, {})).json.data;
      expect(v.issues.map((i) => i.code)).not.toContain("DUPLICATE_CONTENT");
    });

    it("a destination can have only one publication per content; the second request is skipped, not duplicated", async () => {
      const admin = await makeOrg();
      const d = await makeDestination(admin.orgId, "TIKTOK", "p1");
      const content = await makeContent(admin.orgId);
      await createPubs(admin, content.id, [{ socialAccountId: d.social.id }]);
      const again = await createPubs(admin, content.id, [{ socialAccountId: d.social.id }]);
      expect(again.created).toHaveLength(0);
      expect(again.skipped[0]!.reason).toMatch(/already has a publication/);
      expect(await prisma.contentTarget.count({ where: { contentId: content.id } })).toBe(1);
      const dup = await post(admin, "/api/publishing/publications", { contentId: content.id, destinations: [{ socialAccountId: d.social.id }, { socialAccountId: d.social.id }] });
      expect(dup.status).toBe(400);
    });
  });

  describe("automatic scheduling after approval (campaign setting over organization setting)", () => {
    useServer();
    async function setupAuto(opts: { org?: boolean; campaign?: boolean | null }) {
      const admin = await makeOrg();
      await setSettings(admin, { requireApproval: true, autoScheduleOnApproval: opts.org ?? false });
      const campaign = await prisma.campaign.create({ data: { organizationId: admin.orgId, name: "Single launch", autoScheduleOnApproval: opts.campaign ?? null } });
      const dest = await makeDestination(admin.orgId, "TIKTOK", "band");
      const content = await makeContent(admin.orgId, { campaignId: campaign.id });
      return { admin, dest, content };
    }
    const approveFlow = async (admin: Session, contentId: string, socialAccountId: string, scheduledAt: string | null) => {
      const [c] = (await createPubs(admin, contentId, [{ socialAccountId, scheduledAt }])).created;
      await act(admin, c!.publication.id, "submit");
      return { id: c!.publication.id, approve: (await act(admin, c!.publication.id, "approve")) as unknown as { publication: Pub; autoScheduled: boolean; autoScheduleIssues: Issue[] } };
    };

    it("the campaign setting turns it on: approval schedules at the time a person planned, with an AUTO_SCHEDULED event", async () => {
      const { admin, dest, content } = await setupAuto({ campaign: true });
      const { id, approve } = await approveFlow(admin, content.id, dest.social.id, inMs(4 * HOUR));
      expect(approve.autoScheduled).toBe(true);
      expect(approve.publication.state).toBe("SCHEDULED");
      expect((await detail(admin, id)).events.map((e) => e.type)).toContain("AUTO_SCHEDULED");
      expect(await schedulingQueue().getJob(contentSchedulingJobId(content.id))).toBeTruthy();
    });
    it("the campaign overrides the organization: org on + campaign off → stays APPROVED; org off + campaign null → stays APPROVED", async () => {
      const off = await setupAuto({ org: true, campaign: false });
      expect((await approveFlow(off.admin, off.content.id, off.dest.social.id, inMs(4 * HOUR))).approve).toMatchObject({ autoScheduled: false, publication: { state: "APPROVED" } });
      const inherit = await setupAuto({ org: false, campaign: null });
      expect((await approveFlow(inherit.admin, inherit.content.id, inherit.dest.social.id, inMs(4 * HOUR))).approve.autoScheduled).toBe(false);
      const inheritOn = await setupAuto({ org: true, campaign: null });
      expect((await approveFlow(inheritOn.admin, inheritOn.content.id, inheritOn.dest.social.id, inMs(4 * HOUR))).approve.autoScheduled).toBe(true);
    });
    it("it never invents a time: no planned time → APPROVED; a planned time that no longer validates → APPROVED with the reasons", async () => {
      const none = await setupAuto({ campaign: true });
      expect((await approveFlow(none.admin, none.content.id, none.dest.social.id, null)).approve).toMatchObject({ autoScheduled: false, publication: { state: "APPROVED" } });
      const past = await setupAuto({ campaign: true });
      const { approve } = await approveFlow(past.admin, past.content.id, past.dest.social.id, inMs(-2 * HOUR));
      expect(approve.autoScheduled).toBe(false);
      expect(approve.publication.state).toBe("APPROVED");
      expect(approve.autoScheduleIssues.map((i) => i.code)).toEqual(["SCHEDULE_IN_PAST"]);
    });
  });

  describe("the older content API cannot bypass approval", () => {
    useServer();
    it("when approval is required, /content/:id/schedule schedules only APPROVED destinations and refuses when none is approved", async () => {
      const admin = await makeOrg();
      await setSettings(admin, { requireApproval: true });
      const d1 = await makeDestination(admin.orgId, "TIKTOK", "p1");
      const d2 = await makeDestination(admin.orgId, "INSTAGRAM", "p2");
      const content = await makeContent(admin.orgId);
      await post(admin, `/api/content/${content.id}/targets`, { socialAccountIds: [d1.social.id, d2.social.id] });
      const at = inMs(3 * HOUR);

      const none = await post<unknown>(admin, `/api/content/${content.id}/schedule`, { scheduledAt: at });
      expect(none.status).toBe(409);
      expect(none.json.error!.message).toMatch(/None of this content's destinations is approved/);
      expect(await prisma.contentTarget.count({ where: { contentId: content.id, status: "SCHEDULED" } })).toBe(0);

      const targets = await prisma.contentTarget.findMany({ where: { contentId: content.id } });
      const t1 = targets.find((t) => t.socialAccountId === d1.social.id)!;
      await post(admin, `/api/publishing/publications/${t1.id}/submit`);
      await post(admin, `/api/publishing/publications/${t1.id}/approve`);
      expect((await post<unknown>(admin, `/api/content/${content.id}/schedule`, { scheduledAt: at })).status).toBe(200);
      const after = await prisma.contentTarget.findMany({ where: { contentId: content.id } });
      expect(after.find((t) => t.id === t1.id)!.status).toBe("SCHEDULED");
      expect(after.find((t) => t.id !== t1.id)!.status).toBe("PENDING"); // the unapproved destination is NOT scheduled
    });

    it("without the approval requirement it behaves as before, and rescheduling moves the already-scheduled targets too", async () => {
      const admin = await makeOrg();
      const d = await makeDestination(admin.orgId, "TIKTOK", "p1");
      const content = await makeContent(admin.orgId);
      await post(admin, `/api/content/${content.id}/targets`, { socialAccountIds: [d.social.id] });
      const first = new Date(Date.now() + 2 * HOUR);
      const later = new Date(Date.now() + 6 * HOUR);
      expect((await post<unknown>(admin, `/api/content/${content.id}/schedule`, { scheduledAt: first.toISOString() })).status).toBe(200);
      expect((await post<unknown>(admin, `/api/content/${content.id}/schedule`, { scheduledAt: later.toISOString() })).status).toBe(200);
      const t = await prisma.contentTarget.findFirstOrThrow({ where: { contentId: content.id } });
      expect(Math.abs(t.scheduledAt!.getTime() - later.getTime())).toBeLessThan(1_000); // the target moved with the content
      const job = await schedulingQueue().getJob(contentSchedulingJobId(content.id));
      expect(Math.abs((job!.opts.delay ?? 0) - 6 * HOUR)).toBeLessThan(15_000);
    });

    it("parked targets (held / cancelled) are not re-scheduled by the bulk path", async () => {
      const admin = await makeOrg();
      const [d1, d2] = await Promise.all([makeDestination(admin.orgId, "TIKTOK", "p1"), makeDestination(admin.orgId, "INSTAGRAM", "p2")]);
      const content = await makeContent(admin.orgId);
      const held = await prisma.contentTarget.create({ data: { contentId: content.id, socialAccountId: d1.social.id, status: "PENDING", exception: "HELD" } });
      const cancelled = await prisma.contentTarget.create({ data: { contentId: content.id, socialAccountId: d2.social.id, status: "PENDING", exception: "CANCELLED" } });
      const r = await post<unknown>(admin, `/api/content/${content.id}/schedule`, { scheduledAt: inMs(3 * HOUR) });
      expect(r.status).toBe(409);
      expect((await prisma.contentTarget.findUniqueOrThrow({ where: { id: held.id } })).status).toBe("PENDING");
      expect((await prisma.contentTarget.findUniqueOrThrow({ where: { id: cancelled.id } })).status).toBe("PENDING");
    });
  });

  describe("monitoring and reporting views", () => {
    useServer();
    it("listing by state returns exactly the publications that DERIVE to that state (every combination of the stored columns)", async () => {
      const admin = await makeOrg();
      const dest = await makeDestination(admin.orgId, "TIKTOK", "band");
      type Combo = { status: "PENDING" | "SCHEDULED" | "PUBLISHING" | "PUBLISHED" | "FAILED"; approvalStatus: "DRAFT" | "READY_FOR_REVIEW" | "APPROVED" | "REJECTED"; exception: "HELD" | "CANCELLED" | "STALE" | null; attemptCount: number; provider: boolean };
      const combos: Combo[] = [];
      for (const status of ["PENDING", "SCHEDULED", "PUBLISHING", "PUBLISHED", "FAILED"] as const) {
        for (const approvalStatus of ["DRAFT", "READY_FOR_REVIEW", "APPROVED", "REJECTED"] as const) {
          // only the combinations the engine can actually produce
          const exceptions = status === "PENDING" ? [null, "HELD", "CANCELLED"] : status === "FAILED" ? [null, "STALE"] : [null];
          for (const exception of exceptions as (Combo["exception"])[]) {
            for (const [attemptCount, provider] of status === "PUBLISHING" ? [[0, false], [2, false], [0, true]] : [[0, false]]) combos.push({ status, approvalStatus, exception, attemptCount: attemptCount as number, provider: provider as boolean });
          }
        }
      }
      const expected = new Map<PublicationState, Set<string>>(PUBLICATION_STATES.map((s) => [s, new Set<string>()]));
      for (const combo of combos) {
        const content = await makeContent(admin.orgId, { caption: `c ${randomUUID()}` });
        const t = await prisma.contentTarget.create({ data: { contentId: content.id, socialAccountId: dest.social.id, status: combo.status, approvalStatus: combo.approvalStatus, exception: combo.exception, attemptCount: combo.attemptCount, scheduledAt: new Date(Date.now() + 3 * HOUR) } });
        if (combo.provider) {
          await prisma.uploadPostPublication.create({ data: { organizationId: admin.orgId, contentTargetId: t.id, mode: "IMMEDIATE", status: "PROCESSING", externalId: `e-${t.id}`, requestId: `r-${t.id}`, idempotencyKey: "k", profileUsername: "p", platform: "tiktok" } });
        }
        expected.get(derivePublicationState({ status: combo.status, approvalStatus: combo.approvalStatus, exception: combo.exception, attemptCount: combo.attemptCount, hasProviderPublication: combo.provider }))!.add(t.id);
      }
      for (const state of PUBLICATION_STATES) {
        const got = (await get<Paged<Pub>>(admin, `/api/publishing/publications?state=${state}&pageSize=100`)).json.data;
        expect(new Set(got.items.map((i) => i.id)), state).toEqual(expected.get(state));
        for (const item of got.items) expect(item.state, `${state}:${item.id}`).toBe(state);
      }
      // and the overview counts agree
      const overview = (await get<{ byState: Record<string, number> }>(admin, "/api/publishing/overview")).json.data;
      for (const state of PUBLICATION_STATES) expect(overview.byState[state], state).toBe(expected.get(state)!.size);
    });

    it("filters: artist, campaign, platform, creator, managed page, state list, date range, search, destination; pagination", async () => {
      const admin = await makeOrg();
      const creator = await prisma.creator.create({ data: { organizationId: admin.orgId, name: "Acme Artist" } });
      const page = await prisma.managedPage.create({ data: { organizationId: admin.orgId, name: "Indie Page", slug: "indie" } });
      const tt = await makeDestination(admin.orgId, "TIKTOK", "tt.band", { creatorId: creator.id, managedPageId: page.id });
      const ig = await makeDestination(admin.orgId, "INSTAGRAM", "ig.band");
      const campaign = await prisma.campaign.create({ data: { organizationId: admin.orgId, name: "Spring single" } });
      const sound = await prisma.sound.create({ data: { organizationId: admin.orgId, title: "Neon Skyline", artist: "Wave Theory", platform: "TIKTOK" } });
      const c1 = await makeContent(admin.orgId, { campaignId: campaign.id, soundId: sound.id, caption: "Wave Theory new single out now" });
      const c2 = await makeContent(admin.orgId, { caption: "unrelated post" });
      const at1 = new Date(Date.now() + 3 * HOUR);
      const at2 = new Date(Date.now() + 5 * 24 * HOUR);
      const t1 = await prisma.contentTarget.create({ data: { contentId: c1.id, socialAccountId: tt.social.id, status: "SCHEDULED", scheduledAt: at1 } });
      const t2 = await prisma.contentTarget.create({ data: { contentId: c2.id, socialAccountId: ig.social.id, status: "FAILED", scheduledAt: at2, errorMessage: "x" } });
      const ids = async (q: string) => (await get<Paged<Pub>>(admin, `/api/publishing/publications?${q}`)).json.data.items.map((i) => i.id).sort();
      expect(await ids("")).toEqual([t1.id, t2.id].sort());
      expect(await ids("artist=wave")).toEqual([t1.id]);
      expect(await ids(`campaignId=${campaign.id}`)).toEqual([t1.id]);
      expect(await ids("platform=INSTAGRAM")).toEqual([t2.id]);
      expect(await ids(`creatorId=${creator.id}`)).toEqual([t1.id]);
      expect(await ids(`managedPageId=${page.id}`)).toEqual([t1.id]);
      expect(await ids("state=SCHEDULED,FAILED")).toEqual([t1.id, t2.id].sort());
      expect(await ids("state=FAILED")).toEqual([t2.id]);
      expect(await ids(`from=${new Date(Date.now() + 2 * 24 * HOUR).toISOString()}&to=${new Date(Date.now() + 9 * 24 * HOUR).toISOString()}`)).toEqual([t2.id]);
      expect(await ids("search=ig.band")).toEqual([t2.id]);
      expect(await ids(`destinationId=${tt.social.id}`)).toEqual([t1.id]);
      expect((await get<Paged<Pub>>(admin, "/api/publishing/publications?pageSize=1&page=2&sort=scheduledAt_asc")).json.data).toMatchObject({ total: 2 });
      expect((await get(admin, "/api/publishing/publications?state=NOPE")).status).toBe(400);
      expect((await get(admin, "/api/publishing/publications?pageSize=1000")).status).toBe(400);
    });

    it("the detail page carries every reporting field: ids, provider, external job, times, URL, failure reason, retry count, attempts, history", async () => {
      const admin = await makeOrg();
      const dest = await makeDestination(admin.orgId, "TIKTOK", "band");
      const campaign = await prisma.campaign.create({ data: { organizationId: admin.orgId, name: "Spring single" } });
      const content = await makeContent(admin.orgId, { campaignId: campaign.id });
      const published = new Date();
      const t = await prisma.contentTarget.create({ data: { contentId: content.id, socialAccountId: dest.social.id, status: "FAILED", attemptCount: 3, errorMessage: "Rate limited", externalPostId: "ext-1", externalPostUrl: "https://example.test/post/1", publishedAt: published, scheduledAt: published } });
      await prisma.publishAttempt.create({ data: { organizationId: admin.orgId, contentTargetId: t.id, attemptNumber: 1, status: "FAILED", errorCode: "RATE_LIMITED", errorMessage: "slow down", retryable: true, startedAt: published, completedAt: published } });
      await prisma.uploadPostPublication.create({ data: { organizationId: admin.orgId, contentTargetId: t.id, mode: "IMMEDIATE", status: "FAILED", externalId: `socialith:target:${t.id}:g1`, requestId: `sl-${t.id}-g1`, idempotencyKey: "secret-idem", profileUsername: "p", platform: "tiktok", providerJobId: "job_9", lastErrorKind: "RATE_LIMITED" } });
      const d = (await get<Record<string, unknown>>(admin, `/api/publishing/publications/${t.id}`));
      expect(d.status).toBe(200);
      expect(d.text).not.toContain("secret-idem"); // idempotency keys never leave the server
      expect(d.json.data).toMatchObject({
        id: t.id,
        contentId: content.id,
        campaign: { id: campaign.id },
        destination: { id: dest.social.id, platform: "TIKTOK" },
        provider: { kind: "UPLOAD_POST", jobId: "job_9", externalId: `socialith:target:${t.id}:g1` },
        externalPostUrl: "https://example.test/post/1",
        errorMessage: "Rate limited",
        attemptCount: 3,
        state: "FAILED",
      });
      expect((d.json.data as unknown as Detail).attempts[0]).toMatchObject({ attemptNumber: 1, errorCode: "RATE_LIMITED" });
      expect(d.json.data).toHaveProperty("scheduledAt");
      expect(d.json.data).toHaveProperty("publishedAt");
    });

    it("the calendar feed: range-bounded, timezone-aware, distinguishes provider from Socialith ownership, hides cancelled, caps the range", async () => {
      const admin = await makeOrg();
      const [d1, d2, d3] = await Promise.all([makeDestination(admin.orgId, "TIKTOK", "p1"), makeDestination(admin.orgId, "INSTAGRAM", "p2"), makeDestination(admin.orgId, "YOUTUBE", "p3")]);
      const content = await makeContent(admin.orgId);
      const at = new Date(Date.now() + 26 * HOUR);
      const ours = await prisma.contentTarget.create({ data: { contentId: content.id, socialAccountId: d1.social.id, status: "SCHEDULED", scheduledAt: at } });
      const theirs = await prisma.contentTarget.create({ data: { contentId: content.id, socialAccountId: d2.social.id, status: "SCHEDULED", scheduledAt: at } });
      await prisma.contentTarget.create({ data: { contentId: content.id, socialAccountId: d3.social.id, status: "PENDING", exception: "CANCELLED", scheduledAt: at } });
      await prisma.uploadPostPublication.create({ data: { organizationId: admin.orgId, contentTargetId: theirs.id, mode: "PROVIDER_SCHEDULED", status: "SCHEDULED_AT_PROVIDER", externalId: `socialith:target:${theirs.id}:g1`, requestId: `sl-${theirs.id}-g1`, idempotencyKey: "k", profileUsername: "p", platform: "instagram", providerJobId: "job_c", scheduledFor: at } });

      const from = new Date(Date.now()).toISOString();
      const to = new Date(Date.now() + 2 * 24 * HOUR).toISOString();
      const feed = (await get<{ items: { id: string; schedulingOwner: string; platform: string }[]; timezone: string; truncated: boolean }>(admin, `/api/publishing/calendar?from=${from}&to=${to}`)).json.data;
      expect(feed.timezone).toBe("Europe/Istanbul");
      expect(feed.items.map((i) => i.id).sort()).toEqual([ours.id, theirs.id].sort()); // the cancelled one is not on the calendar
      expect(feed.items.find((i) => i.id === ours.id)!.schedulingOwner).toBe("SOCIALITH");
      expect(feed.items.find((i) => i.id === theirs.id)!.schedulingOwner).toBe("PROVIDER");
      const onlyIg = (await get<{ items: { id: string }[] }>(admin, `/api/publishing/calendar?from=${from}&to=${to}&platform=INSTAGRAM`)).json.data;
      expect(onlyIg.items.map((i) => i.id)).toEqual([theirs.id]);
      const outside = (await get<{ items: unknown[] }>(admin, `/api/publishing/calendar?from=${new Date(Date.now() + 10 * 24 * HOUR).toISOString()}&to=${new Date(Date.now() + 12 * 24 * HOUR).toISOString()}`)).json.data;
      expect(outside.items).toHaveLength(0);
      expect((await get(admin, `/api/publishing/calendar?from=${to}&to=${from}`)).status).toBe(400);
      expect((await get(admin, `/api/publishing/calendar?from=${from}&to=${new Date(Date.now() + 90 * 24 * HOUR).toISOString()}`)).status).toBe(400);
      expect((await get(admin, "/api/publishing/calendar")).status).toBe(400);
    });

    it("overview metrics: scheduled, published, pending, failed (incl. stale), awaiting approval, connected accounts (demo accounts excluded), upcoming", async () => {
      const admin = await makeOrg();
      const real = await makeDestination(admin.orgId, "TIKTOK", "real");
      await makeDestination(admin.orgId, "INSTAGRAM", "demo", { demo: true });
      await makeDestination(admin.orgId, "YOUTUBE", "gone", { status: "DISCONNECTED" });
      const mk = async (data: Record<string, unknown>) => {
        const content = await makeContent(admin.orgId, { caption: `c ${randomUUID()}` });
        return prisma.contentTarget.create({ data: { contentId: content.id, socialAccountId: real.social.id, ...data } as never });
      };
      await mk({ status: "SCHEDULED", scheduledAt: new Date(Date.now() + HOUR) });
      await mk({ status: "SCHEDULED", scheduledAt: new Date(Date.now() + 2 * HOUR) });
      await mk({ status: "PUBLISHED" });
      await mk({ status: "FAILED" });
      await mk({ status: "FAILED", exception: "STALE" });
      await mk({ status: "PENDING", approvalStatus: "READY_FOR_REVIEW" });
      await mk({ status: "PENDING", approvalStatus: "DRAFT" });
      await mk({ status: "PENDING", approvalStatus: "APPROVED" });
      const o = (await get<{ metrics: Record<string, unknown>; upcoming: { id: string }[]; approval: { required: boolean }; timezone: string }>(admin, "/api/publishing/overview")).json.data;
      expect(o.metrics).toMatchObject({ scheduled: 2, published: 1, failed: 2, awaitingApproval: 1, pending: 3, connectedAccounts: 1 });
      expect(o.upcoming).toHaveLength(2);
      expect(o.approval.required).toBe(false);
      expect(o.timezone).toBe("Europe/Istanbul");
    });

    it("the destination picker: search, platform/creator/page filters, readiness with reasons, daily usage vs the cap", async () => {
      const admin = await makeOrg();
      await setSettings(admin, { maxPostsPerDestinationPerDay: 1 });
      const creator = await prisma.creator.create({ data: { organizationId: admin.orgId, name: "Acme Artist" } });
      const page = await prisma.managedPage.create({ data: { organizationId: admin.orgId, name: "Indie Page", slug: "indie" } });
      const ready = await makeDestination(admin.orgId, "TIKTOK", "ready.one", { creatorId: creator.id, managedPageId: page.id });
      const broken = await makeDestination(admin.orgId, "INSTAGRAM", "broken.one", { status: "DISCONNECTED" });
      const content = await makeContent(admin.orgId);
      await prisma.contentTarget.create({ data: { contentId: content.id, socialAccountId: ready.social.id, status: "SCHEDULED", scheduledAt: new Date(Date.now() + 10 * MIN) } });
      type Dest = { id: string; handle: string; ready: boolean; problems: { code: string }[]; supports: { music: boolean; images: boolean }; today: { count: number; cap: number; capReached: boolean }; creator: { name: string } | null; managedPage: { name: string } | null };
      const list = async (q = "") => (await get<Paged<Dest>>(admin, `/api/publishing/destinations${q}`)).json.data;
      const all = await list();
      expect(all.total).toBe(2);
      const r = all.items.find((d) => d.id === ready.social.id)!;
      expect(r).toMatchObject({ ready: true, creator: { name: "Acme Artist" }, managedPage: { name: "Indie Page" } });
      expect(r.supports).toMatchObject({ music: true, images: true });
      expect(r.today.cap).toBe(1);
      const b = all.items.find((d) => d.id === broken.social.id)!;
      expect(b.ready).toBe(false);
      expect(b.problems.map((p) => p.code)).toContain("ACCOUNT_NOT_CONNECTED");
      expect((await list("?readyOnly=true")).items.map((d) => d.handle)).toEqual(["ready.one"]);
      expect((await list("?platform=INSTAGRAM")).items.map((d) => d.handle)).toEqual(["broken.one"]);
      expect((await list(`?creatorId=${creator.id}`)).items.map((d) => d.handle)).toEqual(["ready.one"]);
      expect((await list(`?managedPageId=${page.id}`)).items.map((d) => d.handle)).toEqual(["ready.one"]);
      expect((await list("?search=broken")).items.map((d) => d.handle)).toEqual(["broken.one"]);
      expect((await list(`?ids=${broken.social.id},nope`)).items.map((d) => d.handle)).toEqual(["broken.one"]); // exactly the requested ids; unknown ids are ignored
    });
  });
});
