import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@socialith/database";
import { hashPassword } from "@socialith/auth";
import { createApp } from "../app.js";

/**
 * Page Network (Phase 4) through the REAL express app against REAL MySQL (+ Redis, which the Publishing Center hooks
 * need). No provider is ever called and nothing is published: pages, categories, groups, mappings and campaign
 * assignments are database records, and the "destinations" are rows shaped exactly like the Upload-Post integration
 * leaves them.
 */
const enabled = Boolean(process.env.MYSQL_INTEGRATION_URL && process.env.REDIS_INTEGRATION_URL);
const suite = enabled ? describe : describe.skip;
const PASSWORD = "Correct-Horse-Battery-1";

let server: Server;
let base = "";

interface Envelope<T> { success?: boolean; data: T; error?: { code: string; message: string; details?: unknown } }
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
async function addUser(orgId: string, role: Role): Promise<Session> {
  const email = `${role.toLowerCase()}-${randomUUID().slice(0, 8)}@it-pn.test`;
  const user = await prisma.user.create({ data: { organizationId: orgId, name: role, email, passwordHash: await hashPassword(PASSWORD), role, status: "ACTIVE" } });
  return { cookie: await login(email), orgId, userId: user.id };
}
async function makeOrg(role: Role = "ADMIN") {
  const org = await prisma.organization.create({ data: { name: "IT PN", slug: `it-pnapi-${randomUUID().slice(0, 8)}` } });
  return addUser(org.id, role);
}

/** A publishing destination as the Upload-Post integration leaves it: profile + connected account + linked SocialAccount. */
async function makeDestination(
  orgId: string,
  platform: "TIKTOK" | "INSTAGRAM" | "YOUTUBE",
  handle: string,
  opts: { status?: "CONNECTED" | "DISCONNECTED"; creatorId?: string; demo?: boolean; profileMappedPageId?: string } = {},
) {
  const providerAccountId = `pa-${randomUUID().slice(0, 10)}`;
  const profile = await prisma.uploadPostProfile.create({ data: { organizationId: orgId, username: `prof_${randomUUID().slice(0, 8)}`, managedPageId: opts.profileMappedPageId ?? null, lastSyncedAt: new Date() } });
  const account = await prisma.uploadPostConnectedAccount.create({
    data: { organizationId: orgId, profileId: profile.id, platform: platform.toLowerCase(), providerAccountId, handle, capabilities: platform === "TIKTOK" ? ["music"] : [], creatorId: opts.creatorId ?? null, lastSeenAt: new Date() },
  });
  const social = await prisma.socialAccount.create({
    data: { organizationId: orgId, platform, externalAccountId: providerAccountId, handle, displayName: handle, publishingProvider: "UPLOAD_POST", status: opts.status ?? "CONNECTED", providerMetadata: opts.demo ? { seed: true } : { username: handle } },
  });
  await prisma.uploadPostConnectedAccount.update({ where: { id: account.id }, data: { socialAccountId: social.id } });
  return { social, account, profile };
}

interface Cat { id: string; name: string; slug: string; status: string; language: string; defaultEditorialStyle: string | null; contentPreferences: Record<string, unknown> | null; pageCount?: number }
interface PageItem {
  id: string; name: string; slug: string; status: string; platform: string | null; username: string | null; language: string | null; effectiveLanguage: string | null;
  category: { id: string; name: string; status: string } | null; groups: { id: string; name: string }[]; incomplete: string[];
  mapping: { state: string; destination: { id: string; handle: string } | null };
}
interface Mapping {
  state: string; linked: boolean; issues: { code: string; message: string }[];
  destination: { id: string; platform: string; handle: string; provider: string; status: string } | null;
  upload: { accountStatus: string; profileStatus: string; profileBlocked: boolean; profile: { username: string } | null } | null;
  publishing: { canPublish: boolean; provider: string | null; platform: string | null; capabilities: string[] };
  lastSyncedAt: string | null; profileMappedToOtherPage: { id: string; name: string } | null; usernameMatchesDestination: boolean | null;
}
interface PageDetail extends PageItem {
  editorialIdentity: string | null; profile: Record<string, unknown> | null; internalNotes: string | null;
  identity: Identity; mapping: Mapping; campaigns: { id: string; name: string; via: string[] }[];
  publications: { total: number; byStatus: Record<string, number> } | null;
}
interface Identity {
  editorialStyle: string | null; language: string | null;
  contentPreferences: { formats: string[]; avoidTerms: string[]; maxTextLength: number | null; requiresVerifiedFacts: boolean };
  visual: { style: string | null; fonts: string[]; colors: string[]; textPosition: string | null; aspectRatio: string | null };
  guidelines: string | null; ruleEnforcement: string; sources: Record<string, string>;
}
interface IdentityResponse { appliedGroup: { id: string } | null; own: { editorialIdentity: string | null; profile: Record<string, unknown> | null }; effective: Identity }
interface Paged<T> { items: T[]; total: number }
interface GroupDetail { id: string; name: string; status: string; members: (PageItem & { addedAt: string })[]; stats: { pages: { total: number; active: number }; byPlatform: Record<string, number>; mapping: { ready: number; problem: number; unlinked: number }; byCategory: { name: string; count: number }[]; publications: { byStatus: Record<string, number> } }; campaigns: { id: string }[] }

const get = <T,>(s: Session, path: string) => http<T>("GET", path, { cookie: s.cookie });
const post = <T = unknown,>(s: Session, path: string, body?: unknown) => http<T>("POST", path, { cookie: s.cookie, body: body ?? {} });
const put = <T = unknown,>(s: Session, path: string, body: unknown) => http<T>("PUT", path, { cookie: s.cookie, body });
const patch = <T = unknown,>(s: Session, path: string, body: unknown) => http<T>("PATCH", path, { cookie: s.cookie, body });
const del = <T = unknown,>(s: Session, path: string) => http<T>("DELETE", path, { cookie: s.cookie });

const N = "/api/page-network";
const uniq = () => randomUUID().slice(0, 6);

async function mkCategory(s: Session, over: Record<string, unknown> = {}) {
  const r = await post<Cat>(s, `${N}/categories`, { name: `Cat ${uniq()}`, ...over });
  expect(r.status, r.text).toBe(201);
  return r.json.data;
}
async function mkPage(s: Session, over: Record<string, unknown> = {}) {
  const r = await post<PageDetail>(s, `${N}/pages`, { name: `Page ${uniq()}`, platform: "INSTAGRAM", username: `page_${uniq()}`, ...over });
  expect(r.status, r.text).toBe(201);
  return r.json.data;
}
async function mkGroup(s: Session, over: Record<string, unknown> = {}) {
  const r = await post<GroupDetail>(s, `${N}/groups`, { name: `Group ${uniq()}`, ...over });
  expect(r.status, r.text).toBe(201);
  return r.json.data;
}
const audit = (orgId: string, action: string) => prisma.auditLog.findMany({ where: { organizationId: orgId, action }, orderBy: { createdAt: "asc" } });

/** Every describe block runs its own express app: the blanket per-IP API rate limit (300/min) stays as it is in production. */
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

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { slug: { startsWith: "it-pnapi-" } } });
  await prisma.$disconnect();
});

// ================================================================================================================
suite("Page Network - categories and page profiles", () => {
  useServer();

  it("an administrator creates a category with every field; a duplicate name is refused", async () => {
    const admin = await makeOrg();
    const r = await post<Cat>(admin, `${N}/categories`, {
      name: "Motivation Daily",
      description: "Mindset pages",
      language: "en",
      defaultEditorialStyle: "Short motivational messages",
      contentPreferences: { contentPreferences: { formats: ["SHORT_MESSAGE"] }, visual: { style: "Cinematic backgrounds" } },
    });
    expect(r.status, r.text).toBe(201);
    expect(r.json.data).toMatchObject({ name: "Motivation Daily", slug: "motivation-daily", language: "en", status: "ACTIVE", defaultEditorialStyle: "Short motivational messages" });
    expect(r.json.data.contentPreferences).toMatchObject({ contentPreferences: { formats: ["SHORT_MESSAGE"] } });
    const dup = await post(admin, `${N}/categories`, { name: "motivation daily" });
    expect(dup.status).toBe(409);
  });

  it("a category's language defaults to the organization's", async () => {
    const admin = await makeOrg();
    await prisma.organization.update({ where: { id: admin.orgId }, data: { language: "de" } });
    expect((await mkCategory(admin)).language).toBe("de");
  });

  it("editing a category changes only what was sent and is audited", async () => {
    const admin = await makeOrg();
    const c = await mkCategory(admin, { description: "old", defaultEditorialStyle: "style A" });
    const r = await patch<Cat>(admin, `${N}/categories/${c.id}`, { description: "new" });
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({ description: "new", defaultEditorialStyle: "style A", name: c.name });
    const rows = await audit(admin.orgId, "PAGE_CATEGORY_UPDATED");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: admin.userId, targetType: "PageCategory", targetId: c.id });
  });

  it("archiving a category keeps its pages, refuses new assignments, and can be undone", async () => {
    const admin = await makeOrg();
    const c = await mkCategory(admin);
    const p = await mkPage(admin, { categoryId: c.id });
    const a = await post<Cat>(admin, `${N}/categories/${c.id}/archive`);
    expect(a.json.data.status).toBe("ARCHIVED");
    expect((await get<PageDetail>(admin, `${N}/pages/${p.id}`)).json.data.category).toMatchObject({ id: c.id, status: "ARCHIVED" });
    const refused = await post(admin, `${N}/pages`, { name: "Another", platform: "INSTAGRAM", username: `x_${uniq()}`, categoryId: c.id });
    expect(refused.status).toBe(409);
    // the page that already has it may keep being edited
    expect((await patch(admin, `${N}/pages/${p.id}`, { description: "still fine", categoryId: c.id })).status).toBe(200);
    expect((await get<{ items: Cat[] }>(admin, `${N}/categories`)).json.data.items.find((x) => x.id === c.id)).toBeUndefined();
    expect((await get<{ items: Cat[] }>(admin, `${N}/categories?status=ALL`)).json.data.items.find((x) => x.id === c.id)?.status).toBe("ARCHIVED");
    expect((await post<Cat>(admin, `${N}/categories/${c.id}/restore`)).json.data.status).toBe("ACTIVE");
    expect((await audit(admin.orgId, "PAGE_CATEGORY_ARCHIVED")).length).toBe(1);
    expect((await audit(admin.orgId, "PAGE_CATEGORY_RESTORED")).length).toBe(1);
  });

  it("starter categories are added once, never duplicate or overwrite an existing category", async () => {
    const admin = await makeOrg();
    const mine = await mkCategory(admin, { name: "Football", description: "my own football definition" });
    const first = await post<{ created: string[]; items: Cat[] }>(admin, `${N}/categories/starters`);
    expect(first.status).toBe(200);
    expect(first.json.data.created).toEqual(["Motivation", "Humor / Memes", "Relationships", "Lifestyle", "Entertainment"]);
    const second = await post<{ created: string[] }>(admin, `${N}/categories/starters`);
    expect(second.json.data.created).toEqual([]);
    const cats = (await get<{ items: Cat[] }>(admin, `${N}/categories`)).json.data.items;
    expect(cats).toHaveLength(6);
    expect(cats.find((c) => c.id === mine.id)).toMatchObject({ description: "my own football definition", defaultEditorialStyle: null });
    expect(cats.find((c) => c.name === "Motivation")?.defaultEditorialStyle).toMatch(/motivational/i);
    expect(cats.find((c) => c.name === "Motivation")?.language).toBe("tr");
    expect((await audit(admin.orgId, "PAGE_CATEGORY_STARTERS_ADDED")).length).toBe(1);
  });

  it("creates a page with every profile field; the username is normalized and a complete profile is not 'incomplete'", async () => {
    const admin = await makeOrg();
    const c = await mkCategory(admin);
    const r = await post<PageDetail>(admin, `${N}/pages`, {
      name: "Motivation Page 01",
      platform: "INSTAGRAM",
      username: "@Motivation_01",
      profileUrl: "https://instagram.com/motivation_01",
      categoryId: c.id,
      description: "Daily motivation",
      targetAudience: "18-34, gym and study",
      language: "tr",
      editorialIdentity: "Quiet, direct lines",
      profile: { visual: { fonts: ["Anton"], colors: ["#ff6a00"], textPosition: "CENTER", aspectRatio: "9:16" }, guidelines: "No medical claims" },
      internalNotes: "Run by the Istanbul team",
    });
    expect(r.status, r.text).toBe(201);
    expect(r.json.data).toMatchObject({ name: "Motivation Page 01", slug: "motivation-page-01", username: "motivation_01", platform: "INSTAGRAM", status: "ACTIVE", language: "tr", incomplete: [], editorialIdentity: "Quiet, direct lines", internalNotes: "Run by the Istanbul team" });
    expect(r.json.data.category).toMatchObject({ id: c.id });
    expect(r.json.data.mapping.state).toBe("NO_DESTINATION");
    expect((await audit(admin.orgId, "MANAGED_PAGE_CREATED"))[0]).toMatchObject({ targetId: r.json.data.id, userId: admin.userId });
  });

  it("the same handle cannot be registered twice on a platform, but may exist on another; identical names get distinct slugs", async () => {
    const admin = await makeOrg();
    const a = await mkPage(admin, { name: "Football Page", platform: "INSTAGRAM", username: "footy" });
    expect((await post(admin, `${N}/pages`, { name: "Other", platform: "INSTAGRAM", username: "@FOOTY" })).status).toBe(409);
    const b = await mkPage(admin, { name: "Football Page", platform: "TIKTOK", username: "footy" });
    expect(a.slug).toBe("football-page");
    expect(b.slug).toBe("football-page-tiktok");
  });

  it("editing a page works, is audited without copying the notes, and an archived page is read-only until restored", async () => {
    const admin = await makeOrg();
    const c = await mkCategory(admin);
    const p = await mkPage(admin);
    const r = await patch<PageDetail>(admin, `${N}/pages/${p.id}`, { name: "Renamed", categoryId: c.id, targetAudience: "everyone", internalNotes: "secret plan alpha" });
    expect(r.status, r.text).toBe(200);
    expect(r.json.data).toMatchObject({ name: "Renamed", incomplete: [] });
    const row = (await audit(admin.orgId, "MANAGED_PAGE_UPDATED"))[0]!;
    expect(row.metadataJson).toMatchObject({ fields: expect.arrayContaining(["name", "categoryId", "internalNotes"]) });
    expect(JSON.stringify(row.metadataJson)).not.toContain("secret plan alpha");

    expect((await post<PageDetail>(admin, `${N}/pages/${p.id}/archive`)).json.data.status).toBe("ARCHIVED");
    expect((await patch(admin, `${N}/pages/${p.id}`, { name: "Nope" })).status).toBe(409);
    expect((await post<PageDetail>(admin, `${N}/pages/${p.id}/restore`)).json.data.status).toBe("ACTIVE");
    expect((await patch(admin, `${N}/pages/${p.id}`, { name: "Back" })).status).toBe(200);
    expect((await audit(admin.orgId, "MANAGED_PAGE_ARCHIVED")).length).toBe(1);
  });

  it("refuses non-http profile URLs and malformed input", async () => {
    const admin = await makeOrg();
    expect((await post(admin, `${N}/pages`, { name: "x", platform: "INSTAGRAM", username: "u1", profileUrl: "javascript:alert(1)" })).status).toBe(400);
    expect((await post(admin, `${N}/pages`, { name: "x", platform: "FACEBOOK", username: "u2" })).status).toBe(400);
    expect((await post(admin, `${N}/pages`, { name: "", platform: "INSTAGRAM", username: "u3" })).status).toBe(400);
    expect((await post(admin, `${N}/pages`, { name: "x", platform: "INSTAGRAM", username: "   " })).status).toBe(400);
  });

  it("lists with filters: category, no category, platform, search, status and pagination", async () => {
    const admin = await makeOrg();
    const c1 = await mkCategory(admin, { name: "Alpha" });
    const c2 = await mkCategory(admin, { name: "Beta" });
    const a = await mkPage(admin, { name: "Alpha IG", categoryId: c1.id, platform: "INSTAGRAM", username: "alpha_ig" });
    const b = await mkPage(admin, { name: "Alpha TT", categoryId: c1.id, platform: "TIKTOK", username: "alpha_tt" });
    const c = await mkPage(admin, { name: "Beta IG", categoryId: c2.id, platform: "INSTAGRAM", username: "beta_ig" });
    const d = await mkPage(admin, { name: "Loose", username: "loose" });
    const ids = async (qs: string) => (await get<Paged<PageItem>>(admin, `${N}/pages?${qs}`)).json.data.items.map((p) => p.id).sort();
    expect(await ids(`categoryId=${c1.id}`)).toEqual([a.id, b.id].sort());
    expect(await ids(`category=none`)).toEqual([d.id]);
    expect(await ids(`platform=TIKTOK`)).toEqual([b.id]);
    expect(await ids(`search=beta`)).toEqual([c.id]);
    expect(await ids(`search=@alpha_ig`)).toEqual([a.id]);
    await post(admin, `${N}/pages/${d.id}/archive`);
    expect(await ids(``)).toEqual([a.id, b.id, c.id].sort());
    expect(await ids(`status=ARCHIVED`)).toEqual([d.id]);
    expect((await ids(`status=ALL`)).length).toBe(4);
    const page1 = (await get<Paged<PageItem>>(admin, `${N}/pages?pageSize=2&page=1`)).json.data;
    const page2 = (await get<Paged<PageItem>>(admin, `${N}/pages?pageSize=2&page=2`)).json.data;
    expect(page1.total).toBe(3);
    expect(page1.items).toHaveLength(2);
    expect(page2.items).toHaveLength(1);
  });

  it("a Phase 2 page (created through the old endpoint, no profile) still works and can be completed", async () => {
    const admin = await makeOrg();
    const legacy = await post<{ id: string; name: string }>(admin, "/api/managed-pages", { name: "Old Page" });
    expect(legacy.status, legacy.text).toBe(201);
    const listed = (await get<Paged<PageItem>>(admin, `${N}/pages`)).json.data.items.find((p) => p.id === legacy.json.data.id)!;
    expect(listed).toMatchObject({ platform: null, username: null, category: null });
    expect(listed.incomplete).toEqual(["platform", "username", "category"]);
    const c = await mkCategory(admin);
    const done = await patch<PageDetail>(admin, `${N}/pages/${legacy.json.data.id}`, { platform: "YOUTUBE", username: "old_page", categoryId: c.id });
    expect(done.status, done.text).toBe(200);
    expect(done.json.data.incomplete).toEqual([]);
  });
});

// ================================================================================================================
suite("Page Network - editorial identity", () => {
  useServer();

  const motivation = {
    defaultEditorialStyle: "Short motivational messages",
    language: "tr",
    contentPreferences: {
      contentPreferences: { formats: ["SHORT_MESSAGE"], avoidTerms: ["casino"], maxTextLength: 120 },
      visual: { style: "Cinematic", fonts: ["Anton"], colors: ["#111111"], textPosition: "CENTER", aspectRatio: "9:16" },
      guidelines: "No medical claims",
    },
  };

  it("a page without overrides inherits everything from its category (and says so)", async () => {
    const admin = await makeOrg();
    const c = await mkCategory(admin, motivation);
    const p = await mkPage(admin, { categoryId: c.id });
    const { effective } = (await get<IdentityResponse>(admin, `${N}/pages/${p.id}/identity`)).json.data;
    expect(effective.editorialStyle).toBe("Short motivational messages");
    expect(effective.language).toBe("tr");
    expect(effective.visual).toMatchObject({ style: "Cinematic", fonts: ["Anton"], textPosition: "CENTER", aspectRatio: "9:16" });
    expect(effective.contentPreferences.formats).toEqual(["SHORT_MESSAGE"]);
    expect(effective.sources["editorialStyle"]).toBe("category");
    expect(effective.sources["visual.fonts"]).toBe("category");
  });

  it("an individual page overrides the category per field; everything else is still inherited", async () => {
    const admin = await makeOrg();
    const c = await mkCategory(admin, motivation);
    const p = await mkPage(admin, { categoryId: c.id });
    const r = await put<IdentityResponse>(admin, `${N}/pages/${p.id}/identity`, {
      editorialIdentity: "Quiet reflective lines",
      profile: { visual: { colors: ["#ffffff"], aspectRatio: "4:5" }, contentPreferences: { maxTextLength: 80 } },
    });
    expect(r.status, r.text).toBe(200);
    const e = r.json.data.effective;
    expect(e.editorialStyle).toBe("Quiet reflective lines");
    expect(e.visual).toMatchObject({ colors: ["#ffffff"], aspectRatio: "4:5", fonts: ["Anton"], textPosition: "CENTER", style: "Cinematic" });
    expect(e.contentPreferences.maxTextLength).toBe(80);
    expect(e.contentPreferences.avoidTerms).toEqual(["casino"]);
    expect(e.sources).toMatchObject({ editorialStyle: "page", "visual.colors": "page", "visual.fonts": "category", "contentPreferences.maxTextLength": "page" });
    expect(r.json.data.own.profile).toMatchObject({ visual: { aspectRatio: "4:5" } });
    expect((await audit(admin.orgId, "MANAGED_PAGE_IDENTITY_UPDATED")).length).toBe(1);
  });

  it("changing the category default reaches inheriting pages but not an overridden field", async () => {
    const admin = await makeOrg();
    const c = await mkCategory(admin, motivation);
    const inheriting = await mkPage(admin, { categoryId: c.id });
    const overriding = await mkPage(admin, { categoryId: c.id, profile: { visual: { aspectRatio: "1:1" } } });
    await patch(admin, `${N}/categories/${c.id}`, { contentPreferences: { ...motivation.contentPreferences, visual: { ...motivation.contentPreferences.visual, aspectRatio: "16:9" } } });
    const a = (await get<IdentityResponse>(admin, `${N}/pages/${inheriting.id}/identity`)).json.data.effective;
    const b = (await get<IdentityResponse>(admin, `${N}/pages/${overriding.id}/identity`)).json.data.effective;
    expect(a.visual.aspectRatio).toBe("16:9");
    expect(b.visual.aspectRatio).toBe("1:1");
  });

  it("replacing the overrides with nothing goes back to inheriting", async () => {
    const admin = await makeOrg();
    const c = await mkCategory(admin, motivation);
    const p = await mkPage(admin, { categoryId: c.id, editorialIdentity: "own", profile: { visual: { style: "own style" } } });
    const r = await put<IdentityResponse>(admin, `${N}/pages/${p.id}/identity`, { editorialIdentity: null, profile: null });
    expect(r.json.data.own).toEqual({ editorialIdentity: null, language: null, profile: null });
    expect(r.json.data.effective.editorialStyle).toBe("Short motivational messages");
    expect(r.json.data.effective.visual.style).toBe("Cinematic");
  });

  it("group preferences sit between category and page, and are applied only when asked for", async () => {
    const admin = await makeOrg();
    const c = await mkCategory(admin, motivation);
    const p = await mkPage(admin, { categoryId: c.id, profile: { visual: { style: "Page look" } } });
    const g = await mkGroup(admin, { pageIds: [p.id], contentPreferences: { visual: { aspectRatio: "1:1", style: "Network look" } } });
    const without = (await get<IdentityResponse>(admin, `${N}/pages/${p.id}/identity`)).json.data;
    expect(without.effective.visual.aspectRatio).toBe("9:16");
    expect(without.appliedGroup).toBeNull();
    const withGroup = (await get<IdentityResponse>(admin, `${N}/pages/${p.id}/identity?groupId=${g.id}`)).json.data;
    expect(withGroup.appliedGroup).toMatchObject({ id: g.id });
    expect(withGroup.effective.visual).toMatchObject({ aspectRatio: "1:1", style: "Page look" });
    expect(withGroup.effective.sources["visual.aspectRatio"]).toBe("group");
    const other = await mkGroup(admin);
    expect((await get(admin, `${N}/pages/${p.id}/identity?groupId=${other.id}`)).status).toBe(400);
  });

  it("rejects an invalid editorial profile", async () => {
    const admin = await makeOrg();
    const p = await mkPage(admin);
    const bad = (profile: unknown) => put(admin, `${N}/pages/${p.id}/identity`, { profile });
    expect((await bad({ visual: { colors: ["orange"] } })).status).toBe(400);
    expect((await bad({ contentPreferences: { formats: ["NOT_A_FORMAT"] } })).status).toBe(400);
    expect((await bad({ visual: { aspectRatio: "2:1" } })).status).toBe(400);
    expect((await bad({ somethingElse: true })).status).toBe(400);
    expect((await bad({ originality: { similarityThresholdPct: 500 } })).status).toBe(400);
  });

  it("page rules: text length and avoided terms warn, BLOCK turns them into errors, verified-facts is a reminder", async () => {
    const admin = await makeOrg();
    const p = await mkPage(admin, { profile: { contentPreferences: { maxTextLength: 20, avoidTerms: ["bahis"], requiresVerifiedFacts: true } } });
    const r = await post<{ ok: boolean; issues: { code: string; severity: string }[] }>(admin, `${N}/pages/${p.id}/check-text`, { text: "Bahis sitesine gir, bu metin çok uzun bir metin" });
    expect(r.status, r.text).toBe(200);
    expect(r.json.data.ok).toBe(true);
    expect(r.json.data.issues.map((i) => [i.code, i.severity])).toEqual(expect.arrayContaining([["PAGE_RULE_TEXT_TOO_LONG", "WARNING"], ["PAGE_RULE_AVOIDED_TERM", "WARNING"], ["PAGE_RULE_VERIFIED_FACTS", "INFO"]]));
    await put(admin, `${N}/pages/${p.id}/identity`, { profile: { ruleEnforcement: "BLOCK", contentPreferences: { maxTextLength: 20 } } });
    const blocked = await post<{ ok: boolean; issues: { code: string; severity: string }[] }>(admin, `${N}/pages/${p.id}/check-text`, { text: "this text is clearly longer than twenty characters" });
    expect(blocked.json.data.ok).toBe(false);
    expect(blocked.json.data.issues.find((i) => i.code === "PAGE_RULE_TEXT_TOO_LONG")?.severity).toBe("ERROR");
  });

  it("originality: a text that repeats an earlier post of the SAME page is flagged; a new one is not", async () => {
    const admin = await makeOrg();
    const dest = await makeDestination(admin.orgId, "INSTAGRAM", "orig_page");
    const p = await mkPage(admin, { username: "orig_page", socialAccountId: dest.social.id });
    const earlier = "Never give up on the days that feel the hardest, they build you";
    const content = await prisma.content.create({ data: { organizationId: admin.orgId, caption: earlier, status: "PUBLISHED" } });
    await prisma.contentTarget.create({ data: { contentId: content.id, socialAccountId: dest.social.id, status: "PUBLISHED", publishedAt: new Date() } });
    type Check = { issues: { code: string; severity: string }[]; comparedWith: number };
    const same = (await post<Check>(admin, `${N}/pages/${p.id}/check-text`, { text: earlier })).json.data;
    expect(same.comparedWith).toBe(1);
    expect(same.issues).toEqual([expect.objectContaining({ code: "PAGE_RULE_NOT_ORIGINAL", severity: "WARNING" })]);
    const fresh = (await post<Check>(admin, `${N}/pages/${p.id}/check-text`, { text: "Start small today and let tomorrow take care of itself" })).json.data;
    expect(fresh.issues).toEqual([]);
    // a page that switches the check off
    await put(admin, `${N}/pages/${p.id}/identity`, { profile: { originality: { lookbackPosts: 0 } } });
    expect((await post<Check>(admin, `${N}/pages/${p.id}/check-text`, { text: earlier })).json.data.issues).toEqual([]);
  });

  it("the editorial format definitions are served and are definitions only", async () => {
    const admin = await makeOrg("VIEWER");
    const r = await get<{ items: { id: string; implementation: string }[] }>(admin, `${N}/formats`);
    expect(r.status).toBe(200);
    expect(r.json.data.items.length).toBeGreaterThan(5);
    expect(new Set(r.json.data.items.map((f) => f.implementation))).toEqual(new Set(["DEFINITION_ONLY"]));
  });
});

// ================================================================================================================
suite("Page Network - account mapping", () => {
  useServer();

  it("links a destination to a page and shows provider, platform, username, status, capability, profile and sync time", async () => {
    const admin = await makeOrg();
    const dest = await makeDestination(admin.orgId, "TIKTOK", "tt_motivation");
    const p = await mkPage(admin, { platform: "TIKTOK", username: "tt_motivation" });
    const r = await put<PageDetail>(admin, `${N}/pages/${p.id}/destination`, { socialAccountId: dest.social.id });
    expect(r.status, r.text).toBe(200);
    const m = r.json.data.mapping;
    expect(m).toMatchObject({ state: "READY", linked: true, usernameMatchesDestination: true });
    expect(m.destination).toMatchObject({ id: dest.social.id, platform: "TIKTOK", handle: "tt_motivation", provider: "UPLOAD_POST", status: "CONNECTED" });
    expect(m.upload).toMatchObject({ accountStatus: "CONNECTED", profileStatus: "ACTIVE", profileBlocked: false });
    expect(m.upload?.profile?.username).toBe(dest.profile.username);
    expect(m.publishing).toMatchObject({ canPublish: true, provider: "UPLOAD_POST", platform: "TIKTOK", capabilities: ["music"] });
    expect(m.lastSyncedAt).not.toBeNull();
    const rows = await audit(admin.orgId, "MANAGED_PAGE_DESTINATION_LINKED");
    expect(rows[0]!.metadataJson).toMatchObject({ from: null, to: dest.social.id });
    // linking again is a no-op, not a second audit row
    await put(admin, `${N}/pages/${p.id}/destination`, { socialAccountId: dest.social.id });
    expect((await audit(admin.orgId, "MANAGED_PAGE_DESTINATION_LINKED")).length).toBe(1);
  });

  it("a destination can be linked while the page is created", async () => {
    const admin = await makeOrg();
    const dest = await makeDestination(admin.orgId, "YOUTUBE", "yt_one");
    const p = await mkPage(admin, { platform: "YOUTUBE", username: "yt_one", socialAccountId: dest.social.id });
    expect(p.mapping).toMatchObject({ state: "READY" });
  });

  it("never fabricates a connection: no destination = NO_DESTINATION, unknown or foreign destinations are 404", async () => {
    const admin = await makeOrg();
    const other = await makeOrg();
    const foreign = await makeDestination(other.orgId, "INSTAGRAM", "foreign");
    const p = await mkPage(admin);
    const detail = (await get<PageDetail>(admin, `${N}/pages/${p.id}`)).json.data;
    expect(detail.mapping).toMatchObject({ state: "NO_DESTINATION", linked: false, destination: null, upload: null, lastSyncedAt: null, publishing: { canPublish: false } });
    expect((await put(admin, `${N}/pages/${p.id}/destination`, { socialAccountId: "does-not-exist" })).status).toBe(404);
    expect((await put(admin, `${N}/pages/${p.id}/destination`, { socialAccountId: foreign.social.id })).status).toBe(404);
    expect(await prisma.socialAccount.count({ where: { organizationId: admin.orgId } })).toBe(0);
  });

  it("one destination serves one page; unlinking frees it", async () => {
    const admin = await makeOrg();
    const dest = await makeDestination(admin.orgId, "INSTAGRAM", "shared_account");
    const a = await mkPage(admin, { name: "Page A", username: "page_a" });
    const b = await mkPage(admin, { name: "Page B", username: "page_b" });
    expect((await put(admin, `${N}/pages/${a.id}/destination`, { socialAccountId: dest.social.id })).status).toBe(200);
    const clash = await put(admin, `${N}/pages/${b.id}/destination`, { socialAccountId: dest.social.id });
    expect(clash.status).toBe(409);
    expect(clash.json.error?.message).toContain("Page A");
    const freed = await put<PageDetail>(admin, `${N}/pages/${a.id}/destination`, { socialAccountId: null });
    expect(freed.json.data.mapping.state).toBe("NO_DESTINATION");
    expect((await audit(admin.orgId, "MANAGED_PAGE_DESTINATION_UNLINKED")).length).toBe(1);
    expect((await put(admin, `${N}/pages/${b.id}/destination`, { socialAccountId: dest.social.id })).status).toBe(200);
    // the destination row itself was never copied or recreated
    expect(await prisma.socialAccount.count({ where: { organizationId: admin.orgId } })).toBe(1);
  });

  it("refuses a destination of another platform, a page without a platform, a demo account and a creator's account", async () => {
    const admin = await makeOrg();
    const creator = await prisma.creator.create({ data: { organizationId: admin.orgId, name: "Private Creator Name" } });
    const tt = await makeDestination(admin.orgId, "TIKTOK", "tt_x");
    const demo = await makeDestination(admin.orgId, "INSTAGRAM", "demo_acc", { demo: true });
    const owned = await makeDestination(admin.orgId, "INSTAGRAM", "creator_acc", { creatorId: creator.id });
    const page = await mkPage(admin, { platform: "INSTAGRAM", username: "ig_page" });
    expect((await put(admin, `${N}/pages/${page.id}/destination`, { socialAccountId: tt.social.id })).status).toBe(409);
    expect((await put(admin, `${N}/pages/${page.id}/destination`, { socialAccountId: demo.social.id })).status).toBe(409);
    const refused = await put(admin, `${N}/pages/${page.id}/destination`, { socialAccountId: owned.social.id });
    expect(refused.status).toBe(409);
    expect(refused.text).not.toContain("Private Creator Name");
    const legacy = await post<{ id: string }>(admin, "/api/managed-pages", { name: "No platform yet" });
    expect((await put(admin, `${N}/pages/${legacy.json.data.id}/destination`, { socialAccountId: tt.social.id })).status).toBe(409);
    expect((await get<PageDetail>(admin, `${N}/pages/${page.id}`)).json.data.mapping.state).toBe("NO_DESTINATION");
  });

  it("the platform of a page cannot change while a destination is linked", async () => {
    const admin = await makeOrg();
    const dest = await makeDestination(admin.orgId, "INSTAGRAM", "plat_lock");
    const p = await mkPage(admin, { username: "plat_lock", socialAccountId: dest.social.id });
    expect((await patch(admin, `${N}/pages/${p.id}`, { platform: "TIKTOK" })).status).toBe(409);
    expect((await patch(admin, `${N}/pages/${p.id}`, { platform: "INSTAGRAM", name: "same platform is fine" })).status).toBe(200);
  });

  it("detects disconnected and unavailable accounts from the live provider state", async () => {
    const admin = await makeOrg();
    const dest = await makeDestination(admin.orgId, "INSTAGRAM", "health_check");
    const p = await mkPage(admin, { username: "health_check", socialAccountId: dest.social.id });
    const state = async () => (await get<PageDetail>(admin, `${N}/pages/${p.id}`)).json.data.mapping;
    expect((await state()).state).toBe("READY");

    // the platform account itself disconnected
    await prisma.socialAccount.update({ where: { id: dest.social.id }, data: { status: "DISCONNECTED" } });
    let m = await state();
    expect(m.state).toBe("DISCONNECTED");
    expect(m.publishing.canPublish).toBe(false);
    expect(m.issues.map((i) => i.code)).toContain("ACCOUNT_NOT_CONNECTED");
    await prisma.socialAccount.update({ where: { id: dest.social.id }, data: { status: "CONNECTED" } });

    // Upload-Post says the account must be re-authorized
    await prisma.uploadPostConnectedAccount.update({ where: { id: dest.account.id }, data: { status: "REAUTH_REQUIRED", reauthRequired: true } });
    m = await state();
    expect(m.state).toBe("REAUTH_REQUIRED");
    expect(m.issues.map((i) => i.code)).toContain("PROVIDER_REAUTH_REQUIRED");

    // gone from its Upload-Post profile
    await prisma.uploadPostConnectedAccount.update({ where: { id: dest.account.id }, data: { status: "DISCONNECTED", reauthRequired: false } });
    expect((await state()).state).toBe("DISCONNECTED");
    await prisma.uploadPostConnectedAccount.update({ where: { id: dest.account.id }, data: { status: "CONNECTED" } });

    // profile removed / blocked at the provider
    await prisma.uploadPostProfile.update({ where: { id: dest.profile.id }, data: { status: "REMOVED" } });
    m = await state();
    expect(m.state).toBe("UNAVAILABLE");
    expect(m.issues.map((i) => i.code)).toContain("PROVIDER_PROFILE_REMOVED");
    await prisma.uploadPostProfile.update({ where: { id: dest.profile.id }, data: { status: "ACTIVE", blocked: true } });
    expect((await state()).issues.map((i) => i.code)).toContain("PROVIDER_PROFILE_BLOCKED");
    await prisma.uploadPostProfile.update({ where: { id: dest.profile.id }, data: { blocked: false } });

    // a different real account is now behind the handle
    await prisma.uploadPostConnectedAccount.update({ where: { id: dest.account.id }, data: { providerAccountId: "someone-else" } });
    expect((await state()).issues.map((i) => i.code)).toContain("PROVIDER_IDENTITY_CHANGED");
    await prisma.uploadPostConnectedAccount.update({ where: { id: dest.account.id }, data: { providerAccountId: dest.social.externalAccountId } });
    expect((await state()).state).toBe("READY");

    // the destination was switched off at Upload-Post (link cleared): the page keeps its reference, now disconnected
    await prisma.uploadPostConnectedAccount.update({ where: { id: dest.account.id }, data: { socialAccountId: null } });
    await prisma.socialAccount.update({ where: { id: dest.social.id }, data: { status: "DISCONNECTED" } });
    m = await state();
    expect(m.state).toBe("DISCONNECTED");
    expect(m.issues.map((i) => i.code)).toEqual(expect.arrayContaining(["ACCOUNT_NOT_CONNECTED", "DESTINATION_NOT_LINKED"]));
  });

  it("the mapping view counts every state, filters, and lists unused real destinations without demo or creator accounts", async () => {
    const admin = await makeOrg();
    const creator = await prisma.creator.create({ data: { organizationId: admin.orgId, name: "Hidden Creator" } });
    const ready = await makeDestination(admin.orgId, "INSTAGRAM", "map_ready");
    const broken = await makeDestination(admin.orgId, "INSTAGRAM", "map_broken", { status: "DISCONNECTED" });
    const free = await makeDestination(admin.orgId, "TIKTOK", "map_free");
    await makeDestination(admin.orgId, "INSTAGRAM", "map_demo", { demo: true });
    await makeDestination(admin.orgId, "INSTAGRAM", "map_creator", { creatorId: creator.id });
    await mkPage(admin, { username: "map_ready", socialAccountId: ready.social.id });
    await mkPage(admin, { username: "map_broken", socialAccountId: broken.social.id });
    await mkPage(admin, { username: "map_none" });
    type MapView = { items: { page: { username: string }; mapping: Mapping }[]; counts: Record<string, number>; unlinkedDestinations: { id: string; handle: string }[] };
    const all = (await get<MapView>(admin, `${N}/mapping`)).json.data;
    expect(all.counts).toMatchObject({ READY: 1, DISCONNECTED: 1, NO_DESTINATION: 1, REAUTH_REQUIRED: 0, UNAVAILABLE: 0 });
    expect(all.unlinkedDestinations.map((d) => d.handle)).toEqual(["map_free"]);
    expect(all.unlinkedDestinations[0]!.id).toBe(free.social.id);
    expect(all.items.find((i) => i.page.username === "map_broken")!.mapping.state).toBe("DISCONNECTED");
    expect(JSON.stringify(all)).not.toContain("Hidden Creator");
    const only = (await get<MapView>(admin, `${N}/mapping?state=DISCONNECTED`)).json.data;
    expect(only.items.map((i) => i.page.username)).toEqual(["map_broken"]);
    const problems = (await get<Paged<PageItem>>(admin, `${N}/pages?mapping=PROBLEM`)).json.data;
    expect(problems.items.map((p) => p.username)).toEqual(["map_broken"]);
    expect((await get<Paged<PageItem>>(admin, `${N}/pages?mapping=UNLINKED`)).json.data.total).toBe(1);
    expect((await get<Paged<PageItem>>(admin, `${N}/pages?mapping=LINKED`)).json.data.total).toBe(2);
  });

  it("destination candidates: same platform, real, unlinked, not a creator's", async () => {
    const admin = await makeOrg();
    const creator = await prisma.creator.create({ data: { organizationId: admin.orgId, name: "C" } });
    const good = await makeDestination(admin.orgId, "INSTAGRAM", "cand_good");
    await makeDestination(admin.orgId, "TIKTOK", "cand_wrong_platform");
    await makeDestination(admin.orgId, "INSTAGRAM", "cand_demo", { demo: true });
    await makeDestination(admin.orgId, "INSTAGRAM", "cand_creator", { creatorId: creator.id });
    const taken = await makeDestination(admin.orgId, "INSTAGRAM", "cand_taken");
    await mkPage(admin, { username: "holder", socialAccountId: taken.social.id });
    const p = await mkPage(admin, { username: "wants_one" });
    const r = (await get<{ items: { id: string; handle: string }[] }>(admin, `${N}/pages/${p.id}/destination-candidates`)).json.data;
    expect(r.items.map((i) => i.handle)).toEqual(["cand_good"]);
    expect(r.items[0]!.id).toBe(good.social.id);
  });

  it("keeps the Phase 2 Upload-Post mappings intact and shows a profile that is mapped to a different page", async () => {
    const admin = await makeOrg();
    const brand = await mkPage(admin, { name: "Brand level page", username: "brand_level" });
    const dest = await makeDestination(admin.orgId, "INSTAGRAM", "p2_account", { profileMappedPageId: brand.id });
    const p = await mkPage(admin, { username: "p2_account" });
    const r = await put<PageDetail>(admin, `${N}/pages/${p.id}/destination`, { socialAccountId: dest.social.id });
    expect(r.status).toBe(200);
    // flagged, never silently changed
    expect(r.json.data.mapping.profileMappedToOtherPage).toMatchObject({ id: brand.id, name: "Brand level page" });
    const profile = await prisma.uploadPostProfile.findUniqueOrThrow({ where: { id: dest.profile.id } });
    expect(profile.managedPageId).toBe(brand.id);
    const account = await prisma.uploadPostConnectedAccount.findUniqueOrThrow({ where: { id: dest.account.id } });
    expect(account.socialAccountId).toBe(dest.social.id);
    // the brand-level page still lists its profile
    const brandDetail = (await get<PageDetail & { mapping: Mapping & { uploadPostProfiles: { id: string; accountCount: number }[] } }>(admin, `${N}/pages/${brand.id}`)).json.data;
    expect(brandDetail.mapping.uploadPostProfiles.map((x) => x.id)).toEqual([dest.profile.id]);
  });

  it("the Publishing Center reports the directly linked page and filters by it", async () => {
    const admin = await makeOrg();
    const brand = await mkPage(admin, { name: "Brand level page", username: "brand_lvl" });
    const dest = await makeDestination(admin.orgId, "INSTAGRAM", "pc_account", { profileMappedPageId: brand.id });
    const page = await mkPage(admin, { name: "Direct page", username: "pc_account", socialAccountId: dest.social.id });
    const content = await prisma.content.create({ data: { organizationId: admin.orgId, caption: "Hello network", status: "DRAFT" } });
    await prisma.contentAsset.create({ data: { contentId: content.id, type: "VIDEO", url: "https://cdn.example.test/v.mp4", metadata: { width: 1080, height: 1920, durationSec: 30, sizeBytes: 1_000_000 } } });
    const created = await post<{ created: { publication: { id: string; destination: { managedPage: { id: string; name: string } | null } } }[] }>(admin, "/api/publishing/publications", { contentId: content.id, destinations: [{ socialAccountId: dest.social.id }] });
    expect(created.status, created.text).toBe(201);
    expect(created.json.data.created[0]!.publication.destination.managedPage).toMatchObject({ id: page.id, name: "Direct page" });
    const byDirect = await get<Paged<{ id: string }>>(admin, `/api/publishing/publications?managedPageId=${page.id}`);
    const byBrand = await get<Paged<{ id: string }>>(admin, `/api/publishing/publications?managedPageId=${brand.id}`);
    expect(byDirect.json.data.total).toBe(1);
    expect(byBrand.json.data.total).toBe(0); // the direct link wins: the publication is not reported under two pages
    const dests = await get<Paged<{ id: string; managedPage: { id: string } | null }>>(admin, `/api/publishing/destinations?managedPageId=${page.id}`);
    expect(dests.json.data.items.map((d) => d.managedPage?.id)).toEqual([page.id]);
    // and the page detail counts the publication
    expect((await get<PageDetail>(admin, `${N}/pages/${page.id}`)).json.data.publications).toMatchObject({ total: 1, byStatus: { PENDING: 1 } });
  });

  it("page rules reach the Publishing Center: they warn by default and block only when the page says so", async () => {
    const admin = await makeOrg();
    const dest = await makeDestination(admin.orgId, "INSTAGRAM", "rules_page");
    const page = await mkPage(admin, { username: "rules_page", socialAccountId: dest.social.id, profile: { contentPreferences: { maxTextLength: 10 } } });
    const mkContent = async () => {
      const c = await prisma.content.create({ data: { organizationId: admin.orgId, caption: `A caption that is certainly longer than ten characters ${uniq()}`, status: "DRAFT" } });
      await prisma.contentAsset.create({ data: { contentId: c.id, type: "VIDEO", url: "https://cdn.example.test/v.mp4", metadata: { width: 1080, height: 1920, durationSec: 30, sizeBytes: 1_000_000 } } });
      return c;
    };
    type Created = { created: { publication: { id: string }; validation: { ok: boolean; issues: { code: string; severity: string; message: string }[] } }[] };
    const warn = await post<Created>(admin, "/api/publishing/publications", { contentId: (await mkContent()).id, destinations: [{ socialAccountId: dest.social.id }] });
    const wIssue = warn.json.data.created[0]!.validation.issues.find((i) => i.code === "PAGE_RULE_TEXT_TOO_LONG")!;
    expect(wIssue.severity).toBe("WARNING");
    expect(wIssue.message).toContain(page.name);
    expect(warn.json.data.created[0]!.validation.ok).toBe(true);

    await put(admin, `${N}/pages/${page.id}/identity`, { profile: { ruleEnforcement: "BLOCK", contentPreferences: { maxTextLength: 10 } } });
    const blocked = await post<Created>(admin, "/api/publishing/publications", { contentId: (await mkContent()).id, destinations: [{ socialAccountId: dest.social.id }] });
    expect(blocked.json.data.created[0]!.validation.ok).toBe(false);
    expect(blocked.json.data.created[0]!.validation.issues.find((i) => i.code === "PAGE_RULE_TEXT_TOO_LONG")?.severity).toBe("ERROR");
    const submit = await post(admin, `/api/publishing/publications/${blocked.json.data.created[0]!.publication.id}/submit`);
    expect(submit.status).toBe(422);
  });
});

// ================================================================================================================
suite("Page Network - groups and campaigns", () => {
  useServer();

  it("creates a group with pages, edits it, filters by category and platform, archives and restores it", async () => {
    const admin = await makeOrg();
    const moto = await mkCategory(admin, { name: "Moto" });
    const foot = await mkCategory(admin, { name: "Foot" });
    const m1 = await mkPage(admin, { name: "Motivation Page 01", categoryId: moto.id, platform: "INSTAGRAM", username: "m1" });
    const m2 = await mkPage(admin, { name: "Motivation Page 02", categoryId: moto.id, platform: "TIKTOK", username: "m2" });
    const f1 = await mkPage(admin, { name: "Football Page 01", categoryId: foot.id, platform: "INSTAGRAM", username: "f1" });
    const g = await post<GroupDetail>(admin, `${N}/groups`, { name: "MOTIVATION NETWORK", description: "all motivation", pageIds: [m1.id, m2.id], contentPreferences: { visual: { aspectRatio: "9:16" } } });
    expect(g.status, g.text).toBe(201);
    expect(g.json.data.members.map((m) => m.id).sort()).toEqual([m1.id, m2.id].sort());
    expect((await post(admin, `${N}/groups`, { name: "motivation network" })).status).toBe(409);
    const mixed = await mkGroup(admin, { name: "Mixed", pageIds: [m1.id, f1.id] });

    const ids = async (qs: string) => (await get<{ items: { id: string }[] }>(admin, `${N}/groups?${qs}`)).json.data.items.map((x) => x.id).sort();
    expect(await ids(`categoryId=${foot.id}`)).toEqual([mixed.id]);
    expect(await ids(`categoryId=${moto.id}`)).toEqual([g.json.data.id, mixed.id].sort());
    expect(await ids(`platform=TIKTOK`)).toEqual([g.json.data.id]);

    const edited = await patch<GroupDetail>(admin, `${N}/groups/${g.json.data.id}`, { description: "renamed purpose" });
    expect(edited.json.data).toMatchObject({ description: "renamed purpose" });
    expect((await post<GroupDetail>(admin, `${N}/groups/${g.json.data.id}/archive`)).json.data.status).toBe("ARCHIVED");
    expect(await ids(``)).not.toContain(g.json.data.id);
    expect((await post<GroupDetail>(admin, `${N}/groups/${g.json.data.id}/restore`)).json.data.status).toBe("ACTIVE");
    for (const a of ["PAGE_GROUP_CREATED", "PAGE_GROUP_UPDATED", "PAGE_GROUP_ARCHIVED", "PAGE_GROUP_RESTORED"]) expect((await audit(admin.orgId, a)).length, a).toBeGreaterThan(0);
  });

  it("a page can be in several groups; adding twice changes nothing; removing from one keeps the others", async () => {
    const admin = await makeOrg();
    const p = await mkPage(admin);
    const g1 = await mkGroup(admin, { name: "Network One" });
    const g2 = await mkGroup(admin, { name: "Network Two" });
    expect((await post(admin, `${N}/groups/${g1.id}/members`, { pageIds: [p.id] })).status).toBe(200);
    expect((await post(admin, `${N}/groups/${g2.id}/members`, { pageIds: [p.id] })).status).toBe(200);
    expect((await post(admin, `${N}/groups/${g1.id}/members`, { pageIds: [p.id] })).status).toBe(200); // again
    expect(await prisma.pageGroupMember.count({ where: { pageId: p.id } })).toBe(2);
    expect((await audit(admin.orgId, "PAGE_GROUP_MEMBERS_ADDED")).length).toBe(2); // the repeat added nothing
    const detail = (await get<PageDetail>(admin, `${N}/pages/${p.id}`)).json.data;
    expect(detail.groups.map((g) => g.name).sort()).toEqual(["Network One", "Network Two"]);
    expect((await get<Paged<PageItem>>(admin, `${N}/pages?groupId=${g1.id}`)).json.data.total).toBe(1);

    const after = await del<GroupDetail>(admin, `${N}/groups/${g1.id}/members/${p.id}`);
    expect(after.status).toBe(200);
    expect(after.json.data.members).toHaveLength(0);
    expect((await get<PageDetail>(admin, `${N}/pages/${p.id}`)).json.data.groups.map((g) => g.name)).toEqual(["Network Two"]);
    expect((await del(admin, `${N}/groups/${g1.id}/members/${p.id}`)).status).toBe(404);
    expect((await audit(admin.orgId, "PAGE_GROUP_MEMBER_REMOVED")).length).toBe(1);
  });

  it("archived pages and archived groups take no members, foreign pages are 404, and a bad request changes nothing", async () => {
    const admin = await makeOrg();
    const other = await makeOrg();
    const foreign = await mkPage(other, { username: "foreign_page" });
    const good = await mkPage(admin);
    const archived = await mkPage(admin);
    await post(admin, `${N}/pages/${archived.id}/archive`);
    const g = await mkGroup(admin);
    expect((await post(admin, `${N}/groups/${g.id}/members`, { pageIds: [good.id, archived.id] })).status).toBe(409);
    expect((await post(admin, `${N}/groups/${g.id}/members`, { pageIds: [good.id, foreign.id] })).status).toBe(404);
    expect(await prisma.pageGroupMember.count({ where: { groupId: g.id } })).toBe(0);
    await post(admin, `${N}/groups/${g.id}/archive`);
    expect((await post(admin, `${N}/groups/${g.id}/members`, { pageIds: [good.id] })).status).toBe(409);
    expect((await get(other, `${N}/groups/${g.id}`)).status).toBe(404);
  });

  it("group statistics: pages by platform and category, destination health, publication counts", async () => {
    const admin = await makeOrg();
    const cat = await mkCategory(admin, { name: "Stats Cat" });
    const ok = await makeDestination(admin.orgId, "INSTAGRAM", "st_ok");
    const bad = await makeDestination(admin.orgId, "TIKTOK", "st_bad", { status: "DISCONNECTED" });
    const a = await mkPage(admin, { platform: "INSTAGRAM", username: "st_ok", categoryId: cat.id, socialAccountId: ok.social.id });
    const b = await mkPage(admin, { platform: "TIKTOK", username: "st_bad", categoryId: cat.id, socialAccountId: bad.social.id });
    const c = await mkPage(admin, { platform: "INSTAGRAM", username: "st_none" });
    const g = await mkGroup(admin, { pageIds: [a.id, b.id, c.id] });
    const content = await prisma.content.create({ data: { organizationId: admin.orgId, caption: "x", status: "PUBLISHED" } });
    await prisma.contentTarget.create({ data: { contentId: content.id, socialAccountId: ok.social.id, status: "PUBLISHED", publishedAt: new Date() } });
    await prisma.contentTarget.create({ data: { contentId: content.id, socialAccountId: bad.social.id, status: "FAILED" } });
    const stats = (await get<GroupDetail>(admin, `${N}/groups/${g.id}`)).json.data.stats;
    expect(stats.pages).toMatchObject({ total: 3, active: 3 });
    expect(stats.byPlatform).toEqual({ INSTAGRAM: 2, TIKTOK: 1 });
    expect(stats.mapping).toEqual({ ready: 1, problem: 1, unlinked: 1 });
    expect(stats.byCategory.map((x) => [x.name, x.count])).toEqual(expect.arrayContaining([["Stats Cat", 2], ["No category", 1]]));
    expect(stats.publications.byStatus).toMatchObject({ PUBLISHED: 1, FAILED: 1 });
  });

  it("assigns pages and groups to a campaign: the effective pages are the union, listed once with every reason", async () => {
    const admin = await makeOrg();
    const campaign = await prisma.campaign.create({ data: { organizationId: admin.orgId, name: "Summer Release" } });
    const p1 = await mkPage(admin, { name: "P1" });
    const p2 = await mkPage(admin, { name: "P2" });
    const p3 = await mkPage(admin, { name: "P3" });
    const g = await mkGroup(admin, { name: "Net", pageIds: [p2.id, p3.id] });
    type CampPages = { directPages: { id: string }[]; groups: { id: string; pageCount: number }[]; effectivePages: { id: string; via: { kind: string; groupName?: string }[] }[]; byCategory: { name: string; count: number }[] };
    const r = await post<CampPages>(admin, `${N}/campaigns/${campaign.id}/assignments`, { pageIds: [p1.id, p2.id], groupIds: [g.id] });
    expect(r.status, r.text).toBe(200);
    expect(r.json.data.directPages.map((x) => x.id).sort()).toEqual([p1.id, p2.id].sort());
    expect(r.json.data.groups).toEqual([expect.objectContaining({ id: g.id, pageCount: 2 })]);
    const eff = new Map(r.json.data.effectivePages.map((e) => [e.id, e.via.map((v) => (v.kind === "direct" ? "direct" : `group:${v.groupName}`)).sort()]));
    expect([...eff.keys()].sort()).toEqual([p1.id, p2.id, p3.id].sort());
    expect(eff.get(p1.id)).toEqual(["direct"]);
    expect(eff.get(p2.id)).toEqual(["direct", "group:Net"]);
    expect(eff.get(p3.id)).toEqual(["group:Net"]);

    // idempotent
    await post(admin, `${N}/campaigns/${campaign.id}/assignments`, { pageIds: [p1.id], groupIds: [g.id] });
    expect(await prisma.campaignPage.count({ where: { campaignId: campaign.id } })).toBe(2);
    expect(await prisma.campaignPageGroup.count({ where: { campaignId: campaign.id } })).toBe(1);
    expect((await audit(admin.orgId, "CAMPAIGN_PAGES_ASSIGNED")).length).toBe(1);
    expect((await audit(admin.orgId, "CAMPAIGN_PAGE_GROUPS_ASSIGNED")).length).toBe(1);

    // the page detail shows the campaign and why
    const detail = (await get<PageDetail>(admin, `${N}/pages/${p2.id}`)).json.data;
    expect(detail.campaigns).toEqual([expect.objectContaining({ id: campaign.id, via: expect.arrayContaining(["direct", "group: Net"]) })]);
    expect((await get<Paged<PageItem>>(admin, `${N}/pages?campaignId=${campaign.id}`)).json.data.total).toBe(3);

    // an archived group no longer carries its pages into the campaign
    await post(admin, `${N}/groups/${g.id}/archive`);
    const afterArchive = (await get<CampPages>(admin, `${N}/campaigns/${campaign.id}`)).json.data;
    expect(afterArchive.effectivePages.map((e) => e.id).sort()).toEqual([p1.id, p2.id].sort());
    await post(admin, `${N}/groups/${g.id}/restore`);

    // un-assigning
    const noP1 = await del<CampPages>(admin, `${N}/campaigns/${campaign.id}/pages/${p1.id}`);
    expect(noP1.json.data.directPages.map((x) => x.id)).toEqual([p2.id]);
    const noGroup = await del<CampPages>(admin, `${N}/campaigns/${campaign.id}/groups/${g.id}`);
    expect(noGroup.json.data.effectivePages.map((e) => e.id)).toEqual([p2.id]);
    expect((await del(admin, `${N}/campaigns/${campaign.id}/pages/${p1.id}`)).status).toBe(404);
    expect((await audit(admin.orgId, "CAMPAIGN_PAGE_UNASSIGNED")).length).toBe(1);
    expect((await audit(admin.orgId, "CAMPAIGN_PAGE_GROUP_UNASSIGNED")).length).toBe(1);
  });

  it("campaign assignment refuses foreign, unknown and archived ids and assigns nothing when one is wrong", async () => {
    const admin = await makeOrg();
    const other = await makeOrg();
    const campaign = await prisma.campaign.create({ data: { organizationId: admin.orgId, name: "C1" } });
    const foreignCampaign = await prisma.campaign.create({ data: { organizationId: other.orgId, name: "Foreign" } });
    const good = await mkPage(admin);
    const foreign = await mkPage(other, { username: "f_page" });
    const archived = await mkPage(admin);
    await post(admin, `${N}/pages/${archived.id}/archive`);
    expect((await post(admin, `${N}/campaigns/${campaign.id}/assignments`, { pageIds: [good.id, foreign.id] })).status).toBe(404);
    expect((await post(admin, `${N}/campaigns/${campaign.id}/assignments`, { pageIds: [good.id, archived.id] })).status).toBe(409);
    expect((await post(admin, `${N}/campaigns/${campaign.id}/assignments`, { groupIds: ["nope"] })).status).toBe(404);
    expect((await post(admin, `${N}/campaigns/${campaign.id}/assignments`, {})).status).toBe(400);
    expect(await prisma.campaignPage.count({ where: { campaignId: campaign.id } })).toBe(0);
    expect((await post(admin, `${N}/campaigns/${foreignCampaign.id}/assignments`, { pageIds: [good.id] })).status).toBe(404);
    expect((await get(admin, `${N}/campaigns/${foreignCampaign.id}`)).status).toBe(404);
  });

  it("filters campaign content by page category (and by page)", async () => {
    const admin = await makeOrg();
    const campaign = await prisma.campaign.create({ data: { organizationId: admin.orgId, name: "Cross-niche" } });
    const moto = await mkCategory(admin, { name: "Moto2" });
    const foot = await mkCategory(admin, { name: "Foot2" });
    const dMoto = await makeDestination(admin.orgId, "INSTAGRAM", "ct_moto");
    const dFoot = await makeDestination(admin.orgId, "INSTAGRAM", "ct_foot");
    const pMoto = await mkPage(admin, { categoryId: moto.id, username: "ct_moto", socialAccountId: dMoto.social.id });
    const pFoot = await mkPage(admin, { categoryId: foot.id, username: "ct_foot", socialAccountId: dFoot.social.id });
    const cMoto = await prisma.content.create({ data: { organizationId: admin.orgId, campaignId: campaign.id, caption: "moto content", status: "DRAFT" } });
    const cFoot = await prisma.content.create({ data: { organizationId: admin.orgId, campaignId: campaign.id, caption: "foot content", status: "DRAFT" } });
    const cBoth = await prisma.content.create({ data: { organizationId: admin.orgId, campaignId: campaign.id, caption: "both content", status: "DRAFT" } });
    await prisma.content.create({ data: { organizationId: admin.orgId, campaignId: campaign.id, caption: "untargeted", status: "DRAFT" } });
    for (const [c, d] of [[cMoto, dMoto], [cFoot, dFoot], [cBoth, dMoto], [cBoth, dFoot]] as const) {
      await prisma.contentTarget.create({ data: { contentId: c.id, socialAccountId: d.social.id } });
    }
    type CC = { items: { id: string; pages: { id: string; category: { name: string } | null }[] }[]; total: number };
    const ids = async (qs: string) => (await get<CC>(admin, `${N}/campaigns/${campaign.id}/content?${qs}`)).json.data.items.map((i) => i.id).sort();
    expect(await ids(``)).toHaveLength(4);
    expect(await ids(`categoryId=${moto.id}`)).toEqual([cMoto.id, cBoth.id].sort());
    expect(await ids(`categoryId=${foot.id}`)).toEqual([cFoot.id, cBoth.id].sort());
    expect(await ids(`pageId=${pFoot.id}`)).toEqual([cFoot.id, cBoth.id].sort());
    const both = (await get<CC>(admin, `${N}/campaigns/${campaign.id}/content?categoryId=${moto.id}`)).json.data.items.find((i) => i.id === cBoth.id)!;
    expect(both.pages.map((p) => p.id).sort()).toEqual([pMoto.id, pFoot.id].sort());
  });

  it("the overview summarizes the network and points at what needs attention", async () => {
    const admin = await makeOrg();
    const cat = await mkCategory(admin, { name: "Overview Cat" });
    const ok = await makeDestination(admin.orgId, "INSTAGRAM", "ov_ok");
    const bad = await makeDestination(admin.orgId, "INSTAGRAM", "ov_bad", { status: "DISCONNECTED" });
    await makeDestination(admin.orgId, "TIKTOK", "ov_unused");
    await mkPage(admin, { username: "ov_ok", categoryId: cat.id, socialAccountId: ok.social.id });
    await mkPage(admin, { username: "ov_bad", categoryId: cat.id, socialAccountId: bad.social.id });
    await post(admin, "/api/managed-pages", { name: "Unfinished legacy page" });
    await mkGroup(admin, { name: "Ov group" });
    type Overview = { counts: { categories: number; pages: number; groups: number; unlinkedDestinations: number }; mapping: Record<string, number>; attention: { name: string; reasons: string[] }[]; missingStarterCategories: string[]; byPlatform: Record<string, number> };
    const o = (await get<Overview>(admin, `${N}/overview`)).json.data;
    expect(o.counts).toMatchObject({ categories: 1, pages: 3, groups: 1, unlinkedDestinations: 1 });
    expect(o.mapping).toMatchObject({ READY: 1, DISCONNECTED: 1, NO_DESTINATION: 1 });
    expect(o.byPlatform).toMatchObject({ INSTAGRAM: 2, UNSET: 1 });
    // the disconnected page and the unfinished legacy page need attention; the healthy one does not
    expect(o.attention).toHaveLength(2);
    expect(o.attention.map((a) => a.name)).toContain("Unfinished legacy page");
    expect(o.attention.some((a) => a.reasons.some((r) => /Incomplete page profile/.test(r)))).toBe(true);
    expect(o.attention.some((a) => a.reasons.some((r) => /ov_bad|not connected|disconnected/i.test(r)))).toBe(true);
    expect(o.missingStarterCategories).toContain("Motivation");
  });
});

// ================================================================================================================
suite("Page Network - permissions, isolation and audit", () => {
  useServer();

  it("every role can read; only administrators can write", async () => {
    const admin = await makeOrg("ADMIN");
    const editor = await addUser(admin.orgId, "EDITOR");
    const viewer = await addUser(admin.orgId, "VIEWER");
    const owner = await addUser(admin.orgId, "OWNER");
    const cat = await mkCategory(admin);
    const page = await mkPage(admin, { categoryId: cat.id });
    const group = await mkGroup(admin, { pageIds: [page.id] });
    const campaign = await prisma.campaign.create({ data: { organizationId: admin.orgId, name: "Perm" } });

    for (const s of [editor, viewer, owner]) {
      for (const path of ["overview", "mapping", "formats", "categories", `categories/${cat.id}`, "pages", `pages/${page.id}`, `pages/${page.id}/identity`, `pages/${page.id}/destination-candidates`, "groups", `groups/${group.id}`, `campaigns/${campaign.id}`, `campaigns/${campaign.id}/content`]) {
        expect((await get(s, `${N}/${path}`)).status, `${s.userId} GET ${path}`).toBe(200);
      }
    }
    const writes: [string, string, unknown][] = [
      ["POST", "categories", { name: "Nope" }],
      ["POST", "categories/starters", {}],
      ["PATCH", `categories/${cat.id}`, { description: "x" }],
      ["POST", `categories/${cat.id}/archive`, {}],
      ["POST", "pages", { name: "Nope", platform: "INSTAGRAM", username: "nope" }],
      ["PATCH", `pages/${page.id}`, { name: "x" }],
      ["PUT", `pages/${page.id}/identity`, { editorialIdentity: "x" }],
      ["PUT", `pages/${page.id}/destination`, { socialAccountId: null }],
      ["POST", `pages/${page.id}/archive`, {}],
      ["POST", "groups", { name: "Nope" }],
      ["PATCH", `groups/${group.id}`, { description: "x" }],
      ["POST", `groups/${group.id}/members`, { pageIds: [page.id] }],
      ["DELETE", `groups/${group.id}/members/${page.id}`, undefined],
      ["POST", `groups/${group.id}/archive`, {}],
      ["POST", `campaigns/${campaign.id}/assignments`, { pageIds: [page.id] }],
      ["DELETE", `campaigns/${campaign.id}/pages/${page.id}`, undefined],
    ];
    for (const s of [editor, viewer]) {
      for (const [method, path, body] of writes) {
        const r = await http(method, `${N}/${path}`, { cookie: s.cookie, body });
        expect(r.status, `${method} ${path}`).toBe(403);
      }
    }
    // nothing changed
    expect(await prisma.pageCategory.count({ where: { organizationId: admin.orgId } })).toBe(1);
    expect(await prisma.managedPage.count({ where: { organizationId: admin.orgId } })).toBe(1);
    expect((await prisma.managedPage.findUniqueOrThrow({ where: { id: page.id } })).status).toBe("ACTIVE");
    // the owner (above ADMIN) may write
    expect((await post(owner, `${N}/categories`, { name: "Owner made" })).status).toBe(201);
    expect((await post(owner, `${N}/pages`, { name: "Owner page", platform: "YOUTUBE", username: "owner_page" })).status).toBe(201);
  });

  it("requires a session", async () => {
    expect((await http("GET", `${N}/overview`)).status).toBe(401);
    expect((await http("POST", `${N}/pages`, { body: { name: "x", platform: "INSTAGRAM", username: "x" } })).status).toBe(401);
  });

  it("internal notes and provider internals are hidden from viewers, shown to editors and above", async () => {
    const admin = await makeOrg("ADMIN");
    const editor = await addUser(admin.orgId, "EDITOR");
    const viewer = await addUser(admin.orgId, "VIEWER");
    const dest = await makeDestination(admin.orgId, "INSTAGRAM", "vis_acc");
    const page = await mkPage(admin, { username: "vis_acc", internalNotes: "internal only: agency margin 20%", socialAccountId: dest.social.id });
    const asViewer = await get<PageDetail>(viewer, `${N}/pages/${page.id}`);
    const asEditor = await get<PageDetail>(editor, `${N}/pages/${page.id}`);
    expect(asViewer.json.data.internalNotes).toBeNull();
    expect(asViewer.text).not.toContain("agency margin");
    expect(asViewer.json.data.mapping.upload?.profile).toBeNull();
    expect(asViewer.text).not.toContain(dest.profile.username);
    expect(asViewer.json.data.mapping.destination?.handle).toBe("vis_acc"); // the page's own public account is not private
    expect(asEditor.json.data.internalNotes).toBe("internal only: agency margin 20%");
    expect(asEditor.json.data.mapping.upload?.profile?.username).toBe(dest.profile.username);
    const mapViewer = await get(viewer, `${N}/mapping`);
    expect(mapViewer.text).not.toContain(dest.profile.username);
  });

  it("organizations are isolated: another organization's records are 404 and never listed", async () => {
    const a = await makeOrg("ADMIN");
    const b = await makeOrg("ADMIN");
    const cat = await mkCategory(a);
    const page = await mkPage(a);
    const group = await mkGroup(a, { pageIds: [page.id] });
    for (const path of [`categories/${cat.id}`, `pages/${page.id}`, `pages/${page.id}/identity`, `pages/${page.id}/destination-candidates`, `groups/${group.id}`]) {
      expect((await get(b, `${N}/${path}`)).status, path).toBe(404);
    }
    expect((await patch(b, `${N}/pages/${page.id}`, { name: "hijack" })).status).toBe(404);
    expect((await patch(b, `${N}/categories/${cat.id}`, { name: "hijack" })).status).toBe(404);
    expect((await post(b, `${N}/pages/${page.id}/check-text`, { text: "x" })).status).toBe(404);
    expect((await post(b, `${N}/pages`, { name: "mine", platform: "INSTAGRAM", username: "mine", categoryId: cat.id })).status).toBe(404);
    expect((await get<Paged<PageItem>>(b, `${N}/pages`)).json.data.total).toBe(0);
    expect((await get<{ items: Cat[] }>(b, `${N}/categories`)).json.data.items).toHaveLength(0);
    expect((await prisma.managedPage.findUniqueOrThrow({ where: { id: page.id } })).name).toBe(page.name);
  });

  it("no response ever carries a creator's private data, even when the organization has creators", async () => {
    const admin = await makeOrg("ADMIN");
    const creator = await prisma.creator.create({ data: { organizationId: admin.orgId, name: "Very Private Creator", notes: "creator private notes" } });
    await makeDestination(admin.orgId, "INSTAGRAM", "creators_own_account", { creatorId: creator.id });
    const dest = await makeDestination(admin.orgId, "INSTAGRAM", "agency_page_account");
    const page = await mkPage(admin, { username: "agency_page_account", socialAccountId: dest.social.id });
    const group = await mkGroup(admin, { pageIds: [page.id] });
    const campaign = await prisma.campaign.create({ data: { organizationId: admin.orgId, name: "Camp" } });
    await post(admin, `${N}/campaigns/${campaign.id}/assignments`, { pageIds: [page.id], groupIds: [group.id] });
    const texts: string[] = [];
    for (const path of ["overview", "mapping", "pages", `pages/${page.id}`, `pages/${page.id}/destination-candidates`, "groups", `groups/${group.id}`, `campaigns/${campaign.id}`]) {
      texts.push((await get(admin, `${N}/${path}`)).text);
    }
    for (const t of texts) {
      expect(t).not.toContain("Very Private Creator");
      expect(t).not.toContain("creator private notes");
      expect(t).not.toContain("creators_own_account");
    }
  });

  it("every important change is audited with the actor, the target and no secrets", async () => {
    const admin = await makeOrg("ADMIN");
    const dest = await makeDestination(admin.orgId, "INSTAGRAM", "audit_acc");
    const cat = await mkCategory(admin);
    const page = await mkPage(admin, { username: "audit_acc", categoryId: cat.id, internalNotes: "never in the log" });
    await put(admin, `${N}/pages/${page.id}/destination`, { socialAccountId: dest.social.id });
    await put(admin, `${N}/pages/${page.id}/identity`, { editorialIdentity: "x" });
    const group = await mkGroup(admin, { pageIds: [page.id] });
    const campaign = await prisma.campaign.create({ data: { organizationId: admin.orgId, name: "Aud" } });
    await post(admin, `${N}/campaigns/${campaign.id}/assignments`, { pageIds: [page.id], groupIds: [group.id] });
    await post(admin, `${N}/pages/${page.id}/archive`);
    const rows = await prisma.auditLog.findMany({ where: { organizationId: admin.orgId } });
    const actions = new Set(rows.map((r) => r.action));
    for (const a of ["PAGE_CATEGORY_CREATED", "MANAGED_PAGE_CREATED", "MANAGED_PAGE_DESTINATION_LINKED", "MANAGED_PAGE_IDENTITY_UPDATED", "PAGE_GROUP_CREATED", "CAMPAIGN_PAGES_ASSIGNED", "CAMPAIGN_PAGE_GROUPS_ASSIGNED", "MANAGED_PAGE_ARCHIVED"]) {
      expect(actions.has(a), a).toBe(true);
    }
    for (const r of rows.filter((x) => x.action.startsWith("PAGE_") || x.action.startsWith("MANAGED_PAGE_") || x.action.startsWith("CAMPAIGN_PAGE"))) {
      expect(r.userId, r.action).toBe(admin.userId);
      expect(r.targetType, r.action).not.toBeNull();
      expect(JSON.stringify(r.metadataJson ?? {}), r.action).not.toContain("never in the log");
    }
  });

  it("a failed write is not audited and changes nothing", async () => {
    const admin = await makeOrg("ADMIN");
    await mkPage(admin, { username: "dup_user" });
    const before = await prisma.auditLog.count({ where: { organizationId: admin.orgId } });
    expect((await post(admin, `${N}/pages`, { name: "Dup", platform: "INSTAGRAM", username: "dup_user" })).status).toBe(409);
    expect(await prisma.auditLog.count({ where: { organizationId: admin.orgId } })).toBe(before);
    expect(await prisma.managedPage.count({ where: { organizationId: admin.orgId } })).toBe(1);
  });
});
