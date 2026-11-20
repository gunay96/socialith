import { describe, expect, it } from "vitest";
import {
  EDITORIAL_FORMATS,
  EDITORIAL_FORMAT_IDS,
  STARTER_CATEGORIES,
  checkOriginality,
  checkPageRules,
  normalizeHandle,
  resolveEditorialIdentity,
  type EditorialLayer,
} from "./editorial.js";

const category: EditorialLayer = {
  editorialStyle: "Short motivational messages",
  language: "tr",
  profile: {
    contentPreferences: { formats: ["SHORT_MESSAGE"], topics: ["discipline"], avoidTerms: ["casino"], maxTextLength: 120 },
    visual: { style: "Cinematic", fonts: ["Anton"], colors: ["#111111", "#ff6a00"], textPosition: "CENTER", aspectRatio: "9:16" },
    guidelines: "No medical claims.",
  },
};

describe("editorial identity inheritance", () => {
  it("a page with nothing of its own inherits everything from its category", () => {
    const r = resolveEditorialIdentity({ category, page: {} });
    expect(r.editorialStyle).toBe("Short motivational messages");
    expect(r.language).toBe("tr");
    expect(r.contentPreferences.formats).toEqual(["SHORT_MESSAGE"]);
    expect(r.visual).toMatchObject({ style: "Cinematic", fonts: ["Anton"], textPosition: "CENTER", aspectRatio: "9:16" });
    expect(r.guidelines).toBe("No medical claims.");
    expect(r.sources["editorialStyle"]).toBe("category");
    expect(r.sources["visual.colors"]).toBe("category");
  });

  it("an individual page setting overrides the category default, field by field", () => {
    const page: EditorialLayer = { editorialStyle: "Quiet, reflective lines", profile: { visual: { colors: ["#ffffff"], aspectRatio: "4:5" }, contentPreferences: { maxTextLength: 80 } } };
    const r = resolveEditorialIdentity({ category, page });
    expect(r.editorialStyle).toBe("Quiet, reflective lines");
    expect(r.sources["editorialStyle"]).toBe("page");
    // overridden
    expect(r.visual.colors).toEqual(["#ffffff"]);
    expect(r.visual.aspectRatio).toBe("4:5");
    expect(r.contentPreferences.maxTextLength).toBe(80);
    // everything else still inherited
    expect(r.visual.fonts).toEqual(["Anton"]);
    expect(r.visual.textPosition).toBe("CENTER");
    expect(r.contentPreferences.formats).toEqual(["SHORT_MESSAGE"]);
    expect(r.sources["visual.colors"]).toBe("page");
    expect(r.sources["visual.fonts"]).toBe("category");
  });

  it("lists are replaced, never concatenated", () => {
    const r = resolveEditorialIdentity({ category, page: { profile: { contentPreferences: { avoidTerms: ["lottery"] } } } });
    expect(r.contentPreferences.avoidTerms).toEqual(["lottery"]);
  });

  it("blank strings, empty lists and nulls inherit instead of clearing", () => {
    const page: EditorialLayer = { editorialStyle: "   ", language: null, profile: { visual: { style: "", fonts: [], colors: [" "], textPosition: null }, guidelines: null } };
    const r = resolveEditorialIdentity({ category, page });
    expect(r.editorialStyle).toBe("Short motivational messages");
    expect(r.visual.style).toBe("Cinematic");
    expect(r.visual.fonts).toEqual(["Anton"]);
    expect(r.visual.colors).toEqual(["#111111", "#ff6a00"]);
    expect(r.visual.textPosition).toBe("CENTER");
    expect(r.guidelines).toBe("No medical claims.");
  });

  it("a page can override a category's true with an explicit false", () => {
    const football: EditorialLayer = { profile: { contentPreferences: { requiresVerifiedFacts: true } } };
    expect(resolveEditorialIdentity({ category: football, page: {} }).contentPreferences.requiresVerifiedFacts).toBe(true);
    const r = resolveEditorialIdentity({ category: football, page: { profile: { contentPreferences: { requiresVerifiedFacts: false } } } });
    expect(r.contentPreferences.requiresVerifiedFacts).toBe(false);
    expect(r.sources["contentPreferences.requiresVerifiedFacts"]).toBe("page");
  });

  it("group preferences sit between the category and the page", () => {
    const group: EditorialLayer = { profile: { visual: { aspectRatio: "1:1", style: "Network look" } } };
    const withGroup = resolveEditorialIdentity({ category, group, page: { profile: { visual: { style: "Page look" } } } });
    expect(withGroup.visual.aspectRatio).toBe("1:1");
    expect(withGroup.sources["visual.aspectRatio"]).toBe("group");
    expect(withGroup.visual.style).toBe("Page look");
    expect(withGroup.sources["visual.style"]).toBe("page");
    // without the group the category speaks
    expect(resolveEditorialIdentity({ category, page: {} }).visual.aspectRatio).toBe("9:16");
  });

  it("nothing set anywhere: unset values are null/empty and say so, built-in defaults say 'default'", () => {
    const r = resolveEditorialIdentity({});
    expect(r.editorialStyle).toBeNull();
    expect(r.visual.aspectRatio).toBeNull();
    expect(r.sources["visual.aspectRatio"]).toBe("unset");
    expect(r.ruleEnforcement).toBe("WARN");
    expect(r.sources["ruleEnforcement"]).toBe("default");
    expect(r.originality.lookbackPosts).toBe(30);
    expect(r.contentPreferences.requiresVerifiedFacts).toBe(false);
  });

  it("ignores values that are not valid (unknown enum, out-of-range number)", () => {
    const bad = { profile: { visual: { textPosition: "MIDDLE", aspectRatio: "2:1" }, originality: { similarityThresholdPct: 500 } } } as unknown as EditorialLayer;
    const r = resolveEditorialIdentity({ category, page: bad });
    expect(r.visual.textPosition).toBe("CENTER");
    expect(r.visual.aspectRatio).toBe("9:16");
    expect(r.originality.similarityThresholdPct).toBeNull();
  });

  it("de-duplicates list entries without changing their spelling", () => {
    const r = resolveEditorialIdentity({ page: { profile: { visual: { colors: ["#FF6A00", " #ff6a00 ", "#000000"] } } } });
    expect(r.visual.colors).toEqual(["#FF6A00", "#000000"]);
  });
});

describe("page-specific content rules", () => {
  const id = (p?: EditorialLayer["profile"]) => resolveEditorialIdentity({ page: { profile: p } });

  it("warns by default about a text that is too long", () => {
    const issues = checkPageRules(id({ contentPreferences: { maxTextLength: 10 } }), "this is far too long");
    expect(issues).toEqual([expect.objectContaining({ code: "PAGE_RULE_TEXT_TOO_LONG", severity: "WARNING" })]);
  });

  it("turns into an error when the page says BLOCK", () => {
    const issues = checkPageRules(id({ ruleEnforcement: "BLOCK", contentPreferences: { maxTextLength: 5 } }), "123456");
    expect(issues[0]).toMatchObject({ code: "PAGE_RULE_TEXT_TOO_LONG", severity: "ERROR" });
  });

  it("finds avoided terms case-insensitively at the start of a word (Turkish suffixes allowed), not inside other words", () => {
    const identity = id({ contentPreferences: { avoidTerms: ["bahis", "ass"] } });
    expect(checkPageRules(identity, "BAHİS sitesine gir")).toEqual([expect.objectContaining({ code: "PAGE_RULE_AVOIDED_TERM" })]);
    expect(checkPageRules(identity, "bahisçiler")).toHaveLength(1);
    expect(checkPageRules(identity, "a classy glass")).toHaveLength(0);
  });

  it("folds the Turkish dotted/dotless i", () => {
    const identity = id({ contentPreferences: { avoidTerms: ["ışık"] } });
    expect(checkPageRules(identity, "IŞIK yok")).toHaveLength(1);
    expect(checkPageRules(id({ contentPreferences: { avoidTerms: ["istanbul"] } }), "İSTANBUL")).toHaveLength(1);
  });

  it("only reminds about facts - it never claims to verify them", () => {
    const issues = checkPageRules(id({ contentPreferences: { requiresVerifiedFacts: true } }), "Team A won 3-1");
    expect(issues).toEqual([expect.objectContaining({ code: "PAGE_RULE_VERIFIED_FACTS", severity: "INFO" })]);
    expect(issues[0]!.message).toMatch(/does not verify/i);
    expect(checkPageRules(id({ contentPreferences: { requiresVerifiedFacts: true } }), "")).toHaveLength(0);
  });

  it("a page without rules produces no issues", () => {
    expect(checkPageRules(id(), "anything at all")).toEqual([]);
  });
});

describe("page originality", () => {
  const identity = resolveEditorialIdentity({});
  const previous = [
    { id: "p1", text: "Never give up on the days that feel the hardest, they build you" },
    { id: "p2", text: "Something else entirely about football on a rainy tuesday night" },
  ];

  it("flags a text that repeats an earlier post of the page (warning by default)", () => {
    const issues = checkOriginality(identity, "Never give up on the days that feel the hardest, they build you", previous, 85);
    expect(issues).toEqual([expect.objectContaining({ code: "PAGE_RULE_NOT_ORIGINAL", severity: "WARNING" })]);
  });

  it("does not flag a genuinely different text", () => {
    expect(checkOriginality(identity, "Start small today and let tomorrow take care of itself", previous, 85)).toEqual([]);
  });

  it("uses the page's own threshold over the organization's", () => {
    const strict = resolveEditorialIdentity({ page: { profile: { originality: { similarityThresholdPct: 30 } } } });
    const text = "Never give up on the days that feel easy, they build nothing";
    expect(checkOriginality(identity, text, previous, 85)).toEqual([]);
    expect(checkOriginality(strict, text, previous, 85)).toHaveLength(1);
  });

  it("is an error when the page enforces BLOCK, and off when lookback is 0", () => {
    const text = "Never give up on the days that feel the hardest, they build you";
    expect(checkOriginality(resolveEditorialIdentity({ page: { profile: { ruleEnforcement: "BLOCK" } } }), text, previous, 85)[0]!.severity).toBe("ERROR");
    expect(checkOriginality(resolveEditorialIdentity({ page: { profile: { originality: { lookbackPosts: 0 } } } }), text, previous, 85)).toEqual([]);
  });

  it("only looks as far back as the lookback window", () => {
    const narrow = resolveEditorialIdentity({ page: { profile: { originality: { lookbackPosts: 1 } } } });
    const text = "Something else entirely about football on a rainy tuesday night";
    expect(checkOriginality(narrow, text, previous, 85)).toEqual([]); // p2 is outside the window of 1
    expect(checkOriginality(identity, text, previous, 85)).toHaveLength(1);
  });

  it("an empty text is never compared", () => {
    expect(checkOriginality(identity, "  ", previous, 85)).toEqual([]);
  });
});

describe("handles, formats and starter categories", () => {
  it("normalizes handles", () => {
    expect(normalizeHandle("  @Motivation_Daily ")).toBe("motivation_daily");
    expect(normalizeHandle("@@x")).toBe("x");
  });

  it("format definitions are unique, definition-only and reference valid aspect ratios", () => {
    expect(new Set(EDITORIAL_FORMAT_IDS).size).toBe(EDITORIAL_FORMATS.length);
    for (const f of EDITORIAL_FORMATS) {
      expect(f.implementation).toBe("DEFINITION_ONLY");
      expect(f.aspectRatios.length).toBeGreaterThan(0);
    }
    expect(EDITORIAL_FORMATS.find((f) => f.id === "MATCH_FACT_CARD")!.needsVerifiedFacts).toBe(true);
  });

  it("the starter categories match the brief, reference only known formats and invent no fonts or colors", () => {
    expect(STARTER_CATEGORIES.map((c) => c.name)).toEqual(["Motivation", "Football", "Humor / Memes", "Relationships", "Lifestyle", "Entertainment"]);
    expect(new Set(STARTER_CATEGORIES.map((c) => c.slug)).size).toBe(STARTER_CATEGORIES.length);
    for (const c of STARTER_CATEGORIES) {
      for (const f of c.profile.contentPreferences?.formats ?? []) expect(EDITORIAL_FORMAT_IDS).toContain(f);
      expect(c.profile.visual?.fonts).toBeUndefined();
      expect(c.profile.visual?.colors).toBeUndefined();
      expect(c.defaultEditorialStyle.length).toBeGreaterThan(10);
    }
    expect(STARTER_CATEGORIES.find((c) => c.slug === "football")!.profile.contentPreferences?.requiresVerifiedFacts).toBe(true);
  });
});
