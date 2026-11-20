import { describe, expect, it } from "vitest";
import { prisma } from "@socialith/database";
import { RECIPE_PRESETS, type RecipeConfig } from "@socialith/studio";
import { addUser, audit, enabled, get, makeOrg, patch, post, put, seedAsset, seedNetwork, useServer, type Session } from "./studio-harness.js";

/**
 * Content recipes (Phase 5B) through the REAL express app against REAL MySQL: presets, creation and validation,
 * duplication, assignment to page categories / groups / pages, inheritance (category, group, page, recipe, preview) with the
 * source of every setting, compatibility checks, and the persistence of the preview selections.
 */
const suite = enabled ? describe : describe.skip;
const SLUG = "it-recipe-";
useServer(SLUG);

interface RecipeDto {
  id: string; name: string; description: string | null; status: string; formatId: string | null; format: { id: string; needsVerifiedFacts: boolean } | null; presetKey: string | null;
  config: RecipeConfig; configProblem: string | null; previewConfig: { assetId: string | null; textId: string | null; pageId: string | null; groupId: string | null; adjustment: unknown } | null;
  requiredTextCategory: { id: string; name: string } | null; duplicatedFrom: { id: string; name: string } | null; version: number;
  assignments: { pageCategories: { id: string }[]; pageGroups: { id: string }[]; pages: { id: string }[]; appliesToAllPages: boolean };
  matchedBy?: string | null;
}
interface Evaluation {
  recipe: { id: string; name: string } | null;
  target: { kind: string; id: string; name: string; groupName: string | null } | null;
  effective: { values: Record<string, unknown>; sources: Record<string, string>; warnings: string[] };
  layout: { frame: { width: number; height: number }; block: { widthPct: number; centerYPct: number; align: string }; fontSizePx: number };
  issues: { code: string; severity: string }[];
  blocking: boolean;
  asset: { id: string; originalName: string; contentUrl: string | null } | null;
  text: { id: string } | null;
  preview: true;
}
type Err = { code?: string };

const admin = () => makeOrg(SLUG, "ADMIN");
const colleague = (s: Session, role: "ADMIN" | "EDITOR" | "VIEWER") => addUser(s.orgId, role, "it-recipe");
const create = (s: Session, name: string, extra: Record<string, unknown> = {}) => post<RecipeDto>(s, "/api/recipes", { name, config: {}, ...extra });
async function must(s: Session, name: string, extra: Record<string, unknown> = {}) {
  const r = await create(s, name, extra);
  expect(r.status, r.text).toBe(201);
  return r.json.data;
}
async function seedText(s: Session, text: string, over: { status?: "APPROVED" | "PENDING" | "ARCHIVED" | "REJECTED"; rights?: "UNVERIFIED" | "CONFIRMED" | "RESTRICTED"; language?: string; categoryIds?: string[] } = {}) {
  const row = await prisma.textEntry.create({
    data: {
      organizationId: s.orgId, body: text, normalizedHash: `${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`.padEnd(64, "0"), searchText: text.toLowerCase(), charCount: text.length,
      language: over.language ?? "tr", approvalStatus: over.status ?? "APPROVED", rightsStatus: over.rights ?? "UNVERIFIED",
      categories: { create: (over.categoryIds ?? []).map((categoryId) => ({ categoryId })) },
    },
  });
  return row;
}

suite("Preset recipes", () => {
  it("lists the five presets, installs them once (idempotent) and links the matching text category", async () => {
    const a = await admin();
    const starters = await post<{ items: { id: string; name: string }[] }>(a, "/api/text-library/categories/starters");
    const motivation = starters.json.data.items.find((c) => c.name === "Motivation")!;
    const list = await get<{ items: { key: string; name: string; recipes: unknown[] }[] }>(a, "/api/recipes/presets");
    expect(list.json.data.items.map((p) => p.name)).toEqual(["Motivation - Cinematic Quote", "Football - Headline Overlay", "Meme - Image Caption", "Relationship - Emotional Quote", "Custom recipe"]);
    expect(list.json.data.items.every((p) => p.recipes.length === 0)).toBe(true);

    const first = await post<{ created: string[] }>(a, "/api/recipes/presets/install");
    expect(first.status).toBe(201);
    expect(first.json.data.created).toHaveLength(5);
    expect((await post<{ created: string[] }>(a, "/api/recipes/presets/install")).json.data.created).toEqual([]);
    const all = await get<{ items: RecipeDto[] }>(a, "/api/recipes");
    expect(all.json.data.items).toHaveLength(5);
    const cinematic = all.json.data.items.find((r) => r.presetKey === "MOTIVATION_CINEMATIC_QUOTE")!;
    expect(cinematic.requiredTextCategory).toEqual({ id: motivation.id, name: "Motivation" });
    expect(cinematic.formatId).toBe("CINEMATIC_QUOTE");
    expect(cinematic.config.typography.font).toBe("liberation-serif");
    expect(all.json.data.items.find((r) => r.presetKey === "FOOTBALL_HEADLINE_OVERLAY")!.format?.needsVerifiedFacts).toBe(true);
    expect(all.json.data.items.find((r) => r.presetKey === "MEME_IMAGE_CAPTION")!.config.compatibleMedia).toEqual(["IMAGE"]);
    expect(all.json.data.items.find((r) => r.presetKey === "CUSTOM")!.config.typography.font).toBeNull();
    expect((await audit(a.orgId, "RECIPE_PRESETS_INSTALLED")).length).toBe(2);
  });

  it("creates a recipe from one preset several times with a free name, and refuses an unknown preset", async () => {
    const a = await admin();
    const one = await post<RecipeDto>(a, "/api/recipes/from-preset", { presetKey: "MEME_IMAGE_CAPTION" });
    const two = await post<RecipeDto>(a, "/api/recipes/from-preset", { presetKey: "MEME_IMAGE_CAPTION" });
    expect([one.status, two.status]).toEqual([201, 201]);
    expect([one.json.data.name, two.json.data.name]).toEqual(["Meme - Image Caption", "Meme - Image Caption (2)"]);
    expect((await post(a, "/api/recipes/from-preset", { presetKey: "NOPE" })).status).toBe(404);
    expect(RECIPE_PRESETS).toHaveLength(5);
  });

  it("only administrators install presets", async () => {
    const a = await admin();
    const editor = await colleague(a, "EDITOR");
    expect((await post(editor, "/api/recipes/presets/install")).status).toBe(403);
    expect((await post(editor, "/api/recipes/from-preset", { presetKey: "CUSTOM" })).status).toBe(403);
    expect((await get(editor, "/api/recipes/presets")).status).toBe(200);
  });
});

suite("Creating and editing recipes", () => {
  it("creates a recipe with validated settings; an empty configuration inherits everything", async () => {
    const a = await admin();
    const r = await must(a, "Quote", { description: "A quote", formatId: "CINEMATIC_QUOTE", config: { aspectRatio: "9:16", typography: { font: "dejavu-serif", sizePct: 6, weight: "BOLD", color: "#ffffff" }, animation: { entry: "FADE_IN" } } });
    expect(r).toMatchObject({ name: "Quote", status: "ACTIVE", version: 1, formatId: "CINEMATIC_QUOTE" });
    expect(r.config.typography).toMatchObject({ font: "dejavu-serif", sizePct: 6, weight: "BOLD", color: "#ffffff", shadow: null });
    expect(r.assignments.appliesToAllPages).toBe(true);
    const blank = await must(a, "Blank");
    expect(blank.config.aspectRatio).toBeNull();
    expect(blank.config.compatibleMedia).toEqual(["IMAGE", "VIDEO"]);
    expect((await audit(a.orgId, "RECIPE_CREATED")).length).toBe(2);
  });

  it("refuses unknown settings, bad values, an unknown font, an unknown format, and empty media", async () => {
    const a = await admin();
    const bad = async (config: unknown, extra: Record<string, unknown> = {}) => {
      const r = await create(a, `Bad ${Math.random()}`, { config, ...extra });
      expect(r.status, JSON.stringify(config)).toBe(400);
    };
    await bad({ typografy: {} });
    await bad({ typography: { font: "comic-sans" } });
    await bad({ typography: { color: "red" } });
    await bad({ typography: { sizePct: 80 } });
    await bad({ position: { vertical: "MIDDLE" } });
    await bad({ aspectRatio: "3:2" });
    await bad({ compatibleMedia: [] });
    await bad({}, { formatId: "NOT_A_FORMAT" });
    expect((await create(a, "x".repeat(121))).status).toBe(400);
    expect((await create(a, "Foreign category", { requiredTextCategoryId: "nope" })).status).toBe(404);
  });

  it("refuses a duplicate name; only administrators write; everyone reads", async () => {
    const a = await admin();
    const editor = await colleague(a, "EDITOR");
    const viewer = await colleague(a, "VIEWER");
    const r = await must(a, "Unique name");
    expect((await create(a, "Unique name")).status).toBe(409);
    expect((await create(editor, "By editor")).status).toBe(403);
    expect((await patch(editor, `/api/recipes/${r.id}`, { description: "x" })).status).toBe(403);
    expect((await get<{ items: RecipeDto[] }>(viewer, "/api/recipes")).json.data.items).toHaveLength(1);
    expect((await get<RecipeDto>(viewer, `/api/recipes/${r.id}`)).status).toBe(200);
  });

  it("edits settings and bumps the version; a no-op edit does not; archived recipes cannot be edited", async () => {
    const a = await admin();
    const r = await must(a, "Editable", { config: { typography: { sizePct: 5 } } });
    const same = await patch<RecipeDto>(a, `/api/recipes/${r.id}`, { config: { typography: { sizePct: 5 } }, name: "Editable" });
    expect(same.json.data.version).toBe(1);
    const changed = await patch<RecipeDto>(a, `/api/recipes/${r.id}`, { name: "Edited", description: "d", config: { typography: { sizePct: 8, font: "liberation-sans" }, background: { mode: "BAND", opacityPct: 60 } } });
    expect(changed.json.data).toMatchObject({ name: "Edited", description: "d", version: 2 });
    expect(changed.json.data.config.typography).toMatchObject({ sizePct: 8, font: "liberation-sans" });
    expect(changed.json.data.config.background.mode).toBe("BAND");
    expect((await patch(a, `/api/recipes/${r.id}`, { config: { typography: { sizePct: 99 } } })).status).toBe(400);
    expect((await audit(a.orgId, "RECIPE_UPDATED")).length).toBe(1);
    await post(a, `/api/recipes/${r.id}/archive`);
    expect((await patch(a, `/api/recipes/${r.id}`, { description: "again" })).status).toBe(409);
    expect((await get<{ items: RecipeDto[] }>(a, "/api/recipes")).json.data.items).toHaveLength(0);
    expect((await post<RecipeDto>(a, `/api/recipes/${r.id}/restore`)).json.data.status).toBe("ACTIVE");
    const other = await must(a, "Other");
    expect((await patch(a, `/api/recipes/${other.id}`, { name: "Edited" })).status).toBe(409);
    expect((await audit(a.orgId, "RECIPE_ARCHIVED")).length).toBe(1);
  });

  it("other organizations cannot see or change a recipe", async () => {
    const a = await admin();
    const r = await must(a, "Private");
    const stranger = await admin();
    expect((await get(stranger, `/api/recipes/${r.id}`)).status).toBe(404);
    expect((await patch(stranger, `/api/recipes/${r.id}`, { name: "x" })).status).toBe(404);
    expect((await post(stranger, `/api/recipes/${r.id}/duplicate`)).status).toBe(404);
    expect((await get<{ items: RecipeDto[] }>(stranger, "/api/recipes")).json.data.items).toHaveLength(0);
  });
});

suite("Duplicating recipes", () => {
  it("copies settings, assignments and text category, names the copy, and records where it came from", async () => {
    const a = await admin();
    const net = await seedNetwork(a.orgId);
    const cat = (await post<{ items: { id: string; name: string }[] }>(a, "/api/text-library/categories/starters")).json.data.items.find((c) => c.name === "Football")!;
    const original = await must(a, "Original", { formatId: "MEME_LAYOUT", requiredTextCategoryId: cat.id, pageCategoryIds: [net.category.id], pageGroupIds: [net.group.id], pageIds: [net.page.id], config: { typography: { sizePct: 7, font: "dejavu-sans" }, position: { vertical: "TOP" } } });
    const copy = await post<RecipeDto>(a, `/api/recipes/${original.id}/duplicate`);
    expect(copy.status).toBe(201);
    expect(copy.json.data.name).toBe("Original (copy)");
    expect(copy.json.data.config).toEqual(original.config);
    expect(copy.json.data.requiredTextCategory?.id).toBe(cat.id);
    expect(copy.json.data.formatId).toBe("MEME_LAYOUT");
    expect(copy.json.data.duplicatedFrom).toEqual({ id: original.id, name: "Original" });
    expect(copy.json.data.assignments.pageCategories.map((c) => c.id)).toEqual([net.category.id]);
    expect(copy.json.data.assignments.pageGroups.map((c) => c.id)).toEqual([net.group.id]);
    expect(copy.json.data.assignments.pages.map((c) => c.id)).toEqual([net.page.id]);
    const second = await post<RecipeDto>(a, `/api/recipes/${original.id}/duplicate`);
    expect(second.json.data.name).toBe("Original (copy 2)");
    const named = await post<RecipeDto>(a, `/api/recipes/${original.id}/duplicate`, { name: "My own name" });
    expect(named.json.data.name).toBe("My own name");
    expect((await post(a, `/api/recipes/${original.id}/duplicate`, { name: "My own name" })).status).toBe(409);
    // the copy is independent: changing it leaves the original alone
    await patch(a, `/api/recipes/${copy.json.data.id}`, { config: { typography: { sizePct: 3 } } });
    expect((await get<RecipeDto>(a, `/api/recipes/${original.id}`)).json.data.config.typography.sizePct).toBe(7);
    expect((await audit(a.orgId, "RECIPE_DUPLICATED")).length).toBe(3);
  });

  it("a preset keeps its preset key when duplicated, so the origin stays traceable", async () => {
    const a = await admin();
    const preset = (await post<RecipeDto>(a, "/api/recipes/from-preset", { presetKey: "FOOTBALL_HEADLINE_OVERLAY" })).json.data;
    const copy = (await post<RecipeDto>(a, `/api/recipes/${preset.id}/duplicate`)).json.data;
    expect(copy.presetKey).toBe("FOOTBALL_HEADLINE_OVERLAY");
    expect(copy.duplicatedFrom?.id).toBe(preset.id);
  });
});

suite("Assigning recipes to page categories, page groups and pages", () => {
  it("replaces the assignment lists, validates ownership, and filters the list by assignment", async () => {
    const a = await admin();
    const net = await seedNetwork(a.orgId);
    const r = await must(a, "Assigned");
    const set = await put<RecipeDto>(a, `/api/recipes/${r.id}/assignments`, { pageCategoryIds: [net.category.id], pageGroupIds: [net.group.id], pageIds: [net.page.id] });
    expect(set.json.data.assignments).toMatchObject({ appliesToAllPages: false });
    expect(set.json.data.version).toBe(2);
    const ids = async (q: string) => (await get<{ items: RecipeDto[] }>(a, `/api/recipes?${q}`)).json.data.items.map((x) => x.id);
    expect(await ids(`pageCategoryId=${net.category.id}`)).toEqual([r.id]);
    expect(await ids(`pageGroupId=${net.group.id}`)).toEqual([r.id]);
    expect(await ids(`pageId=${net.page.id}`)).toEqual([r.id]);
    expect(await ids(`pageId=${net.other.id}`)).toEqual([]);
    const onlyCategory = await put<RecipeDto>(a, `/api/recipes/${r.id}/assignments`, { pageGroupIds: [], pageIds: [] });
    expect(onlyCategory.json.data.assignments.pageCategories).toHaveLength(1); // a list that was not sent is untouched
    expect(onlyCategory.json.data.assignments.pageGroups).toHaveLength(0);
    expect((await put(a, `/api/recipes/${r.id}/assignments`, {})).status).toBe(400);
    const stranger = await admin();
    const foreign = await seedNetwork(stranger.orgId);
    expect((await put(a, `/api/recipes/${r.id}/assignments`, { pageIds: [foreign.page.id] })).status).toBe(404);
    expect((await put(a, `/api/recipes/${r.id}/assignments`, { pageCategoryIds: [foreign.category.id] })).status).toBe(404);
    const editor = await colleague(a, "EDITOR");
    expect((await put(editor, `/api/recipes/${r.id}/assignments`, { pageIds: [] })).status).toBe(403);
    expect((await audit(a.orgId, "RECIPE_ASSIGNMENT_CHANGED")).length).toBe(2);
  });

  it("offers the recipes for a page in order: its own, then its group's, then its category's, then everyone's", async () => {
    const a = await admin();
    const net = await seedNetwork(a.orgId);
    const everyone = await must(a, "D everyone");
    const category = await must(a, "C category", { pageCategoryIds: [net.category.id] });
    const group = await must(a, "B group", { pageGroupIds: [net.group.id] });
    const page = await must(a, "A page", { pageIds: [net.page.id] });
    const elsewhere = await must(a, "E elsewhere", { pageIds: [net.other.id] });
    const imageOnly = await must(a, "F images", { config: { compatibleMedia: ["IMAGE"] }, pageCategoryIds: [net.category.id] });
    const archived = await must(a, "G archived", { pageIds: [net.page.id] });
    await post(a, `/api/recipes/${archived.id}/archive`);

    const forPage = await get<{ items: RecipeDto[]; total: number }>(a, `/api/recipes?forPageId=${net.page.id}`);
    expect(forPage.json.data.items.map((r) => [r.name, r.matchedBy])).toEqual([["A page", "page"], ["B group", "group"], ["C category", "category"], ["F images", "category"], ["D everyone", "everyone"]]);
    const forOther = await get<{ items: RecipeDto[] }>(a, `/api/recipes?forPageId=${net.other.id}`);
    expect(forOther.json.data.items.map((r) => r.name)).toEqual(["E elsewhere", "C category", "F images", "D everyone"]); // not the page's own or its group's
    const video = await get<{ items: RecipeDto[] }>(a, `/api/recipes?forPageId=${net.page.id}&forMedia=VIDEO`);
    expect(video.json.data.items.map((r) => r.name)).not.toContain("F images");
    expect((await get(a, "/api/recipes?forPageId=nope")).status).toBe(404);
    expect([everyone, category, group, page, elsewhere, imageOnly].every((r) => r.id)).toBe(true);
  });
});

suite("Inheritance: category, group, page and recipe settings", () => {
  const evaluate = (s: Session, body: Record<string, unknown>) => post<Evaluation>(s, "/api/recipes/evaluate", body);

  it("category defaults apply first; a page's own preferences override them", async () => {
    const a = await admin();
    const net = await seedNetwork(a.orgId, { pageVisual: { textPosition: "TOP", colors: ["#00ff88"] } });
    const r = await must(a, "Inheriting");
    const forOther = await evaluate(a, { recipeId: r.id, pageId: net.other.id }); // no page preferences: the category decides
    expect(forOther.status, forOther.text).toBe(200);
    expect(forOther.json.data.effective.values).toMatchObject({ font: "liberation-serif", color: "#ffcc00", vertical: "LOWER_THIRD", aspectRatio: "4:5" });
    expect(forOther.json.data.effective.sources).toMatchObject({ font: "category", color: "category", vertical: "category", aspectRatio: "category", sizePct: "default" });
    const forPage = await evaluate(a, { recipeId: r.id, pageId: net.page.id }); // the page overrides what it sets
    expect(forPage.json.data.effective.values).toMatchObject({ vertical: "TOP", color: "#00ff88", font: "liberation-serif" });
    expect(forPage.json.data.effective.sources).toMatchObject({ vertical: "page", color: "page", font: "category" });
    expect(forPage.json.data.target).toMatchObject({ kind: "page", id: net.page.id });
    expect(forPage.json.data.preview).toBe(true);
  });

  it("an explicit recipe setting overrides the page and the category; a preview adjustment overrides the recipe and is labelled unsaved", async () => {
    const a = await admin();
    const net = await seedNetwork(a.orgId, { pageVisual: { textPosition: "TOP" } });
    const r = await must(a, "Explicit", { config: { position: { vertical: "BOTTOM" }, typography: { font: "dejavu-sans", sizePct: 4 } } });
    const e = await evaluate(a, { recipeId: r.id, pageId: net.page.id });
    expect(e.json.data.effective.values).toMatchObject({ vertical: "BOTTOM", font: "dejavu-sans", sizePct: 4, color: "#ffcc00" });
    expect(e.json.data.effective.sources).toMatchObject({ vertical: "recipe", font: "recipe", sizePct: "recipe", color: "category" });
    const adjusted = await evaluate(a, { recipeId: r.id, pageId: net.page.id, adjustment: { typography: { sizePct: 9 }, position: { vertical: "CENTER" } } });
    expect(adjusted.json.data.effective.values).toMatchObject({ sizePct: 9, vertical: "CENTER" });
    expect(adjusted.json.data.effective.sources).toMatchObject({ sizePct: "adjustment", vertical: "adjustment", font: "recipe" });
    // an adjustment never changes what is stored
    expect((await get<RecipeDto>(a, `/api/recipes/${r.id}`)).json.data.config.typography.sizePct).toBe(4);
    expect((await evaluate(a, { recipeId: r.id, adjustment: { typography: { sizePct: 99 } } })).status).toBe(400);
  });

  it("a page group layer sits between the category and the page, and only applies when the page is a member", async () => {
    const a = await admin();
    const net = await seedNetwork(a.orgId);
    await prisma.pageGroup.update({ where: { id: net.group.id }, data: { contentPreferences: { visual: { textPosition: "UPPER_THIRD" } } } });
    const r = await must(a, "Grouped");
    const withGroup = await evaluate(a, { recipeId: r.id, pageId: net.page.id, groupId: net.group.id });
    expect(withGroup.json.data.effective.values.vertical).toBe("UPPER_THIRD");
    expect(withGroup.json.data.effective.sources.vertical).toBe("group");
    expect(withGroup.json.data.target?.groupName).toBe(net.group.name);
    const withoutGroup = await evaluate(a, { recipeId: r.id, pageId: net.page.id });
    expect(withoutGroup.json.data.effective.sources.vertical).toBe("category");
    expect((await evaluate(a, { recipeId: r.id, pageId: net.other.id, groupId: net.group.id })).status).toBe(400); // not a member
    const groupOnly = await evaluate(a, { recipeId: r.id, groupId: net.group.id });
    expect(groupOnly.json.data.target).toMatchObject({ kind: "group", id: net.group.id });
    expect(groupOnly.json.data.effective.values.vertical).toBe("UPPER_THIRD");
  });

  it("evaluates an unsaved configuration, or an unsaved edit of a stored recipe, without storing anything", async () => {
    const a = await admin();
    const r = await must(a, "Stored", { config: { typography: { sizePct: 5 } } });
    const draft = await evaluate(a, { config: { typography: { sizePct: 11 }, aspectRatio: "1:1" } });
    expect(draft.json.data.recipe).toBeNull();
    expect(draft.json.data.effective.values).toMatchObject({ sizePct: 11, aspectRatio: "1:1" });
    expect(draft.json.data.layout.frame).toEqual({ width: 1080, height: 1080 });
    const edit = await evaluate(a, { recipeId: r.id, config: { typography: { sizePct: 12 } } });
    expect(edit.json.data.recipe?.id).toBe(r.id);
    expect(edit.json.data.effective.values.sizePct).toBe(12);
    expect((await get<RecipeDto>(a, `/api/recipes/${r.id}`)).json.data).toMatchObject({ version: 1 });
    expect((await evaluate(a, {})).status).toBe(400);
    expect((await evaluate(a, { config: { typography: { font: "nope" } } })).status).toBe(400);
  });

  it("falls back, with a warning, when a page asks for a font the renderer does not have", async () => {
    const a = await admin();
    const net = await seedNetwork(a.orgId, { categoryVisual: { fonts: ["Montserrat"] } });
    const r = await must(a, "No such font");
    const e = await evaluate(a, { recipeId: r.id, pageId: net.page.id });
    expect(e.json.data.effective.values.font).toBe("dejavu-sans");
    expect(e.json.data.effective.sources.font).toBe("default");
    expect(e.json.data.effective.warnings.join(" ")).toContain("Montserrat");
  });

  it("any role can run the preview calculation; it needs a session and stays inside the organization", async () => {
    const a = await admin();
    const viewer = await colleague(a, "VIEWER");
    const net = await seedNetwork(a.orgId);
    const r = await must(a, "Readable");
    expect((await evaluate(viewer, { recipeId: r.id, pageId: net.page.id })).status).toBe(200);
    const stranger = await admin();
    expect((await evaluate(stranger, { recipeId: r.id })).status).toBe(404);
    expect((await evaluate(stranger, { config: {}, pageId: net.page.id })).status).toBe(404);
  });
});

suite("Compatibility of recipe, media, text and page", () => {
  const evaluate = (s: Session, body: Record<string, unknown>) => post<Evaluation>(s, "/api/recipes/evaluate", body);
  const codes = (e: { json: { data: Evaluation } }) => e.json.data.issues.map((i) => i.code);
  const severity = (e: { json: { data: Evaluation } }, code: string) => e.json.data.issues.find((i) => i.code === code)?.severity;

  it("media compatibility: kind, readiness, rights, size and animation", async () => {
    const a = await admin();
    const imageRecipe = await must(a, "Images only", { config: { compatibleMedia: ["IMAGE"], aspectRatio: "9:16", animation: { entry: "FADE_IN" } } });
    const good = await seedAsset(a.orgId, { width: 1080, height: 1920 });
    const video = await seedAsset(a.orgId, { kind: "VIDEO", width: 1920, height: 1080, durationMs: 5000 });
    const failed = await seedAsset(a.orgId, { status: "FAILED" });
    const restricted = await seedAsset(a.orgId, { rights: "RESTRICTED" });
    const small = await seedAsset(a.orgId, { width: 300, height: 500 });
    const unmeasured = await seedAsset(a.orgId, { width: null, height: null });
    const audio = await seedAsset(a.orgId, { kind: "AUDIO", width: null, height: null });
    const run = (assetId: string) => evaluate(a, { recipeId: imageRecipe.id, assetId });

    const ok = await run(good.id);
    expect(ok.status, ok.text).toBe(200);
    expect(ok.json.data.asset).toMatchObject({ id: good.id });
    expect(ok.json.data.asset?.contentUrl).toBeNull(); // nothing stored in this test; the DTO never exposes storage keys
    expect(ok.json.data.blocking).toBe(false);
    expect(codes(ok)).toContain("ANIMATION_NEEDS_DURATION"); // a still image with animation needs a duration
    expect(severity(await run(video.id), "ASSET_KIND_NOT_ACCEPTED")).toBe("ERROR");
    expect(severity(await run(failed.id), "ASSET_NOT_READY")).toBe("ERROR");
    expect(severity(await run(restricted.id), "ASSET_RIGHTS_RESTRICTED")).toBe("ERROR");
    expect(severity(await run(small.id), "ASSET_LOW_RESOLUTION")).toBe("WARNING");
    expect(severity(await run(unmeasured.id), "ASSET_SIZE_UNKNOWN")).toBe("WARNING");
    expect(severity(await run(audio.id), "ASSET_KIND_UNSUPPORTED")).toBe("ERROR");
    expect((await run(video.id)).json.data.blocking).toBe(true);
    const wide = await evaluate(a, { config: { compatibleMedia: ["VIDEO"], aspectRatio: "9:16" }, assetId: video.id });
    expect(codes(wide)).toContain("ASSET_ASPECT_DIFFERS");
    expect(wide.json.data.blocking).toBe(false);
    expect((await evaluate(a, { recipeId: imageRecipe.id, assetId: "nope" })).status).toBe(404);
    const stranger = await admin();
    const foreign = await seedAsset(stranger.orgId);
    expect((await run(foreign.id)).status).toBe(404);
  });

  it("text compatibility: approval (warning for a preview, error for a render), category, language, page rules", async () => {
    const a = await admin();
    const net = await seedNetwork(a.orgId, { categoryVisual: {} });
    await prisma.managedPage.update({ where: { id: net.page.id }, data: { language: "tr", profile: { contentPreferences: { avoidTerms: ["giveaway"], maxTextLength: 30 } } } });
    const cat = (await post<{ items: { id: string; name: string }[] }>(a, "/api/text-library/categories/starters")).json.data.items.find((c) => c.name === "Motivation")!;
    const r = await must(a, "Needs motivation", { requiredTextCategoryId: cat.id });
    const approved = await seedText(a, "Devam et", { categoryIds: [cat.id] });
    const draft = await seedText(a, "Taslak metin", { status: "PENDING", categoryIds: [cat.id] });
    const archived = await seedText(a, "Arşivlenmiş", { status: "ARCHIVED" });
    const rejected = await seedText(a, "Reddedilmiş", { status: "REJECTED" });
    const restricted = await seedText(a, "Kullanılamaz", { rights: "RESTRICTED", categoryIds: [cat.id] });
    const wrongCategory = await seedText(a, "Başka kategori");
    const english = await seedText(a, "An English line", { language: "en", categoryIds: [cat.id] });
    const rules = await seedText(a, "Giveaway: kazanan herkes için büyük hediye var!", { categoryIds: [cat.id] });
    const run = (textId: string, purpose = "PREVIEW") => evaluate(a, { recipeId: r.id, textId, pageId: net.page.id, purpose });

    expect((await run(approved.id)).json.data.blocking).toBe(false);
    expect(severity(await run(draft.id), "TEXT_NOT_APPROVED")).toBe("WARNING");
    expect((await run(draft.id)).json.data.blocking).toBe(false);
    expect(severity(await run(draft.id, "RENDER"), "TEXT_NOT_APPROVED")).toBe("ERROR");
    expect((await run(draft.id, "RENDER")).json.data.blocking).toBe(true);
    expect(severity(await run(archived.id), "TEXT_ARCHIVED")).toBe("ERROR");
    expect(severity(await run(rejected.id), "TEXT_REJECTED")).toBe("ERROR");
    expect(severity(await run(restricted.id), "TEXT_RIGHTS_RESTRICTED")).toBe("ERROR");
    expect(severity(await run(wrongCategory.id), "TEXT_CATEGORY_MISMATCH")).toBe("WARNING");
    expect(severity(await run(english.id), "TEXT_LANGUAGE_MISMATCH")).toBe("WARNING");
    const ruled = await run(rules.id);
    expect(codes(ruled)).toEqual(expect.arrayContaining(["PAGE_RULE_AVOIDED_TERM", "PAGE_RULE_TEXT_TOO_LONG"]));
    expect((await evaluate(a, { recipeId: r.id, textId: "nope" })).status).toBe(404);
    expect((await run(approved.id)).json.data.text).toEqual({ id: approved.id, text: "Devam et", approvalStatus: "APPROVED", language: "tr" });
  });

  it("page and page-group compatibility: a recipe or text limited to other pages, groups or categories is flagged", async () => {
    const a = await admin();
    const net = await seedNetwork(a.orgId);
    const limited = await must(a, "Category only", { pageCategoryIds: [net.category.id] });
    const elsewhere = await prisma.pageCategory.create({ data: { organizationId: a.orgId, name: "Elsewhere", slug: "elsewhere" } });
    const elsewherePage = await prisma.managedPage.create({ data: { organizationId: a.orgId, name: "Elsewhere page", slug: "elsewhere-page", categoryId: elsewhere.id } });
    const evaluateFor = (body: Record<string, unknown>) => evaluate(a, { recipeId: limited.id, ...body });
    expect(codes(await evaluateFor({ pageId: net.page.id }))).not.toContain("RECIPE_NOT_FOR_TARGET");
    expect(codes(await evaluateFor({ pageId: elsewherePage.id }))).toContain("RECIPE_NOT_FOR_TARGET");
    // a page group is compatible through its member pages' categories
    expect(codes(await evaluateFor({ groupId: net.group.id }))).not.toContain("RECIPE_NOT_FOR_TARGET");
    const emptyGroup = await prisma.pageGroup.create({ data: { organizationId: a.orgId, name: "Empty group", slug: "empty-group" } });
    await prisma.pageGroupMember.create({ data: { groupId: emptyGroup.id, pageId: elsewherePage.id } });
    expect(codes(await evaluateFor({ groupId: emptyGroup.id }))).toContain("RECIPE_NOT_FOR_TARGET");
    const groupRecipe = await must(a, "Group only", { pageGroupIds: [net.group.id] });
    expect(codes(await evaluate(a, { recipeId: groupRecipe.id, groupId: net.group.id }))).not.toContain("RECIPE_NOT_FOR_TARGET");
    // a text limited to another category
    const text = await prisma.textEntry.create({ data: { organizationId: a.orgId, body: "Limited text", normalizedHash: "f".repeat(64), searchText: "limited text", charCount: 12, approvalStatus: "APPROVED", pageCategories: { create: [{ categoryId: elsewhere.id }] } } });
    expect(codes(await evaluate(a, { recipeId: groupRecipe.id, textId: text.id, pageId: net.page.id }))).toContain("TEXT_NOT_FOR_TARGET");
    expect(codes(await evaluate(a, { recipeId: groupRecipe.id, textId: text.id, pageId: elsewherePage.id }))).not.toContain("TEXT_NOT_FOR_TARGET");
  });

  it("reminds about verified facts for factual formats", async () => {
    const a = await admin();
    const r = (await post<RecipeDto>(a, "/api/recipes/from-preset", { presetKey: "FOOTBALL_HEADLINE_OVERLAY" })).json.data;
    expect(codes(await evaluate(a, { recipeId: r.id }))).toContain("FORMAT_NEEDS_VERIFIED_FACTS");
  });
});

suite("Preview configuration persistence", () => {
  it("saves what was chosen in the preview and returns it when the recipe is opened again", async () => {
    const a = await admin();
    const net = await seedNetwork(a.orgId);
    const asset = await seedAsset(a.orgId);
    const text = await seedText(a, "Remembered text");
    const r = await must(a, "With preview");
    expect(r.previewConfig).toBeNull();
    const saved = await put<RecipeDto>(a, `/api/recipes/${r.id}/preview-config`, { assetId: asset.id, textId: text.id, pageId: net.page.id, groupId: net.group.id, adjustment: { typography: { sizePct: 7 }, position: { vertical: "TOP" } } });
    expect(saved.status, saved.text).toBe(200);
    const reopened = (await get<RecipeDto>(a, `/api/recipes/${r.id}`)).json.data;
    expect(reopened.previewConfig).toMatchObject({ assetId: asset.id, textId: text.id, pageId: net.page.id, groupId: net.group.id });
    const adj = reopened.previewConfig!.adjustment as { typography: { sizePct: number | null; font: string | null }; position: { vertical: string | null } };
    expect(adj.typography.sizePct).toBe(7);
    expect(adj.typography.font).toBeNull();
    expect(adj.position.vertical).toBe("TOP");
    // saving the preview does not touch the recipe itself
    expect(reopened.config).toEqual(r.config);
    expect(reopened.version).toBe(1);
    // and it can be cleared
    const cleared = await put<RecipeDto>(a, `/api/recipes/${r.id}/preview-config`, {});
    expect(cleared.json.data.previewConfig).toMatchObject({ assetId: null, textId: null, pageId: null, groupId: null, adjustment: null });
    expect((await audit(a.orgId, "RECIPE_PREVIEW_SAVED")).length).toBe(2);
  });

  it("refuses selections from another organization or unknown ones, and bad adjustments; only administrators save", async () => {
    const a = await admin();
    const r = await must(a, "Guarded preview");
    const stranger = await admin();
    const foreign = await seedNetwork(stranger.orgId);
    const foreignAsset = await seedAsset(stranger.orgId);
    expect((await put(a, `/api/recipes/${r.id}/preview-config`, { assetId: foreignAsset.id })).status).toBe(404);
    expect((await put(a, `/api/recipes/${r.id}/preview-config`, { pageId: foreign.page.id })).status).toBe(404);
    expect((await put(a, `/api/recipes/${r.id}/preview-config`, { groupId: foreign.group.id })).status).toBe(404);
    expect((await put(a, `/api/recipes/${r.id}/preview-config`, { textId: "nope" })).status).toBe(404);
    expect((await put(a, `/api/recipes/${r.id}/preview-config`, { adjustment: { typography: { sizePct: 500 } } })).status).toBe(400);
    const editor = await colleague(a, "EDITOR");
    expect((await put(editor, `/api/recipes/${r.id}/preview-config`, {})).status).toBe(403);
    expect((await put(stranger, `/api/recipes/${r.id}/preview-config`, {})).status).toBe(404);
  });
});

suite("Traceability", () => {
  it("a recipe records who made and last changed it, and where a copy came from", async () => {
    const a = await admin();
    const r = await must(a, "Traced");
    const row = await prisma.contentRecipe.findUniqueOrThrow({ where: { id: r.id } });
    expect(row.createdById).toBe(a.userId);
    expect(row.updatedById).toBe(a.userId);
    const second = await colleague(a, "ADMIN");
    await patch(second, `/api/recipes/${r.id}`, { description: "changed by another admin" });
    const after = await prisma.contentRecipe.findUniqueOrThrow({ where: { id: r.id } });
    expect(after.updatedById).toBe(second.userId);
    expect(after.createdById).toBe(a.userId);
    const logs = await audit(a.orgId, "RECIPE_UPDATED");
    expect(logs[0]!.userId).toBe(second.userId);
    expect((logs[0]!.metadataJson as { fields: string[] }).fields).toEqual(["description"]);
    expect(((await create(a, "x", { config: { typography: { font: "nope" } } })).json.error?.details as { issues?: unknown[] } | undefined)?.issues).toBeDefined();
    const err = (await create(a, "y", { config: { bogus: 1 } })).json.error?.details as Err | undefined;
    expect(err).toBeDefined();
  });
});
