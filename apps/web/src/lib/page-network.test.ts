import { describe, expect, it } from "vitest";
import { EMPTY_DRAFT, draftToProfile, profileToDraft, type EditorialProfile } from "./page-network";

describe("editorial profile draft", () => {
  it("an untouched draft sends nothing (everything inherits)", () => {
    expect(draftToProfile(EMPTY_DRAFT)).toBeNull();
    expect(draftToProfile(profileToDraft(null))).toBeNull();
  });

  it("only filled fields are sent; blank ones stay out so they inherit", () => {
    const p = draftToProfile({ ...EMPTY_DRAFT, visualStyle: "  Cinematic ", aspectRatio: "9:16", fonts: "Anton, Inter\nAnton", maxTextLength: "120" });
    expect(p).toEqual({ visual: { style: "Cinematic", aspectRatio: "9:16", fonts: ["Anton", "Inter"] }, contentPreferences: { maxTextLength: 120 } });
  });

  it("a tri-state choice keeps an explicit 'no' (it overrides a category's 'yes')", () => {
    expect(draftToProfile({ ...EMPTY_DRAFT, requiresVerifiedFacts: "false" })).toEqual({ contentPreferences: { requiresVerifiedFacts: false } });
    expect(draftToProfile({ ...EMPTY_DRAFT, requiresVerifiedFacts: "true" })).toEqual({ contentPreferences: { requiresVerifiedFacts: true } });
    expect(draftToProfile({ ...EMPTY_DRAFT, requiresVerifiedFacts: "" })).toBeNull();
  });

  it("round-trips a stored profile, including a 0 lookback (originality off)", () => {
    const stored: EditorialProfile = {
      contentPreferences: { formats: ["MEME_LAYOUT"], topics: ["football"], avoidTerms: ["bet"], maxTextLength: 90, requiresVerifiedFacts: true },
      visual: { style: "Meme layouts", colors: ["#ff6a00"], textPosition: "TOP", aspectRatio: "1:1" },
      guidelines: "Keep it light",
      originality: { similarityThresholdPct: 70, lookbackPosts: 0 },
      ruleEnforcement: "BLOCK",
    };
    expect(draftToProfile(profileToDraft(stored))).toEqual(stored);
  });

  it("ignores a non-numeric number field instead of sending NaN", () => {
    expect(draftToProfile({ ...EMPTY_DRAFT, maxTextLength: "abc", lookbackPosts: "" })).toBeNull();
  });
});
