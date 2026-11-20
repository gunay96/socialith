import { describe, expect, it } from "vitest";
import { prisma } from "@socialith/database";
import { testing } from "@socialith/media-pack";
import { addUser, audit, del, enabled, get, http, makeOrg, patch, post, put, seedAsset, seedNetwork, useServer, type Paged, type Session } from "./studio-harness.js";

/**
 * Text Library (Phase 5B) through the REAL express app against REAL MySQL: categories, manual texts, duplicate
 * detection, approval, bulk actions, collections, usage history and the TXT / CSV / XLSX import.
 */
const suite = enabled ? describe : describe.skip;
const SLUG = "it-text-";
useServer(SLUG);

interface TextDto {
  id: string; text: string; charCount: number; language: string | null; source: string; sourceNote: string | null; sourceRow: number | null; importBatchId: string | null; author: string | null;
  rights: { status: string; notes: string | null }; approval: { status: string; reviewNote: string | null; approvedAt: string | null };
  categories: { id: string; name: string }[]; campaigns: { id: string }[]; pageCategories: { id: string }[]; pages: { id: string }[]; pageGroups: { id: string }[]; collections: { id: string; name: string }[];
  appliesToAllPages: boolean; usageCount: number;
}
interface CategoryDto { id: string; name: string; slug: string; status: string; textCount: number }
type Err = { code?: string; existingId?: string; existingStatus?: string };

const org = (role: "ADMIN" | "EDITOR" | "VIEWER" | "OWNER" = "ADMIN") => makeOrg(SLUG, role);
/** Adds a user with another role to the same organization. */
const colleague = (s: Session, role: "ADMIN" | "EDITOR" | "VIEWER") => addUser(s.orgId, role, "it-text");

async function createText(s: Session, text: string, extra: Record<string, unknown> = {}) {
  return post<TextDto>(s, "/api/text-library/texts", { text, ...extra });
}
async function must(s: Session, text: string, extra: Record<string, unknown> = {}) {
  const r = await createText(s, text, extra);
  expect(r.status, r.text).toBe(201);
  return r.json.data;
}

suite("Text categories", () => {
  it("adds the six starter categories once (idempotent), and an administrator can add custom ones", async () => {
    const admin = await org();
    const first = await post<{ created: string[]; items: CategoryDto[] }>(admin, "/api/text-library/categories/starters");
    expect(first.status).toBe(201);
    expect(first.json.data.created).toEqual(["Motivation", "Football", "Humor / Memes", "Relationships", "Lifestyle", "Artist campaigns"]);
    const again = await post<{ created: string[] }>(admin, "/api/text-library/categories/starters");
    expect(again.json.data.created).toEqual([]);

    const custom = await post<CategoryDto>(admin, "/api/text-library/categories", { name: "Ramadan", description: "Seasonal" });
    expect(custom.status).toBe(201);
    expect(custom.json.data.slug).toBe("ramadan");
    const list = await get<{ items: CategoryDto[] }>(admin, "/api/text-library/categories");
    expect(list.json.data.items.map((c) => c.name)).toContain("Ramadan");
    expect(list.json.data.items).toHaveLength(7);
    expect((await audit(admin.orgId, "TEXT_CATEGORY_STARTERS_ADDED")).length).toBe(2);
    expect((await audit(admin.orgId, "TEXT_CATEGORY_CREATED")).length).toBe(1);
  });

  it("refuses a duplicate name, finds a free slug for a name that folds the same, and archives and restores", async () => {
    const admin = await org();
    await post(admin, "/api/text-library/categories", { name: "Gül" });
    expect((await post(admin, "/api/text-library/categories", { name: "Gül" })).status).toBe(409);
    // the database collation treats an accent as the same letter, so "Gul" is the same name as "Gül"
    expect((await post(admin, "/api/text-library/categories", { name: "Gul" })).status).toBe(409);
    // different names that fold to the same short name get a free one
    await post(admin, "/api/text-library/categories", { name: "Rock & Roll" });
    const second = await post<CategoryDto>(admin, "/api/text-library/categories", { name: "Rock - Roll" });
    expect(second.status).toBe(201);
    expect(second.json.data.slug).toBe("rock-roll-2");
    const arch = await post<CategoryDto>(admin, `/api/text-library/categories/${second.json.data.id}/archive`);
    expect(arch.json.data.status).toBe("ARCHIVED");
    expect((await get<{ items: CategoryDto[] }>(admin, "/api/text-library/categories")).json.data.items.map((c) => c.name)).toEqual(["Gül", "Rock & Roll"]);
    expect((await get<{ items: CategoryDto[] }>(admin, "/api/text-library/categories?status=ALL")).json.data.items).toHaveLength(3);
    expect((await post<CategoryDto>(admin, `/api/text-library/categories/${second.json.data.id}/restore`)).json.data.status).toBe("ACTIVE");
  });

  it("only administrators manage categories; everyone can read them; they are isolated per organization", async () => {
    const admin = await org();
    const editor = await colleague(admin, "EDITOR");
    const viewer = await colleague(admin, "VIEWER");
    expect((await post(editor, "/api/text-library/categories", { name: "Nope" })).status).toBe(403);
    expect((await post(editor, "/api/text-library/categories/starters")).status).toBe(403);
    await post(admin, "/api/text-library/categories", { name: "Mine" });
    expect((await get<{ items: CategoryDto[] }>(viewer, "/api/text-library/categories")).json.data.items).toHaveLength(1);
    const stranger = await org();
    expect((await get<{ items: CategoryDto[] }>(stranger, "/api/text-library/categories")).json.data.items).toHaveLength(0);
    const id = (await get<{ items: CategoryDto[] }>(admin, "/api/text-library/categories")).json.data.items[0]!.id;
    expect((await patch(stranger, `/api/text-library/categories/${id}`, { name: "Hijack" })).status).toBe(404);
  });
});

suite("Texts: manual creation and duplicate detection", () => {
  it("creates a PENDING text, cleaned of control characters, with its categories and applicability", async () => {
    const admin = await org();
    const net = await seedNetwork(admin.orgId);
    const cats = (await post<{ items: CategoryDto[] }>(admin, "/api/text-library/categories/starters")).json.data.items;
    const motivation = cats.find((c) => c.name === "Motivation")!;
    const lifestyle = cats.find((c) => c.name === "Lifestyle")!;
    const t = await must(admin, "  Never give up\u0000.  \r\n\r\n\r\n\r\nKeep going.  ", { language: "en", author: "Me", sourceNote: "my notebook", categoryIds: [motivation.id, lifestyle.id], campaignIds: [net.campaign.id], pageCategoryIds: [net.category.id], pageGroupIds: [net.group.id], pageIds: [net.page.id] });
    expect(t.text).toBe("Never give up.\n\nKeep going.");
    expect(t.approval.status).toBe("PENDING");
    expect(t.source).toBe("MANUAL");
    expect(t.rights.status).toBe("UNVERIFIED");
    expect(t.categories.map((c) => c.name).sort()).toEqual(["Lifestyle", "Motivation"]); // a text may belong to several categories when assigned
    expect(t.campaigns).toHaveLength(1);
    expect(t.appliesToAllPages).toBe(false);
    expect((await audit(admin.orgId, "TEXT_CREATED")).length).toBe(1);
  });

  it("recognises the same text with different case, spacing, punctuation and the Turkish i, but not different words", async () => {
    const s = await org();
    const first = await must(s, "KAPI açık, gel!");
    for (const variant of ["kapı  AÇIK gel", "Kapi açik, gel.", "  “Kapı açık, gel”  "]) {
      const r = await createText(s, variant);
      expect(r.status, variant).toBe(409);
      expect((r.json.error?.details as Err).code).toBe("DUPLICATE_TEXT");
      expect((r.json.error?.details as Err).existingId).toBe(first.id);
    }
    expect((await createText(s, "Su içmeyi unutma")).status).toBe(201);
    expect((await createText(s, "Şu içmeyi unutma")).status).toBe(201); // su and şu are different words
  });

  it("points at an archived duplicate instead of adding it again", async () => {
    const s = await org();
    const t = await must(s, "Archive me");
    await post(s, `/api/text-library/texts/${t.id}/archive`);
    const r = await createText(s, "archive me");
    expect(r.status).toBe(409);
    expect(r.json.error?.message).toContain("archived");
    expect((r.json.error?.details as Err).existingStatus).toBe("ARCHIVED");
  });

  it("two people adding the same text at the same moment: one wins, the other gets the duplicate answer", async () => {
    const s = await org();
    const results = await Promise.all(Array.from({ length: 6 }, () => createText(s, "A race for the same words")));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
    expect(await prisma.textEntry.count({ where: { organizationId: s.orgId } })).toBe(1);
  });

  it("rejects empty, too long and badly shaped input, and foreign references", async () => {
    const s = await org();
    expect((await createText(s, "   \u200B  ")).status).toBe(400);
    expect((await createText(s, "x".repeat(2001))).status).toBe(400);
    expect((await createText(s, "ok", { language: "not a language!" })).status).toBe(400);
    expect((await createText(s, "ok", { categoryIds: ["nope"] })).status).toBe(404);
    const stranger = await org();
    const foreign = await seedNetwork(stranger.orgId);
    expect((await createText(s, "uses a foreign page", { pageIds: [foreign.page.id] })).status).toBe(404);
    expect((await createText(s, "uses a foreign campaign", { campaignIds: [foreign.campaign.id] })).status).toBe(404);
  });

  it("an editor can add texts but not approve them on creation; a viewer cannot add", async () => {
    const admin = await org();
    const editor = await colleague(admin, "EDITOR");
    const viewer = await colleague(admin, "VIEWER");
    expect((await createText(editor, "From an editor")).status).toBe(201);
    expect((await createText(editor, "Approve me now", { approveNow: true })).status).toBe(403);
    expect((await createText(viewer, "From a viewer")).status).toBe(403);
    const approved = await must(admin, "Admin approves on creation", { approveNow: true });
    expect(approved.approval.status).toBe("APPROVED");
  });
});

suite("Texts: editing, approval and rights", () => {
  it("editing the words of an approved text sends it back to review; other fields keep the approval", async () => {
    const admin = await org();
    const t = await must(admin, "Original words", { approveNow: true });
    const meta = await patch<TextDto>(admin, `/api/text-library/texts/${t.id}`, { language: "en", author: "Someone", notes: "n" });
    expect(meta.json.data.approval.status).toBe("APPROVED");
    expect(meta.json.data.language).toBe("en");
    const words = await patch<TextDto>(admin, `/api/text-library/texts/${t.id}`, { text: "Changed words" });
    expect(words.json.data.approval.status).toBe("PENDING");
    expect(words.json.data.approval.approvedAt).toBeNull();
    const logs = await audit(admin.orgId, "TEXT_UPDATED");
    expect(logs.some((l) => (l.metadataJson as { approvalReset?: boolean })?.approvalReset === true)).toBe(true);
  });

  it("editing into another existing text is refused, and an archived text cannot be edited", async () => {
    const admin = await org();
    await must(admin, "First text");
    const second = await must(admin, "Second text");
    const r = await patch(admin, `/api/text-library/texts/${second.id}`, { text: "first TEXT!" });
    expect(r.status).toBe(409);
    await post(admin, `/api/text-library/texts/${second.id}/archive`);
    expect((await patch(admin, `/api/text-library/texts/${second.id}`, { notes: "x" })).status).toBe(409);
  });

  it("only administrators approve and reject; rejection needs a reason; the decision is audited", async () => {
    const admin = await org();
    const editor = await colleague(admin, "EDITOR");
    const t = await must(editor, "Needs a decision");
    expect((await post(editor, `/api/text-library/texts/${t.id}/approve`)).status).toBe(403);
    expect((await post(admin, `/api/text-library/texts/${t.id}/reject`, {})).status).toBe(400);
    const rejected = await post<TextDto>(admin, `/api/text-library/texts/${t.id}/reject`, { note: "Too generic" });
    expect(rejected.json.data.approval).toMatchObject({ status: "REJECTED", reviewNote: "Too generic" });
    const approved = await post<TextDto>(admin, `/api/text-library/texts/${t.id}/approve`, { note: "Fine after all" });
    expect(approved.json.data.approval.status).toBe("APPROVED");
    expect((await audit(admin.orgId, "TEXT_REJECTED")).length).toBe(1);
    const logs = await audit(admin.orgId, "TEXT_APPROVED");
    expect(logs).toHaveLength(1);
    expect(logs[0]!.userId).toBe(admin.userId);
  });

  it("archive hides a text from the default list; restore returns an approved text as approved and others as pending", async () => {
    const admin = await org();
    const approved = await must(admin, "Approved then archived", { approveNow: true });
    const pending = await must(admin, "Pending then archived");
    for (const t of [approved, pending]) await post(admin, `/api/text-library/texts/${t.id}/archive`);
    expect((await get<Paged<TextDto>>(admin, "/api/text-library/texts")).json.data.total).toBe(0);
    expect((await get<Paged<TextDto>>(admin, "/api/text-library/texts?status=ARCHIVED")).json.data.total).toBe(2);
    expect((await post<TextDto>(admin, `/api/text-library/texts/${approved.id}/restore`)).json.data.approval.status).toBe("APPROVED");
    expect((await post<TextDto>(admin, `/api/text-library/texts/${pending.id}/restore`)).json.data.approval.status).toBe("PENDING");
  });

  it("a text marked 'do not use' cannot be approved, and marking an approved text that way sends it back to review", async () => {
    const admin = await org();
    const t = await must(admin, "Rights matter", { approveNow: true });
    const r = await put<TextDto>(admin, `/api/text-library/texts/${t.id}/rights`, { status: "RESTRICTED", notes: "Licence expired" });
    expect(r.json.data.rights).toMatchObject({ status: "RESTRICTED", notes: "Licence expired" });
    expect(r.json.data.approval.status).toBe("PENDING");
    expect((await post(admin, `/api/text-library/texts/${t.id}/approve`)).status).toBe(409);
    await put(admin, `/api/text-library/texts/${t.id}/rights`, { status: "CONFIRMED", notes: "Own text" });
    expect((await post(admin, `/api/text-library/texts/${t.id}/approve`)).status).toBe(200);
    const editor = await colleague(admin, "EDITOR");
    expect((await put(editor, `/api/text-library/texts/${t.id}/rights`, { status: "CONFIRMED" })).status).toBe(403);
    expect((await audit(admin.orgId, "TEXT_RIGHTS_CHANGED")).length).toBe(2);
  });

  it("other organizations cannot read or change a text", async () => {
    const admin = await org();
    const t = await must(admin, "Private words");
    const stranger = await org();
    expect((await get(stranger, `/api/text-library/texts/${t.id}`)).status).toBe(404);
    expect((await post(stranger, `/api/text-library/texts/${t.id}/approve`)).status).toBe(404);
    expect((await get<Paged<TextDto>>(stranger, "/api/text-library/texts")).json.data.total).toBe(0);
  });
});

suite("Texts: assignment, search and filters", () => {
  it("assigns categories, campaigns, page categories, pages and groups, and filters by each", async () => {
    const admin = await org();
    const net = await seedNetwork(admin.orgId);
    const cats = (await post<{ items: CategoryDto[] }>(admin, "/api/text-library/categories/starters")).json.data.items;
    const football = cats.find((c) => c.name === "Football")!;
    const humor = cats.find((c) => c.name === "Humor / Memes")!;
    const a = await must(admin, "Goal of the season");
    const b = await must(admin, "Funny football meme");
    const c = await must(admin, "No category text");
    await put(admin, `/api/text-library/texts/${a.id}/categories`, { categoryIds: [football.id] });
    const two = await put<TextDto>(admin, `/api/text-library/texts/${b.id}/categories`, { categoryIds: [football.id, humor.id] });
    expect(two.json.data.categories).toHaveLength(2);
    await put(admin, `/api/text-library/texts/${a.id}/campaigns`, { campaignIds: [net.campaign.id] });
    await put(admin, `/api/text-library/texts/${a.id}/page-categories`, { pageCategoryIds: [net.category.id] });
    await put(admin, `/api/text-library/texts/${b.id}/pages`, { pageIds: [net.page.id] });
    await put(admin, `/api/text-library/texts/${b.id}/page-groups`, { pageGroupIds: [net.group.id] });

    const ids = async (q: string) => (await get<Paged<TextDto>>(admin, `/api/text-library/texts?${q}`)).json.data.items.map((t) => t.id).sort();
    expect(await ids(`categoryId=${football.id}`)).toEqual([a.id, b.id].sort());
    expect(await ids(`categoryId=${humor.id}`)).toEqual([b.id]);
    expect(await ids("uncategorized=true")).toEqual([c.id]);
    expect(await ids(`campaignId=${net.campaign.id}`)).toEqual([a.id]);
    expect(await ids(`pageCategoryId=${net.category.id}`)).toEqual([a.id]);
    expect(await ids(`pageId=${net.page.id}`)).toEqual([b.id]);
    expect(await ids(`pageGroupId=${net.group.id}`)).toEqual([b.id]);
    // "may be used for this page": limited to the page (or its group / category) or limited to nothing
    expect(await ids(`forPageId=${net.page.id}`)).toEqual([a.id, b.id, c.id].sort());
    expect(await ids(`forPageId=${net.other.id}`)).toEqual([a.id, c.id].sort()); // b is limited to the other page and its group
    expect((await get(admin, "/api/text-library/texts?forPageId=nope")).status).toBe(404);
    // replacing a set
    const cleared = await put<TextDto>(admin, `/api/text-library/texts/${b.id}/categories`, { categoryIds: [] });
    expect(cleared.json.data.categories).toHaveLength(0);
    expect((await audit(admin.orgId, "TEXT_ASSIGNMENT_CHANGED")).length).toBeGreaterThanOrEqual(6);
  });

  it("refuses assignments to things that belong to another organization or are archived", async () => {
    const admin = await org();
    const stranger = await org();
    const foreign = await seedNetwork(stranger.orgId);
    const t = await must(admin, "Assign carefully");
    expect((await put(admin, `/api/text-library/texts/${t.id}/pages`, { pageIds: [foreign.page.id] })).status).toBe(404);
    const mine = await seedNetwork(admin.orgId);
    await prisma.pageGroup.update({ where: { id: mine.group.id }, data: { status: "ARCHIVED" } });
    expect((await put(admin, `/api/text-library/texts/${t.id}/page-groups`, { pageGroupIds: [mine.group.id] })).status).toBe(404);
  });

  it("searches without Turkish letters, by author and by source; filters by status, language, rights and use; sorts and pages", async () => {
    const admin = await org();
    const a = await must(admin, "Güzel bir gün başlıyor", { language: "tr", author: "Ayşe" });
    await must(admin, "A beautiful day begins", { language: "en", sourceNote: "notebook 3" });
    const c = await must(admin, "Çok çalış, az konuş", { language: "tr", approveNow: true });
    await put(admin, `/api/text-library/texts/${c.id}/rights`, { status: "CONFIRMED" });
    await post(admin, `/api/text-library/texts/${c.id}/usages`, { note: "posted" });
    const search = async (q: string) => (await get<Paged<TextDto>>(admin, `/api/text-library/texts?${q}`)).json.data;
    expect((await search("q=guzel")).items.map((t) => t.id)).toEqual([a.id]);
    expect((await search("q=GÜZEL")).items.map((t) => t.id)).toEqual([a.id]);
    expect((await search("q=cok%20calis")).items.map((t) => t.id)).toEqual([c.id]);
    expect((await search("q=Ayşe")).total).toBe(1);
    expect((await search("q=notebook")).total).toBe(1);
    expect((await search("language=tr")).total).toBe(2);
    expect((await search("status=APPROVED")).total).toBe(1);
    expect((await search("status=PENDING")).total).toBe(2);
    expect((await search("rights=CONFIRMED")).total).toBe(1);
    expect((await search("used=true")).items.map((t) => t.id)).toEqual([c.id]);
    expect((await search("used=false")).total).toBe(2);
    expect((await search("sort=mostUsed")).items[0]!.id).toBe(c.id);
    const paged = await search("pageSize=2&page=2&sort=oldest");
    expect(paged.items).toHaveLength(1);
    expect(paged.total).toBe(3);
    const summary = await get<{ status: Record<string, number>; active: number; approvedUnused: number; uncategorized: number }>(admin, "/api/text-library/summary");
    expect(summary.json.data).toMatchObject({ status: { PENDING: 2, APPROVED: 1 }, active: 3, approvedUnused: 0, uncategorized: 3 });
  });
});

suite("Texts: bulk actions", () => {
  it("categorizes and assigns many texts at once (add, remove, set), and sets the language", async () => {
    const admin = await org();
    const net = await seedNetwork(admin.orgId);
    const cats = (await post<{ items: CategoryDto[] }>(admin, "/api/text-library/categories/starters")).json.data.items;
    const [m, f] = [cats.find((c) => c.name === "Motivation")!, cats.find((c) => c.name === "Football")!];
    const texts = [await must(admin, "Bulk one"), await must(admin, "Bulk two"), await must(admin, "Bulk three")];
    const ids = texts.map((t) => t.id);
    expect((await post(admin, "/api/text-library/texts/bulk", { action: "categories", ids, mode: "add", categoryIds: [m.id] })).status).toBe(200);
    await post(admin, "/api/text-library/texts/bulk", { action: "categories", ids: ids.slice(0, 2), mode: "add", categoryIds: [f.id] });
    const category = async (id: string) => (await get<Paged<TextDto>>(admin, `/api/text-library/texts?categoryId=${id}`)).json.data.total;
    expect(await category(m.id)).toBe(3);
    expect(await category(f.id)).toBe(2);
    await post(admin, "/api/text-library/texts/bulk", { action: "categories", ids, mode: "remove", categoryIds: [m.id] });
    expect(await category(m.id)).toBe(0);
    await post(admin, "/api/text-library/texts/bulk", { action: "categories", ids, mode: "set", categoryIds: [m.id] });
    expect(await category(m.id)).toBe(3);
    expect(await category(f.id)).toBe(0);
    await post(admin, "/api/text-library/texts/bulk", { action: "pageCategories", ids, mode: "add", pageCategoryIds: [net.category.id] });
    await post(admin, "/api/text-library/texts/bulk", { action: "campaigns", ids, mode: "add", campaignIds: [net.campaign.id] });
    expect((await get<Paged<TextDto>>(admin, `/api/text-library/texts?campaignId=${net.campaign.id}`)).json.data.total).toBe(3);
    const lang = await post<{ updated: number }>(admin, "/api/text-library/texts/bulk", { action: "language", ids, language: "tr" });
    expect(lang.json.data.updated).toBe(3);
    expect((await get<Paged<TextDto>>(admin, "/api/text-library/texts?language=tr")).json.data.total).toBe(3);
    expect((await audit(admin.orgId, "TEXT_BULK_UPDATED")).length).toBeGreaterThanOrEqual(6);
  });

  it("bulk approve skips archived and 'do not use' texts and says why; archive and restore work in bulk", async () => {
    const admin = await org();
    const a = await must(admin, "Bulk approve a");
    const b = await must(admin, "Bulk approve b");
    const c = await must(admin, "Bulk approve c");
    const d = await must(admin, "Bulk approve d");
    await put(admin, `/api/text-library/texts/${b.id}/rights`, { status: "RESTRICTED" });
    await post(admin, `/api/text-library/texts/${c.id}/archive`);
    const r = await post<{ updated: number; skipped: { id: string; reason: string }[] }>(admin, "/api/text-library/texts/bulk", { action: "approve", ids: [a.id, b.id, c.id, d.id] });
    expect(r.json.data.updated).toBe(2);
    expect(r.json.data.skipped.map((s) => [s.id, s.reason]).sort()).toEqual([[b.id, "usage rights say do not use"], [c.id, "archived"]].sort());
    expect((await get<Paged<TextDto>>(admin, "/api/text-library/texts?status=APPROVED")).json.data.total).toBe(2);
    const archived = await post<{ updated: number }>(admin, "/api/text-library/texts/bulk", { action: "archive", ids: [a.id, d.id] });
    expect(archived.json.data.updated).toBe(2);
    const restored = await post<{ updated: number }>(admin, "/api/text-library/texts/bulk", { action: "restore", ids: [a.id, d.id, c.id] });
    expect(restored.json.data.updated).toBe(3);
    expect((await get<TextDto>(admin, `/api/text-library/texts/${a.id}`)).json.data.approval.status).toBe("APPROVED");
    expect((await get<TextDto>(admin, `/api/text-library/texts/${c.id}`)).json.data.approval.status).toBe("PENDING");
  });

  it("editors can categorize but not approve, reject, archive or change rights in bulk; a foreign id changes nothing", async () => {
    const admin = await org();
    const editor = await colleague(admin, "EDITOR");
    const a = await must(admin, "Guarded a");
    const b = await must(admin, "Guarded b");
    for (const body of [{ action: "approve", ids: [a.id] }, { action: "reject", ids: [a.id], note: "no" }, { action: "archive", ids: [a.id] }, { action: "restore", ids: [a.id] }, { action: "rights", ids: [a.id], status: "CONFIRMED" }]) {
      expect((await post(editor, "/api/text-library/texts/bulk", body)).status, body.action).toBe(403);
    }
    expect((await post(editor, "/api/text-library/texts/bulk", { action: "language", ids: [a.id], language: "en" })).status).toBe(200);
    const stranger = await org();
    const foreign = await must(stranger, "Someone else's text");
    const mixed = await post(admin, "/api/text-library/texts/bulk", { action: "language", ids: [a.id, b.id, foreign.id], language: "de" });
    expect(mixed.status).toBe(404);
    expect((await get<TextDto>(admin, `/api/text-library/texts/${b.id}`)).json.data.language).toBeNull();
  });
});

suite("Collections", () => {
  it("an administrator creates a collection, adds and removes texts, and filters by it", async () => {
    const admin = await org();
    const texts = [await must(admin, "Collected one"), await must(admin, "Collected two"), await must(admin, "Not collected")];
    const col = await post<{ id: string; name: string; itemCount: number }>(admin, "/api/text-library/collections", { name: "Summer 2027", description: "Seasonal picks" });
    expect(col.status).toBe(201);
    expect((await post(admin, "/api/text-library/collections", { name: "Summer 2027" })).status).toBe(409);
    const added = await post<{ itemCount: number }>(admin, `/api/text-library/collections/${col.json.data.id}/texts`, { textIds: [texts[0]!.id, texts[1]!.id] });
    expect(added.json.data.itemCount).toBe(2);
    const inCollection = await get<Paged<TextDto>>(admin, `/api/text-library/texts?collectionId=${col.json.data.id}`);
    expect(inCollection.json.data.items.map((t) => t.id).sort()).toEqual([texts[0]!.id, texts[1]!.id].sort());
    expect(inCollection.json.data.items[0]!.collections.map((c) => c.name)).toEqual(["Summer 2027"]);
    const removed = await del<{ itemCount: number }>(admin, `/api/text-library/collections/${col.json.data.id}/texts`, { textIds: [texts[1]!.id] });
    expect(removed.json.data.itemCount).toBe(1);
    const renamed = await patch<{ name: string }>(admin, `/api/text-library/collections/${col.json.data.id}`, { name: "Summer picks" });
    expect(renamed.json.data.name).toBe("Summer picks");
    await post(admin, `/api/text-library/collections/${col.json.data.id}/archive`);
    expect((await get<{ items: unknown[] }>(admin, "/api/text-library/collections")).json.data.items).toHaveLength(0);
    expect((await post(admin, `/api/text-library/collections/${col.json.data.id}/texts`, { textIds: [texts[2]!.id] })).status).toBe(409); // archived
    expect((await audit(admin.orgId, "TEXT_COLLECTION_ITEMS_CHANGED")).length).toBe(2);
  });

  it("editors cannot organize collections; other organizations cannot see them", async () => {
    const admin = await org();
    const editor = await colleague(admin, "EDITOR");
    expect((await post(editor, "/api/text-library/collections", { name: "No" })).status).toBe(403);
    const col = await post<{ id: string }>(admin, "/api/text-library/collections", { name: "Mine" });
    const stranger = await org();
    expect((await patch(stranger, `/api/text-library/collections/${col.json.data.id}`, { name: "x" })).status).toBe(404);
    expect((await get<{ items: unknown[] }>(stranger, "/api/text-library/collections")).json.data.items).toHaveLength(0);
  });
});

suite("Usage history", () => {
  it("records where an approved text was used, with traceable references, and lists it newest first", async () => {
    const admin = await org();
    const net = await seedNetwork(admin.orgId);
    const asset = await seedAsset(admin.orgId, { name: "sunset.png" });
    const recipe = await prisma.contentRecipe.create({ data: { organizationId: admin.orgId, name: "R", config: {} } });
    const content = await prisma.content.create({ data: { organizationId: admin.orgId, caption: "x" } });
    const t = await must(admin, "Used text", { approveNow: true });

    const first = await post<{ usageCount: number }>(admin, `/api/text-library/texts/${t.id}/usages`, { note: "posted manually", pageId: net.page.id, campaignId: net.campaign.id, mediaAssetId: asset.id, recipeId: recipe.id, usedAt: "2026-01-01T10:00:00Z" });
    expect(first.status).toBe(201);
    const second = await post<{ usageCount: number }>(admin, `/api/text-library/texts/${t.id}/usages`, { kind: "PUBLICATION", contentId: content.id, pageId: net.page.id });
    expect(second.json.data.usageCount).toBe(2);
    const list = await get<Paged<{ kind: string; note: string | null; page: { id: string; name: string } | null; recipe: { name: string } | null; mediaAsset: { name: string } | null; contentId: string | null }>>(admin, `/api/text-library/texts/${t.id}/usages`);
    expect(list.json.data.items.map((u) => u.kind)).toEqual(["PUBLICATION", "MANUAL"]);
    expect(list.json.data.items[1]).toMatchObject({ note: "posted manually", page: { id: net.page.id }, recipe: { name: "R" }, mediaAsset: { name: "sunset.png" } });
    const detail = await get<TextDto & { lastUsedAt: string | null; recentUsages: unknown[] }>(admin, `/api/text-library/texts/${t.id}`);
    expect(detail.json.data.usageCount).toBe(2);
    expect(detail.json.data.recentUsages).toHaveLength(2);
    expect(detail.json.data.lastUsedAt).not.toBeNull();
    expect((await audit(admin.orgId, "TEXT_USAGE_RECORDED")).length).toBe(2);
  });

  it("only approved texts can be recorded as used; references must be the organization's; a publication needs its content", async () => {
    const admin = await org();
    const pending = await must(admin, "Not approved yet");
    expect((await post(admin, `/api/text-library/texts/${pending.id}/usages`, {})).status).toBe(409);
    const t = await must(admin, "Approved text", { approveNow: true });
    expect((await post(admin, `/api/text-library/texts/${t.id}/usages`, { kind: "PUBLICATION" })).status).toBe(400);
    const stranger = await org();
    const foreign = await seedNetwork(stranger.orgId);
    expect((await post(admin, `/api/text-library/texts/${t.id}/usages`, { pageId: foreign.page.id })).status).toBe(404);
    expect((await post(admin, `/api/text-library/texts/${t.id}/usages`, { contentId: "nope" })).status).toBe(404);
    const viewer = await colleague(admin, "VIEWER");
    expect((await post(viewer, `/api/text-library/texts/${t.id}/usages`, {})).status).toBe(403);
    expect((await get(viewer, `/api/text-library/texts/${t.id}/usages`)).status).toBe(200);
  });

  it("usage survives when the page it refers to is later removed (the link is cleared, the record stays)", async () => {
    const admin = await org();
    const net = await seedNetwork(admin.orgId);
    const t = await must(admin, "History stays", { approveNow: true });
    await post(admin, `/api/text-library/texts/${t.id}/usages`, { pageId: net.other.id });
    await prisma.managedPage.delete({ where: { id: net.other.id } });
    const list = await get<Paged<{ page: unknown }>>(admin, `/api/text-library/texts/${t.id}/usages`);
    expect(list.json.data.total).toBe(1);
    expect(list.json.data.items[0]!.page).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------------ import

interface ImportReport {
  dryRun: boolean;
  file: { format: string; encoding: string | null; delimiter: string | null; split: string | null; sheetName: string | null; header: string[] | null };
  totals: { rows: number; new: number; duplicatesInLibrary: number; duplicatesInFile: number; invalid: number; withWarnings: number };
  unknownCategories: string[];
  imported?: number;
  batchId?: string;
  createdCategories?: string[];
  problems: { row: number; status: string; reason?: string; warnings: string[] }[];
  sample: { row: number; status: string; text: string; categories: string[]; language: string | null }[];
}

async function importFile(s: Session, name: string, data: Buffer | string, options: Record<string, unknown> = {}, mime = "application/octet-stream") {
  const form = new FormData();
  form.append("options", JSON.stringify(options));
  form.append("file", new Blob([typeof data === "string" ? Buffer.from(data, "utf8") : data], { type: mime }), name);
  return http<ImportReport>("POST", "/api/text-library/imports", { cookie: s.cookie, form });
}
const count = (s: Session) => prisma.textEntry.count({ where: { organizationId: s.orgId } });

suite("Import: TXT, CSV and XLSX", () => {
  it("TXT: one text per line; a dry run reports and changes nothing; the real run imports PENDING texts with their source", async () => {
    const admin = await org();
    await must(admin, "Already here");
    const file = "Never give up\nAlready here!\n\nStay hungry\nstay HUNGRY\n   \nKeep going\n";
    const dry = await importFile(admin, "quotes.txt", file, { dryRun: true, language: "en", split: "LINE" }, "text/plain");
    expect(dry.status, dry.text).toBe(200);
    expect(dry.json.data.dryRun).toBe(true);
    expect(dry.json.data.file).toMatchObject({ format: "TXT", split: "LINE", encoding: "utf-8" });
    expect(dry.json.data.totals).toMatchObject({ rows: 5, new: 3, duplicatesInLibrary: 1, duplicatesInFile: 1, invalid: 0 });
    expect(dry.json.data.problems.map((p) => [p.row, p.status])).toEqual([[2, "DUPLICATE_LIBRARY"], [5, "DUPLICATE_FILE"]]);
    expect(await count(admin)).toBe(1);

    const real = await importFile(admin, "quotes.txt", file, { dryRun: false, language: "en", sourceNote: "my notebook", split: "LINE" }, "text/plain");
    expect(real.status, real.text).toBe(201);
    expect(real.json.data.imported).toBe(3);
    expect(await count(admin)).toBe(4);
    const imported = await get<Paged<TextDto>>(admin, `/api/text-library/texts?batchId=${real.json.data.batchId}&sort=oldest`);
    expect(imported.json.data.items.map((t) => t.text).sort()).toEqual(["Keep going", "Never give up", "Stay hungry"]);
    expect(imported.json.data.items.every((t) => t.approval.status === "PENDING" && t.source === "TXT" && t.language === "en" && t.sourceNote === "my notebook")).toBe(true);
    expect(imported.json.data.items.map((t) => t.sourceRow).sort()).toEqual([1, 4, 7]);
    const batch = await prisma.textImportBatch.findUniqueOrThrow({ where: { id: real.json.data.batchId! } });
    expect(batch).toMatchObject({ fileName: "quotes.txt", format: "TXT", totalRows: 5, importedCount: 3, duplicateCount: 2, invalidCount: 0 });
    expect((await audit(admin.orgId, "TEXT_IMPORTED")).length).toBe(1);
    // the same file again imports nothing
    const again = await importFile(admin, "quotes.txt", file, { dryRun: false, split: "LINE" }, "text/plain");
    expect(again.json.data.imported).toBe(0);
    expect(again.json.data.totals.duplicatesInLibrary).toBe(5); // all five rows are now in the library (the in-file repeat is a library duplicate too)
  });

  it("TXT: blank-line separated multi-line texts", async () => {
    const admin = await org();
    const r = await importFile(admin, "poems.txt", "Roses are red\nViolets are blue\n\nSecond poem\nsecond line\n", { dryRun: false }, "text/plain");
    expect(r.json.data.file.split).toBe("BLANK_LINE");
    expect(r.json.data.imported).toBe(2);
    const all = await get<Paged<TextDto>>(admin, "/api/text-library/texts");
    expect(all.json.data.items.map((t) => t.text).sort()).toEqual(["Roses are red\nViolets are blue", "Second poem\nsecond line"]);
  });

  it("CSV: reads a semicolon file with Turkish headers, quotes and per-row categories and languages", async () => {
    const admin = await org();
    await post(admin, "/api/text-library/categories/starters");
    const csv = '\uFEFFMetin;Kategori;Dil;Kaynak;Yazar\n"Vazgeçme; devam et";Motivation;tr;defterim;Ben\nMaç sonu;Football;;;\n"Çok\nsatırlı";Lifestyle, Motivation;en;;\nBilinmeyen kategori;Astrology;;;\n';
    const dry = await importFile(admin, "turkce.csv", csv, { dryRun: true, language: "tr" }, "text/csv");
    expect(dry.status, dry.text).toBe(200);
    expect(dry.json.data.file).toMatchObject({ format: "CSV", delimiter: ";" });
    expect(dry.json.data.totals).toMatchObject({ rows: 4, new: 4, withWarnings: 1 });
    expect(dry.json.data.unknownCategories).toEqual(["Astrology"]);
    const real = await importFile(admin, "turkce.csv", csv, { dryRun: false, language: "tr" }, "text/csv");
    expect(real.json.data.imported).toBe(4);
    const all = (await get<Paged<TextDto>>(admin, `/api/text-library/texts?batchId=${real.json.data.batchId}`)).json.data.items;
    const by = (text: string) => all.find((t) => t.text === text)!;
    expect(by("Vazgeçme; devam et")).toMatchObject({ language: "tr", sourceNote: "defterim", author: "Ben" });
    expect(by("Vazgeçme; devam et").categories.map((c) => c.name)).toEqual(["Motivation"]);
    expect(by("Maç sonu").categories.map((c) => c.name)).toEqual(["Football"]);
    expect(by("Çok\nsatırlı")).toMatchObject({ language: "en" });
    expect(by("Çok\nsatırlı").categories.map((c) => c.name).sort()).toEqual(["Lifestyle", "Motivation"]);
    expect(by("Bilinmeyen kategori").categories).toHaveLength(0); // the unknown category was not invented
  });

  it("CSV: creates the categories named in the file only when an administrator asks; default categories and applicability apply to rows without their own", async () => {
    const admin = await org();
    const editor = await colleague(admin, "EDITOR");
    const net = await seedNetwork(admin.orgId);
    const cat = (await post<CategoryDto>(admin, "/api/text-library/categories", { name: "Default" })).json.data;
    const csv = "text,category\nOne,Brand new\nTwo,\n";
    expect((await importFile(editor, "c.csv", csv, { dryRun: false, createMissingCategories: true }, "text/csv")).status).toBe(403);
    const real = await importFile(admin, "c.csv", csv, { dryRun: false, createMissingCategories: true, categoryIds: [cat.id], campaignIds: [net.campaign.id], pageCategoryIds: [net.category.id], pageGroupIds: [net.group.id], pageIds: [net.page.id] }, "text/csv");
    expect(real.status, real.text).toBe(201);
    expect(real.json.data.createdCategories).toEqual(["Brand new"]);
    const texts = (await get<Paged<TextDto>>(admin, "/api/text-library/texts")).json.data.items;
    expect(texts.find((t) => t.text === "One")!.categories.map((c) => c.name)).toEqual(["Brand new"]);
    expect(texts.find((t) => t.text === "Two")!.categories.map((c) => c.name)).toEqual(["Default"]);
    for (const t of texts) {
      expect(t.campaigns).toHaveLength(1);
      expect(t.pageCategories).toHaveLength(1);
      expect(t.pageGroups).toHaveLength(1);
      expect(t.pages).toHaveLength(1);
    }
  });

  it("CSV: reads a Windows-1254 (Turkish ANSI) file and says so", async () => {
    const admin = await org();
    const ansi = Buffer.concat([Buffer.from("text\n"), Buffer.from([0xdd, 0x73, 0x74, 0x61, 0x6e, 0x62, 0x75, 0x6c, 0x20, 0xfe, 0x75, 0x20, 0x61, 0x6e, 0x20, 0xf0, 0x75, 0x7a, 0x65, 0x6c])]); // "İstanbul şu an ğuzel"
    const r = await importFile(admin, "ansi.csv", ansi, { dryRun: false }, "text/csv");
    expect(r.status, r.text).toBe(201);
    expect(r.json.data.file.encoding).toBe("windows-1254");
    expect((await get<Paged<TextDto>>(admin, "/api/text-library/texts")).json.data.items[0]!.text).toBe("İstanbul şu an ğuzel");
  });

  it("XLSX: reads the first sheet, or a named one, with header detection and Excel row numbers", async () => {
    const admin = await org();
    await post(admin, "/api/text-library/categories/starters");
    const xlsx = testing.buildXlsx([
      { name: "Quotes", rows: [["Text", "Category", "Language"], ["Believe in yourself", "Motivation", "en"], ["Hard work pays off", "Motivation", "en"], [null, null, null], ["Bad row below", "", ""]] },
      { name: "Memes", rows: [["Text"], ["When the code compiles"]] },
    ]);
    const dry = await importFile(admin, "library.xlsx", xlsx, { dryRun: true }, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(dry.status, dry.text).toBe(200);
    expect(dry.json.data.file).toMatchObject({ format: "XLSX", sheetName: "Quotes" });
    expect(dry.json.data.totals).toMatchObject({ rows: 3, new: 3 });
    const named = await importFile(admin, "library.xlsx", xlsx, { dryRun: false, sheet: "memes" }, "application/octet-stream");
    expect(named.json.data.imported).toBe(1);
    const real = await importFile(admin, "library.xlsx", xlsx, { dryRun: false }, "application/octet-stream");
    expect(real.json.data.imported).toBe(3);
    const texts = (await get<Paged<TextDto>>(admin, `/api/text-library/texts?batchId=${real.json.data.batchId}`)).json.data.items;
    expect(texts.find((t) => t.text === "Believe in yourself")).toMatchObject({ language: "en", source: "XLSX", sourceRow: 2 });
    expect(texts.find((t) => t.text === "Bad row below")!.sourceRow).toBe(5);
    expect(texts.find((t) => t.text === "Believe in yourself")!.categories.map((c) => c.name)).toEqual(["Motivation"]);
  });

  it("flags empty and too-long rows as invalid without stopping the import", async () => {
    const admin = await org();
    const csv = `text,category\n"${"x".repeat(2001)}",\n" ",\nFine one,\n`;
    const r = await importFile(admin, "mixed.csv", csv, { dryRun: false }, "text/csv");
    expect(r.json.data.totals).toMatchObject({ rows: 2, new: 1, invalid: 1 });
    expect(r.json.data.problems[0]).toMatchObject({ row: 2, status: "INVALID" });
    expect(r.json.data.imported).toBe(1);
  });

  it("refuses files that are not what they claim, are empty, binary, damaged or hostile", async () => {
    const admin = await org();
    const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
    const refuse = async (name: string, data: Buffer | string, status: number, code?: string, mime?: string) => {
      const r = await importFile(admin, name, data, { dryRun: false }, mime);
      expect(r.status, `${name}: ${r.text}`).toBe(status);
      if (code) expect((r.json.error?.details as Err | undefined)?.code, name).toBe(code);
      return r;
    };
    await refuse("notes.pdf", "hello", 400); // wrong type
    await refuse("fake.csv", PNG, 400, "SIGNATURE_MISMATCH"); // a PNG renamed .csv
    await refuse("binary.txt", Buffer.from([0x41, 0x00, 0x42, 0x00, 0x43, 0x00]), 400); // binary / UTF-16
    await refuse("empty.txt", "", 400);
    await refuse("fake.xlsx", "this is plain text, not a workbook", 400); // not a ZIP at all
    await refuse("nozip.xlsx", Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(200, 7)]), 400, "XLSX_INVALID"); // starts like a ZIP, is not one
    await refuse("other.xlsx", testing.buildZip([{ name: "hello.txt", data: Buffer.from("hi") }]), 400, "XLSX_INVALID"); // a ZIP, but not a workbook
    const bomb = '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol">]><sst xmlns="x"><si><t>&lol;</t></si></sst>';
    await refuse("bomb.xlsx", testing.buildXlsx([{ name: "S", rows: [["text"], ["a"]] }], { override: { "xl/sharedStrings.xml": bomb } }), 400, "XLSX_UNSAFE");
    await refuse("manyrows.txt", Array.from({ length: 5001 }, (_, i) => `text ${i}`).join("\n"), 413, "TOO_MANY_ROWS");
    await refuse("columns.csv", "foo,bar\n1,2\n", 400, "NO_TEXT_COLUMN");
    const noFile = await http("POST", "/api/text-library/imports", { cookie: admin.cookie, form: (() => { const f = new FormData(); f.append("options", "{}"); return f; })() });
    expect(noFile.status).toBe(400);
    expect(await count(admin)).toBe(0);
  });

  it("rejects bad options; an editor may import, a viewer may not; nothing leaks across organizations", async () => {
    const admin = await org();
    const editor = await colleague(admin, "EDITOR");
    const viewer = await colleague(admin, "VIEWER");
    expect((await importFile(admin, "a.txt", "x", { language: "not a language!" }, "text/plain")).status).toBe(400);
    const form = new FormData();
    form.append("options", "{not json");
    form.append("file", new Blob(["x"], { type: "text/plain" }), "a.txt");
    expect((await http("POST", "/api/text-library/imports", { cookie: admin.cookie, form })).status).toBe(400);
    expect((await importFile(editor, "a.txt", "From the editor", { dryRun: false }, "text/plain")).status).toBe(201);
    expect((await importFile(viewer, "a.txt", "From the viewer", { dryRun: false }, "text/plain")).status).toBe(403);
    const stranger = await org();
    expect((await importFile(stranger, "a.txt", "From the editor", { dryRun: true }, "text/plain")).json.data.totals.duplicatesInLibrary).toBe(0); // the same words in another organization are not a duplicate
    expect((await importFile(admin, "b.txt", "x", { dryRun: true, categoryIds: ["not-mine"] }, "text/plain")).status).toBe(404);
  });
});
