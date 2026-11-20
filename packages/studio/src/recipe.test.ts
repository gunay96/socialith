import { describe, expect, it } from "vitest";
import { resolveEditorialIdentity, type EditorialLayer } from "@socialith/publishing";
import { FONT_FAMILIES, matchFont } from "./fonts.js";
import { computeLayout, exportSize, splitIntoCues } from "./layout.js";
import { RECIPE_DEFAULTS, emptyRecipeConfig, parseRecipeConfig, recipeAdjustmentSchema, recipeConfigSchema } from "./recipe.js";
import { checkRecipeCompatibility, hasBlockingIssue, type CompatAsset, type CompatText } from "./recipe-compat.js";
import { RECIPE_PRESETS } from "./recipe-presets.js";
import { resolveEffectiveRecipe } from "./recipe-resolve.js";
import { matchRecipeToPage, selectRecipesForPage, type RecipeScope } from "./recipe-select.js";

const category: EditorialLayer = { profile: { visual: { fonts: ["Liberation Serif"], colors: ["#ffcc00"], textPosition: "LOWER_THIRD", aspectRatio: "4:5" } } };
const page: EditorialLayer = { profile: { visual: { textPosition: "TOP", colors: ["#00ff88"] } } };

describe("recipe configuration", () => {
  it("fills a blank recipe with 'inherit' (null) everywhere", () => {
    const c = emptyRecipeConfig();
    expect(c.aspectRatio).toBeNull();
    expect(c.typography).toEqual({ font: null, sizePct: null, weight: null, color: null, transform: null, shadow: null });
    expect(c.compatibleMedia).toEqual(["IMAGE", "VIDEO"]);
  });
  it("refuses unknown keys, bad colors, unknown fonts, out-of-range values and an empty media list", () => {
    expect(parseRecipeConfig({ typografy: {} }).ok).toBe(false);
    expect(parseRecipeConfig({ typography: { color: "red" } }).ok).toBe(false);
    expect(parseRecipeConfig({ typography: { font: "comic-sans" } }).ok).toBe(false);
    expect(parseRecipeConfig({ typography: { sizePct: 40 } }).ok).toBe(false);
    expect(parseRecipeConfig({ compatibleMedia: [] }).ok).toBe(false);
    expect(parseRecipeConfig({ aspectRatio: "3:2" }).ok).toBe(false);
    const bad = parseRecipeConfig({ position: { vertical: "MIDDLE" } });
    expect(bad.ok === false && bad.issues[0]?.path).toBe("position.vertical");
  });
  it("round-trips through JSON unchanged", () => {
    const c = recipeConfigSchema.parse({ typography: { font: "dejavu-serif", sizePct: 6 }, animation: { entry: "FADE_IN" } });
    expect(recipeConfigSchema.parse(JSON.parse(JSON.stringify(c)))).toEqual(c);
  });
  it("accepts a partial preview adjustment", () => {
    const a = recipeAdjustmentSchema.parse({ typography: { sizePct: 8 } });
    expect(a.typography.sizePct).toBe(8);
    expect(a.typography.font).toBeNull();
  });
});

describe("presets", () => {
  it("are the five required recipes, all valid, all with distinct keys and names", () => {
    expect(RECIPE_PRESETS.map((p) => p.name)).toEqual(["Motivation - Cinematic Quote", "Football - Headline Overlay", "Meme - Image Caption", "Relationship - Emotional Quote", "Custom recipe"]);
    expect(new Set(RECIPE_PRESETS.map((p) => p.key)).size).toBe(5);
    for (const p of RECIPE_PRESETS) expect(recipeConfigSchema.safeParse(p.config).success).toBe(true);
  });
  it("use only fonts the renderer has", () => {
    const ids = new Set(FONT_FAMILIES.map((f) => f.id));
    for (const p of RECIPE_PRESETS) if (p.config.typography.font) expect(ids.has(p.config.typography.font)).toBe(true);
  });
  it("the meme preset is image-only and stays a still image", () => {
    const meme = RECIPE_PRESETS.find((p) => p.key === "MEME_IMAGE_CAPTION")!;
    expect(meme.config.compatibleMedia).toEqual(["IMAGE"]);
    expect(meme.config.duration.mode).toBe("SOURCE");
  });
});

describe("effective settings and where they come from", () => {
  const blank = emptyRecipeConfig();

  it("a blank recipe with no page uses the built-in defaults", () => {
    const e = resolveEffectiveRecipe({ config: blank });
    expect(e.values.font).toBe(RECIPE_DEFAULTS.font);
    expect(e.values.vertical).toBe("CENTER");
    expect(Object.values(e.sources).every((s) => s === "default")).toBe(true);
  });

  it("category defaults apply first", () => {
    const identity = resolveEditorialIdentity({ category });
    const e = resolveEffectiveRecipe({ config: blank, identity });
    expect(e.values).toMatchObject({ font: "liberation-serif", color: "#ffcc00", vertical: "LOWER_THIRD", aspectRatio: "4:5" });
    expect(e.sources).toMatchObject({ font: "category", color: "category", vertical: "category", aspectRatio: "category", sizePct: "default" });
  });

  it("a page's own preferences override the category's", () => {
    const identity = resolveEditorialIdentity({ category, page });
    const e = resolveEffectiveRecipe({ config: blank, identity });
    expect(e.values).toMatchObject({ vertical: "TOP", color: "#00ff88", font: "liberation-serif", aspectRatio: "4:5" });
    expect(e.sources).toMatchObject({ vertical: "page", color: "page", font: "category", aspectRatio: "category" });
  });

  it("a page group sits between the category and the page", () => {
    const group: EditorialLayer = { profile: { visual: { textPosition: "UPPER_THIRD" } } };
    const e = resolveEffectiveRecipe({ config: blank, identity: resolveEditorialIdentity({ category, group }) });
    expect(e.values.vertical).toBe("UPPER_THIRD");
    expect(e.sources.vertical).toBe("group");
  });

  it("an explicit recipe setting overrides the page and the category", () => {
    const config = recipeConfigSchema.parse({ position: { vertical: "BOTTOM" }, typography: { font: "dejavu-sans" } });
    const e = resolveEffectiveRecipe({ config, identity: resolveEditorialIdentity({ category, page }) });
    expect(e.values).toMatchObject({ vertical: "BOTTOM", font: "dejavu-sans", color: "#00ff88" });
    expect(e.sources).toMatchObject({ vertical: "recipe", font: "recipe", color: "page" });
  });

  it("a preview adjustment overrides everything and is reported as not saved", () => {
    const config = recipeConfigSchema.parse({ typography: { sizePct: 5 } });
    const adjustment = recipeAdjustmentSchema.parse({ typography: { sizePct: 9 }, position: { vertical: "CENTER" } });
    const e = resolveEffectiveRecipe({ config, adjustment, identity: resolveEditorialIdentity({ page }) });
    expect(e.values).toMatchObject({ sizePct: 9, vertical: "CENTER" });
    expect(e.sources).toMatchObject({ sizePct: "adjustment", vertical: "adjustment" });
  });

  it("does not use a font the renderer lacks, says so, and falls back", () => {
    const identity = resolveEditorialIdentity({ category: { profile: { visual: { fonts: ["Montserrat"] } } } });
    const e = resolveEffectiveRecipe({ config: blank, identity });
    expect(e.values.font).toBe(RECIPE_DEFAULTS.font);
    expect(e.sources.font).toBe("default");
    expect(e.warnings.join(" ")).toContain("Montserrat");
  });

  it("matches editorial font names to renderer fonts", () => {
    expect(matchFont("Liberation Sans")?.id).toBe("liberation-sans");
    expect(matchFont("dejavu serif")?.id).toBe("dejavu-serif");
    expect(matchFont("Papyrus")).toBeUndefined();
  });

  it("ignores a non-hex palette color with a warning", () => {
    const identity = resolveEditorialIdentity({ page: { profile: { visual: { colors: ["orange"] } } } });
    const e = resolveEffectiveRecipe({ config: blank, identity });
    expect(e.values.color).toBe(RECIPE_DEFAULTS.color);
    expect(e.warnings.join(" ")).toContain("orange");
  });
});

describe("layout", () => {
  it("computes export sizes for every aspect ratio", () => {
    expect(exportSize("9:16", "1080")).toEqual({ width: 1080, height: 1920 });
    expect(exportSize("4:5", "1080")).toEqual({ width: 1080, height: 1350 });
    expect(exportSize("1:1", "720")).toEqual({ width: 720, height: 720 });
    expect(exportSize("16:9", "1080")).toEqual({ width: 1920, height: 1080 });
    expect(exportSize("9:16", "720")).toEqual({ width: 720, height: 1280 });
  });
  it("places the text block from the effective settings", () => {
    const e = resolveEffectiveRecipe({ config: recipeConfigSchema.parse({ position: { vertical: "LOWER_THIRD", offsetPct: 3, maxWidthPct: 70 }, typography: { sizePct: 5 } }) });
    const l = computeLayout(e.values);
    expect(l.block).toEqual({ widthPct: 70, centerYPct: 75, align: "CENTER" });
    expect(l.fontSizePx).toBe(96);
    expect(l.frame).toEqual({ width: 1080, height: 1920 });
  });
  it("keeps the text block inside the frame however far it is nudged", () => {
    const e = resolveEffectiveRecipe({ config: recipeConfigSchema.parse({ position: { vertical: "BOTTOM", offsetPct: 25 } }) });
    expect(computeLayout(e.values).block.centerYPct).toBe(96);
  });
  it("splits subtitles into cues", () => {
    expect(splitIntoCues("one two three four five", 2)).toEqual(["one two", "three four", "five"]);
    expect(splitIntoCues("", 3)).toEqual([]);
  });
});

describe("which recipes suit a page", () => {
  const r = (id: string, name: string, scope: Partial<RecipeScope> = {}): RecipeScope => ({ id, name, status: "ACTIVE", pageIds: [], pageGroupIds: [], pageCategoryIds: [], compatibleMedia: ["IMAGE", "VIDEO"], ...scope });
  const p = { id: "page1", categoryId: "catA", groupIds: ["grpA"] };

  it("matches by page, group, category, or everyone, and refuses the rest", () => {
    expect(matchRecipeToPage(r("1", "a", { pageIds: ["page1"] }), p)).toBe("page");
    expect(matchRecipeToPage(r("2", "b", { pageGroupIds: ["grpA"] }), p)).toBe("group");
    expect(matchRecipeToPage(r("3", "c", { pageCategoryIds: ["catA"] }), p)).toBe("category");
    expect(matchRecipeToPage(r("4", "d"), p)).toBe("everyone");
    expect(matchRecipeToPage(r("5", "e", { pageCategoryIds: ["catB"] }), p)).toBeNull();
  });
  it("orders page over group over category over everyone, several per level", () => {
    const list = [r("4", "everyone"), r("3", "cat B-recipe", { pageCategoryIds: ["catA"] }), r("2", "grp", { pageGroupIds: ["grpA"] }), r("1", "page", { pageIds: ["page1"] }), r("6", "cat A-recipe", { pageCategoryIds: ["catA"] }), r("7", "other", { pageCategoryIds: ["x"] }), { ...r("8", "archived"), status: "ARCHIVED" as const }];
    expect(selectRecipesForPage(list, p).map((m) => [m.recipe.name, m.matchedBy])).toEqual([["page", "page"], ["grp", "group"], ["cat A-recipe", "category"], ["cat B-recipe", "category"], ["everyone", "everyone"]]);
  });
  it("can be limited to a media type", () => {
    expect(selectRecipesForPage([r("1", "img", { compatibleMedia: ["IMAGE"] })], p, { mediaKind: "VIDEO" })).toEqual([]);
  });
});

describe("compatibility of recipe, media, text and page", () => {
  const config = recipeConfigSchema.parse({ compatibleMedia: ["IMAGE"], aspectRatio: "9:16" });
  const effective = resolveEffectiveRecipe({ config });
  const recipe = { config, formatId: null, requiredTextCategoryId: "cat-motivation", pageIds: [], pageGroupIds: [], pageCategoryIds: ["catA"] };
  const goodAsset: CompatAsset = { kind: "IMAGE", status: "READY", rightsStatus: "UNVERIFIED", width: 1080, height: 1920, durationMs: null };
  const goodText: CompatText = { body: "Keep going.", language: "en", approvalStatus: "APPROVED", rightsStatus: "CONFIRMED", categoryIds: ["cat-motivation"], pageIds: [], pageGroupIds: [], pageCategoryIds: [] };
  const codes = (i: ReturnType<typeof checkRecipeCompatibility>) => i.map((x) => x.code);

  it("a fitting image and approved text raise nothing serious", () => {
    const issues = checkRecipeCompatibility({ recipe, effective, asset: goodAsset, text: goodText, purpose: "RENDER" });
    expect(hasBlockingIssue(issues)).toBe(false);
  });
  it("refuses a media type the recipe does not accept, and files that are not usable", () => {
    expect(codes(checkRecipeCompatibility({ recipe, effective, asset: { ...goodAsset, kind: "VIDEO" }, purpose: "PREVIEW" }))).toContain("ASSET_KIND_NOT_ACCEPTED");
    expect(codes(checkRecipeCompatibility({ recipe, effective, asset: { ...goodAsset, kind: "AUDIO" }, purpose: "PREVIEW" }))).toContain("ASSET_KIND_UNSUPPORTED");
    expect(codes(checkRecipeCompatibility({ recipe, effective, asset: { ...goodAsset, status: "FAILED" }, purpose: "PREVIEW" }))).toContain("ASSET_NOT_READY");
    expect(codes(checkRecipeCompatibility({ recipe, effective, asset: { ...goodAsset, rightsStatus: "RESTRICTED" }, purpose: "PREVIEW" }))).toContain("ASSET_RIGHTS_RESTRICTED");
  });
  it("warns about unmeasured and small pictures and explains cropping", () => {
    expect(codes(checkRecipeCompatibility({ recipe, effective, asset: { ...goodAsset, width: null, height: null }, purpose: "PREVIEW" }))).toContain("ASSET_SIZE_UNKNOWN");
    expect(codes(checkRecipeCompatibility({ recipe, effective, asset: { ...goodAsset, width: 300, height: 500 }, purpose: "PREVIEW" }))).toContain("ASSET_LOW_RESOLUTION");
    expect(codes(checkRecipeCompatibility({ recipe, effective, asset: { ...goodAsset, width: 1920, height: 1080 }, purpose: "PREVIEW" }))).toContain("ASSET_ASPECT_DIFFERS");
  });
  it("an unapproved text is a warning for a preview and an error for a render", () => {
    const draft = { ...goodText, approvalStatus: "PENDING" };
    const preview = checkRecipeCompatibility({ recipe, effective, text: draft, purpose: "PREVIEW" }).find((i) => i.code === "TEXT_NOT_APPROVED");
    const render = checkRecipeCompatibility({ recipe, effective, text: draft, purpose: "RENDER" }).find((i) => i.code === "TEXT_NOT_APPROVED");
    expect(preview?.severity).toBe("WARNING");
    expect(render?.severity).toBe("ERROR");
  });
  it("archived, rejected and restricted texts are errors", () => {
    for (const [patch, code] of [[{ approvalStatus: "ARCHIVED" }, "TEXT_ARCHIVED"], [{ approvalStatus: "REJECTED" }, "TEXT_REJECTED"], [{ rightsStatus: "RESTRICTED" }, "TEXT_RIGHTS_RESTRICTED"]] as const) {
      const i = checkRecipeCompatibility({ recipe, effective, text: { ...goodText, ...patch }, purpose: "PREVIEW" }).find((x) => x.code === code);
      expect(i?.severity).toBe("ERROR");
    }
  });
  it("warns when the text category or language does not match", () => {
    const target = { kind: "page" as const, id: "p", categoryId: "catA", groupIds: [], language: "tr", identity: null };
    const issues = checkRecipeCompatibility({ recipe, effective, text: { ...goodText, categoryIds: ["other"] }, target, purpose: "PREVIEW" });
    expect(codes(issues)).toEqual(expect.arrayContaining(["TEXT_CATEGORY_MISMATCH", "TEXT_LANGUAGE_MISMATCH"]));
  });
  it("applies the page's own rules to the text", () => {
    const identity = resolveEditorialIdentity({ page: { profile: { contentPreferences: { avoidTerms: ["giveaway"], maxTextLength: 10 } } } });
    const target = { kind: "page" as const, id: "p", categoryId: "catA", groupIds: [], language: "en", identity };
    const issues = checkRecipeCompatibility({ recipe, effective, text: { ...goodText, body: "Giveaway time, everyone!" }, target, purpose: "PREVIEW" });
    expect(codes(issues)).toEqual(expect.arrayContaining(["PAGE_RULE_TEXT_TOO_LONG", "PAGE_RULE_AVOIDED_TERM"]));
  });
  it("flags a recipe or text that is limited to other pages, categories or groups", () => {
    const other = { kind: "page" as const, id: "p", categoryId: "catZ", groupIds: [], language: "en", identity: null };
    expect(codes(checkRecipeCompatibility({ recipe, effective, target: other, purpose: "PREVIEW" }))).toContain("RECIPE_NOT_FOR_TARGET");
    const limited = { ...goodText, pageCategoryIds: ["catB"] };
    expect(codes(checkRecipeCompatibility({ recipe: { ...recipe, pageCategoryIds: [] }, effective, text: limited, target: other, purpose: "PREVIEW" }))).toContain("TEXT_NOT_FOR_TARGET");
  });
  it("a page group target is compatible through its members", () => {
    const group = { kind: "group" as const, id: "g1", memberPageIds: ["a"], memberCategoryIds: ["catA"], identity: null };
    expect(codes(checkRecipeCompatibility({ recipe, effective, target: group, purpose: "PREVIEW" }))).not.toContain("RECIPE_NOT_FOR_TARGET");
    expect(codes(checkRecipeCompatibility({ recipe, effective, target: { ...group, memberCategoryIds: ["catB"] }, purpose: "PREVIEW" }))).toContain("RECIPE_NOT_FOR_TARGET");
  });
  it("animation on a still image needs a duration", () => {
    const animated = resolveEffectiveRecipe({ config: recipeConfigSchema.parse({ compatibleMedia: ["IMAGE"], animation: { entry: "FADE_IN" } }) });
    expect(codes(checkRecipeCompatibility({ recipe, effective: animated, asset: goodAsset, purpose: "PREVIEW" }))).toContain("ANIMATION_NEEDS_DURATION");
  });
  it("reminds about verified facts for factual formats", () => {
    expect(codes(checkRecipeCompatibility({ recipe: { ...recipe, formatId: "MATCH_FACT_CARD" }, effective, purpose: "PREVIEW" }))).toContain("FORMAT_NEEDS_VERIFIED_FACTS");
  });
});
