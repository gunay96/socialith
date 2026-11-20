import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@socialith/database";
import { hashPassword } from "@socialith/auth";
import { createApp } from "../app.js";
import { getMetricsRollupForTargets } from "../repositories/analytics.repository.js";

/**
 * Regression tests for TD-54: campaign analytics (and the dashboard that shares its "latest snapshot per target"
 * logic) answered HTTP 500 on MySQL because the queries used PostgreSQL-only syntax (DISTINCT ON, ::int, a
 * double-quoted alias). Everything here runs the REAL express app against a REAL MySQL 8.4 database.
 */
const enabled = Boolean(process.env.MYSQL_INTEGRATION_URL);
const suite = enabled ? describe : describe.skip;
const PASSWORD = "Correct-Horse-Battery-1";

let server: Server;
let base = "";

interface Envelope<T> { success?: boolean; data: T; error?: { code: string; message: string } }
interface Rollup { targetCount: number; publishedCount: number; syncedCount: number; viewCount: number; likeCount: number; commentCount: number; shareCount: number }
interface Dashboard {
  metrics: Rollup;
  topContent: { id: string; label: string; viewCount: number }[];
  topSounds: { id: string; label: string; viewCount: number }[];
  publishedLast30d: number;
}

async function http<T = unknown>(method: string, path: string, cookie?: string) {
  const res = await fetch(`${base}${path}`, { method, headers: cookie ? { Cookie: cookie } : {} });
  const text = await res.text();
  let json = {} as Envelope<T>;
  try {
    json = JSON.parse(text) as Envelope<T>;
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json, text };
}

interface Org { orgId: string; cookie: string }
async function makeOrg(): Promise<Org> {
  const org = await prisma.organization.create({ data: { name: "IT analytics", slug: `it-anapi-${randomUUID().slice(0, 8)}` } });
  const email = `viewer-${randomUUID().slice(0, 8)}@it-an.test`;
  await prisma.user.create({ data: { organizationId: org.id, name: "V", email, passwordHash: await hashPassword(PASSWORD), role: "VIEWER", status: "ACTIVE" } });
  const res = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: PASSWORD }) });
  expect(res.status).toBe(200);
  return { orgId: org.id, cookie: (res.headers.get("set-cookie") ?? "").split(";")[0]! };
}

type Platform = "TIKTOK" | "INSTAGRAM" | "YOUTUBE";
const account = (orgId: string, platform: Platform, handle: string) =>
  prisma.socialAccount.create({ data: { organizationId: orgId, platform, externalAccountId: `ext-${randomUUID().slice(0, 8)}`, handle, displayName: handle } });

const T0 = Date.UTC(2026, 10, 1, 12, 0, 0);
const at = (minutes: number) => new Date(T0 + minutes * 60_000);

interface Counters { views?: number | null; likes?: number | null; comments?: number | null; shares?: number | null }
async function snapshot(orgId: string, targetId: string, platform: Platform, minutes: number, c: Counters = {}, id?: string) {
  return prisma.postMetricsSnapshot.create({
    data: { ...(id ? { id } : {}), organizationId: orgId, contentTargetId: targetId, platform, viewCount: c.views ?? null, likeCount: c.likes ?? null, commentCount: c.comments ?? null, shareCount: c.shares ?? null, fetchedAt: at(minutes) },
  });
}
async function target(contentId: string, socialAccountId: string, status: "PENDING" | "SCHEDULED" | "PUBLISHED" | "FAILED" = "PUBLISHED") {
  return prisma.contentTarget.create({ data: { contentId, socialAccountId, status, publishedAt: status === "PUBLISHED" ? new Date() : null } });
}
const content = (orgId: string, over: { caption?: string | null; campaignId?: string | null; soundId?: string | null } = {}) =>
  prisma.content.create({ data: { organizationId: orgId, caption: over.caption === undefined ? `post ${randomUUID().slice(0, 6)}` : over.caption, campaignId: over.campaignId ?? null, soundId: over.soundId ?? null, status: "PUBLISHED" } });
const campaign = (orgId: string, name = "Camp") => prisma.campaign.create({ data: { organizationId: orgId, name } });

const get = <T,>(o: Org, path: string) => http<T>("GET", path, o.cookie);
const rollup = async (o: Org, path: string) => {
  const r = await get<Rollup>(o, path);
  expect(r.status, r.text).toBe(200);
  return r.json.data;
};

beforeAll(async () => {
  const app = createApp(null);
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  await prisma.organization.deleteMany({ where: { slug: { startsWith: "it-anapi-" } } });
  await prisma.$disconnect();
});

suite("Campaign analytics on MySQL 8.4 (TD-54)", () => {
  it("the endpoint answers 200 on MySQL (it answered 500 before the fix)", async () => {
    const o = await makeOrg();
    const c = await campaign(o.orgId);
    const acc = await account(o.orgId, "INSTAGRAM", "a1");
    const t = await target((await content(o.orgId, { campaignId: c.id })).id, acc.id);
    await snapshot(o.orgId, t.id, "INSTAGRAM", 1, { views: 10 });
    const r = await get<Rollup>(o, `/api/analytics/campaigns/${c.id}`);
    expect(r.status, r.text).toBe(200);
    expect(r.json.success).toBe(true);
    expect(r.json.data.viewCount).toBe(10);
  });

  it("multiple posts: sums each target's LATEST snapshot only, never the growth history", async () => {
    const o = await makeOrg();
    const c = await campaign(o.orgId);
    const acc = await account(o.orgId, "TIKTOK", "tt");
    const t1 = await target((await content(o.orgId, { campaignId: c.id })).id, acc.id);
    const t2 = await target((await content(o.orgId, { campaignId: c.id })).id, acc.id);
    const t3 = await target((await content(o.orgId, { campaignId: c.id })).id, acc.id);
    // t1 grows: 10 -> 50 -> 120 (only 120 counts); inserted out of time order on purpose
    await snapshot(o.orgId, t1.id, "TIKTOK", 30, { views: 120, likes: 12, comments: 3, shares: 1 });
    await snapshot(o.orgId, t1.id, "TIKTOK", 10, { views: 10, likes: 1, comments: 0, shares: 0 });
    await snapshot(o.orgId, t1.id, "TIKTOK", 20, { views: 50, likes: 5, comments: 1, shares: 0 });
    await snapshot(o.orgId, t2.id, "TIKTOK", 15, { views: 200, likes: 20, comments: 4, shares: 2 });
    await snapshot(o.orgId, t2.id, "TIKTOK", 5, { views: 1, likes: 1, comments: 1, shares: 1 });
    // t3 has not been synced yet
    const r = await rollup(o, `/api/analytics/campaigns/${c.id}`);
    expect(r).toEqual({ targetCount: 3, publishedCount: 3, syncedCount: 2, viewCount: 320, likeCount: 32, commentCount: 7, shareCount: 3 });
    expect(t3.id).toBeTruthy();
  });

  it("multiple publishing destinations: one content on three platforms is summed across them, and each account sees only its own", async () => {
    const o = await makeOrg();
    const c = await campaign(o.orgId);
    const ig = await account(o.orgId, "INSTAGRAM", "ig");
    const tt = await account(o.orgId, "TIKTOK", "tt");
    const yt = await account(o.orgId, "YOUTUBE", "yt");
    const post = await content(o.orgId, { campaignId: c.id });
    const tIg = await target(post.id, ig.id);
    const tTt = await target(post.id, tt.id);
    const tYt = await target(post.id, yt.id, "SCHEDULED");
    await snapshot(o.orgId, tIg.id, "INSTAGRAM", 1, { views: 100 });
    await snapshot(o.orgId, tTt.id, "TIKTOK", 1, { views: 1_000 });
    await snapshot(o.orgId, tYt.id, "YOUTUBE", 1, { views: 5 });
    const total = await rollup(o, `/api/analytics/campaigns/${c.id}`);
    expect(total).toMatchObject({ targetCount: 3, publishedCount: 2, syncedCount: 3, viewCount: 1_105 });
    expect((await rollup(o, `/api/analytics/content/${post.id}`)).viewCount).toBe(1_105);
    expect((await rollup(o, `/api/analytics/accounts/${ig.id}`))).toMatchObject({ targetCount: 1, viewCount: 100 });
    expect((await rollup(o, `/api/analytics/accounts/${tt.id}`))).toMatchObject({ targetCount: 1, viewCount: 1_000 });
  });

  it("multiple publication attempts never multiply a target's numbers", async () => {
    const o = await makeOrg();
    const c = await campaign(o.orgId);
    const acc = await account(o.orgId, "INSTAGRAM", "retry");
    const post = await content(o.orgId, { campaignId: c.id, caption: "retried post" });
    const t = await target(post.id, acc.id);
    for (let n = 1; n <= 4; n++) {
      await prisma.publishAttempt.create({
        data: { organizationId: o.orgId, contentTargetId: t.id, attemptNumber: n, status: n < 4 ? "FAILED" : "SUCCEEDED", errorCode: n < 4 ? "NETWORK_ERROR" : null, startedAt: at(n), completedAt: at(n) },
      });
    }
    await snapshot(o.orgId, t.id, "INSTAGRAM", 1, { views: 40, likes: 4 });
    const r = await rollup(o, `/api/analytics/campaigns/${c.id}`);
    expect(r).toMatchObject({ targetCount: 1, publishedCount: 1, syncedCount: 1, viewCount: 40, likeCount: 4 });
    const dash = (await get<Dashboard>(o, "/api/dashboard")).json.data;
    expect(dash.topContent).toEqual([{ id: post.id, label: "retried post", viewCount: 40 }]);
  });

  it("nullable data: NULL counters count as synced but add 0; a NULL latest snapshot does not fall back to an older one; missing relations are tolerated", async () => {
    const o = await makeOrg();
    const c = await campaign(o.orgId);
    const acc = await account(o.orgId, "INSTAGRAM", "nulls");
    const withNulls = await target((await content(o.orgId, { campaignId: c.id, caption: null })).id, acc.id);
    const nullLatest = await target((await content(o.orgId, { campaignId: c.id })).id, acc.id);
    const neverSynced = await target((await content(o.orgId, { campaignId: c.id })).id, acc.id);
    await snapshot(o.orgId, withNulls.id, "INSTAGRAM", 1, { views: 7, likes: null, comments: null, shares: null });
    // older snapshot had views, the NEWEST has none: the newest wins
    await snapshot(o.orgId, nullLatest.id, "INSTAGRAM", 1, { views: 999, likes: 99 });
    await snapshot(o.orgId, nullLatest.id, "INSTAGRAM", 2, { views: null, likes: null });
    // content with no campaign and no sound, in the same organization: not part of this campaign
    const loose = await target((await content(o.orgId, { campaignId: null })).id, acc.id);
    await snapshot(o.orgId, loose.id, "INSTAGRAM", 1, { views: 5_000 });

    const r = await rollup(o, `/api/analytics/campaigns/${c.id}`);
    expect(r).toEqual({ targetCount: 3, publishedCount: 3, syncedCount: 2, viewCount: 7, likeCount: 0, commentCount: 0, shareCount: 0 });
    expect(neverSynced.id).toBeTruthy();

    // dashboard: a caption-less post gets the placeholder label; the NULL-latest post is left out (no fabricated zero)
    const dash = (await get<Dashboard>(o, "/api/dashboard")).json.data;
    expect(dash.topContent).toHaveLength(2); // the 5,000-view loose post and the 7-view caption-less post
    const labelOf = new Map(dash.topContent.map((t) => [t.viewCount, t.label]));
    expect(labelOf.get(5_000)).toBeDefined();
    expect(labelOf.get(7)).toBe("(no caption)");
    expect(labelOf.has(999) || labelOf.has(0)).toBe(false);
  });

  it("empty campaigns answer 200 with zeros: no content at all, content without targets, targets without snapshots", async () => {
    const o = await makeOrg();
    const empty = await campaign(o.orgId, "Empty");
    expect(await rollup(o, `/api/analytics/campaigns/${empty.id}`)).toEqual({ targetCount: 0, publishedCount: 0, syncedCount: 0, viewCount: 0, likeCount: 0, commentCount: 0, shareCount: 0 });
    const noTargets = await campaign(o.orgId, "No targets");
    await content(o.orgId, { campaignId: noTargets.id });
    expect((await rollup(o, `/api/analytics/campaigns/${noTargets.id}`)).targetCount).toBe(0);
    const unsynced = await campaign(o.orgId, "Unsynced");
    const acc = await account(o.orgId, "TIKTOK", "u");
    await target((await content(o.orgId, { campaignId: unsynced.id })).id, acc.id, "SCHEDULED");
    expect(await rollup(o, `/api/analytics/campaigns/${unsynced.id}`)).toEqual({ targetCount: 1, publishedCount: 0, syncedCount: 0, viewCount: 0, likeCount: 0, commentCount: 0, shareCount: 0 });
    // a brand-new organization's dashboard is empty but healthy
    const dash = (await get<Dashboard>(await makeOrg(), "/api/dashboard"));
    expect(dash.status, dash.text).toBe(200);
    expect(dash.json.data.topContent).toEqual([]);
    expect(dash.json.data.topSounds).toEqual([]);
    expect(dash.json.data.metrics).toMatchObject({ targetCount: 0, viewCount: 0 });
  });

  it("filtering: each campaign, sound and account is separate; another organization's ids are 404 and its numbers never leak", async () => {
    const a = await makeOrg();
    const b = await makeOrg();
    const accA = await account(a.orgId, "INSTAGRAM", "fa");
    const accB = await account(b.orgId, "INSTAGRAM", "fb");
    const c1 = await campaign(a.orgId, "One");
    const c2 = await campaign(a.orgId, "Two");
    const cB = await campaign(b.orgId, "Other org");
    const sound = await prisma.sound.create({ data: { organizationId: a.orgId, title: "Track", platform: "TIKTOK" } });
    const t1 = await target((await content(a.orgId, { campaignId: c1.id, soundId: sound.id })).id, accA.id);
    const t2 = await target((await content(a.orgId, { campaignId: c2.id })).id, accA.id);
    const tB = await target((await content(b.orgId, { campaignId: cB.id })).id, accB.id);
    await snapshot(a.orgId, t1.id, "INSTAGRAM", 1, { views: 11 });
    await snapshot(a.orgId, t2.id, "INSTAGRAM", 1, { views: 22 });
    await snapshot(b.orgId, tB.id, "INSTAGRAM", 1, { views: 9_999 });
    expect((await rollup(a, `/api/analytics/campaigns/${c1.id}`)).viewCount).toBe(11);
    expect((await rollup(a, `/api/analytics/campaigns/${c2.id}`)).viewCount).toBe(22);
    expect((await rollup(a, `/api/analytics/sounds/${sound.id}`))).toMatchObject({ targetCount: 1, viewCount: 11 });
    expect((await rollup(a, `/api/analytics/accounts/${accA.id}`)).viewCount).toBe(33);
    expect((await get(a, `/api/analytics/campaigns/${cB.id}`)).status).toBe(404);
    expect((await get(a, `/api/analytics/accounts/${accB.id}`)).status).toBe(404);
    expect((await get<Dashboard>(a, "/api/dashboard")).json.data.metrics.viewCount).toBe(33);
    expect((await get(a, `/api/analytics/campaigns/${c1.id}`)).text).not.toContain("9999");
    expect((await http("GET", `/api/analytics/campaigns/${c1.id}`)).status).toBe(401);
  });

  it("ordering and limit: top content and top sounds are ranked by views, at most 5, ties broken by id, numbers are JSON numbers", async () => {
    const o = await makeOrg();
    const acc = await account(o.orgId, "INSTAGRAM", "rank");
    const views = [300, 100, 700, 500, 100, 900, 200]; // seven posts, two tied at 100
    const posts: { id: string; v: number }[] = [];
    for (const v of views) {
      const sound = await prisma.sound.create({ data: { organizationId: o.orgId, title: `Sound ${v}`, platform: "TIKTOK" } });
      const p = await content(o.orgId, { caption: `post ${v}`, soundId: sound.id });
      const t = await target(p.id, acc.id);
      await snapshot(o.orgId, t.id, "INSTAGRAM", 1, { views: 1 }); // older, must be ignored
      await snapshot(o.orgId, t.id, "INSTAGRAM", 2, { views: v });
      posts.push({ id: p.id, v });
    }
    const dash = (await get<Dashboard>(o, "/api/dashboard"));
    expect(dash.status, dash.text).toBe(200);
    expect(dash.json.data.topContent.map((t) => t.viewCount)).toEqual([900, 700, 500, 300, 200]);
    expect(dash.json.data.topSounds.map((t) => t.viewCount)).toEqual([900, 700, 500, 300, 200]);
    expect(dash.json.data.topSounds.map((t) => t.label)).toEqual(["Sound 900", "Sound 700", "Sound 500", "Sound 300", "Sound 200"]);
    for (const t of [...dash.json.data.topContent, ...dash.json.data.topSounds]) expect(typeof t.viewCount).toBe("number");

    // a tie at the cut-off is resolved by id, and the same way every time
    const tied = await makeOrg();
    const acc2 = await account(tied.orgId, "INSTAGRAM", "tie");
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const p = await content(tied.orgId, { caption: `tie ${i}` });
      const t = await target(p.id, acc2.id);
      await snapshot(tied.orgId, t.id, "INSTAGRAM", 1, { views: 50 });
      ids.push(p.id);
    }
    const first = (await get<Dashboard>(tied, "/api/dashboard")).json.data.topContent.map((t) => t.id);
    const second = (await get<Dashboard>(tied, "/api/dashboard")).json.data.topContent.map((t) => t.id);
    expect(first).toEqual([...ids].sort().slice(0, 5));
    expect(second).toEqual(first);
  });

  it("two snapshots fetched at the same instant: the newest by id is used, deterministically", async () => {
    const o = await makeOrg();
    const c = await campaign(o.orgId);
    const acc = await account(o.orgId, "INSTAGRAM", "same-ms");
    const t = await target((await content(o.orgId, { campaignId: c.id })).id, acc.id);
    await snapshot(o.orgId, t.id, "INSTAGRAM", 5, { views: 111 }, "aaaaaaaa-first");
    await snapshot(o.orgId, t.id, "INSTAGRAM", 5, { views: 222 }, "zzzzzzzz-second");
    for (let i = 0; i < 3; i++) expect((await rollup(o, `/api/analytics/campaigns/${c.id}`)).viewCount).toBe(222);
  });

  it("existing campaign list endpoints keep their ordering and pagination", async () => {
    const o = await makeOrg();
    const c = await campaign(o.orgId);
    const acc = await account(o.orgId, "INSTAGRAM", "pg");
    for (let i = 0; i < 5; i++) {
      const p = await prisma.content.create({ data: { organizationId: o.orgId, caption: `paged ${i}`, campaignId: c.id, status: "PUBLISHED", createdAt: at(i) } });
      await target(p.id, acc.id);
    }
    type Page = { items: { caption: string }[]; total: number };
    const page1 = (await get<Page>(o, `/api/content?campaignId=${c.id}&page=1&pageSize=2`)).json.data;
    const page2 = (await get<Page>(o, `/api/content?campaignId=${c.id}&page=2&pageSize=2`)).json.data;
    const page3 = (await get<Page>(o, `/api/content?campaignId=${c.id}&page=3&pageSize=2`)).json.data;
    expect(page1.total).toBe(5);
    expect(page1.items).toHaveLength(2);
    expect(page2.items).toHaveLength(2);
    expect(page3.items).toHaveLength(1);
    const all = [...page1.items, ...page2.items, ...page3.items].map((i) => i.caption);
    expect(new Set(all).size).toBe(5); // no duplicates and nothing skipped across pages
    expect(all).toEqual(["paged 4", "paged 3", "paged 2", "paged 1", "paged 0"]); // newest first, as before
  });

  it("handles far more targets than one query takes (chunked) without double-counting or dropping any", async () => {
    const o = await makeOrg();
    const acc = await account(o.orgId, "INSTAGRAM", "bulk");
    const N = 1_205;
    const contentIds = Array.from({ length: N }, () => randomUUID());
    await prisma.content.createMany({ data: contentIds.map((id) => ({ id, organizationId: o.orgId, caption: "bulk", status: "PUBLISHED" as const })) });
    const targetIds = Array.from({ length: N }, () => randomUUID());
    await prisma.contentTarget.createMany({ data: targetIds.map((id, i) => ({ id, contentId: contentIds[i]!, socialAccountId: acc.id, status: i % 2 === 0 ? ("PUBLISHED" as const) : ("PENDING" as const) })) });
    await prisma.postMetricsSnapshot.createMany({
      data: targetIds.flatMap((id, i) => [
        { organizationId: o.orgId, contentTargetId: id, platform: "INSTAGRAM" as const, viewCount: 1, fetchedAt: at(1) },
        { organizationId: o.orgId, contentTargetId: id, platform: "INSTAGRAM" as const, viewCount: i + 1, likeCount: 2, fetchedAt: at(2) },
      ]),
    });
    const r = await getMetricsRollupForTargets([...targetIds, ...targetIds.slice(0, 50)]); // duplicates in the input are counted once
    expect(r.targetCount).toBe(N);
    expect(r.syncedCount).toBe(N);
    expect(r.publishedCount).toBe(Math.ceil(N / 2));
    expect(r.viewCount).toBe((N * (N + 1)) / 2);
    expect(r.likeCount).toBe(2 * N);
  });
});
