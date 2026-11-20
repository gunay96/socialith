import { describe, expect, it } from "vitest";
import { canonicalPayload, effectiveText, payloadMatchesApproval } from "./payload.js";
import { findRepetitions, normalizeForComparison, similarityPercent } from "./similarity.js";

describe("effectiveText", () => {
  const sources = { captionOverride: null, titleOverride: null, variationCaption: "variation", variationTitle: "var title", contentCaption: "base" };
  it("the destination's own text wins, then the platform variation, then the base caption", () => {
    expect(effectiveText({ ...sources, captionOverride: "mine", titleOverride: "my title" })).toEqual({ caption: "mine", title: "my title" });
    expect(effectiveText(sources)).toEqual({ caption: "variation", title: "var title" });
    expect(effectiveText({ ...sources, variationCaption: null, variationTitle: null })).toEqual({ caption: "base", title: null });
  });
  it("blank strings count as absent", () => {
    expect(effectiveText({ ...sources, captionOverride: "   ", variationCaption: "", contentCaption: null })).toEqual({ caption: null, title: "var title" });
  });
});

describe("canonical payload and approval pinning", () => {
  const input = { platform: "tiktok", caption: "Hello\r\nworld  ", title: null, assetIds: ["a1", "a2"], soundId: "s1" };
  it("is stable under line-ending/whitespace noise and platform case", () => {
    expect(canonicalPayload(input)).toBe(canonicalPayload({ ...input, platform: "TIKTOK", caption: "Hello\nworld" }));
  });
  it("changes when the caption, title, assets, track or platform change", () => {
    const base = canonicalPayload(input);
    for (const change of [{ caption: "Hello there" }, { title: "T" }, { assetIds: ["a1"] }, { assetIds: ["a2", "a1"] }, { soundId: null }, { platform: "instagram" }]) {
      expect(canonicalPayload({ ...input, ...change }), JSON.stringify(change)).not.toBe(base);
    }
  });
  it("an approval only matches the exact payload that was approved", () => {
    const approved = canonicalPayload(input);
    expect(payloadMatchesApproval(approved, canonicalPayload(input))).toBe(true);
    expect(payloadMatchesApproval(approved, canonicalPayload({ ...input, caption: "edited after approval" }))).toBe(false);
    expect(payloadMatchesApproval(null, approved)).toBe(false);
    expect(payloadMatchesApproval(undefined, approved)).toBe(false);
  });
});

describe("similarity", () => {
  it("normalizes case and punctuation", () => {
    expect(normalizeForComparison("  New Single!!! OUT now… ")).toBe("new single out now");
  });
  it("identical text is 100, unrelated text is 0, empty/empty is 100, empty/text is 0", () => {
    expect(similarityPercent("New single out now on all platforms", "new single OUT now on all platforms!")).toBe(100);
    expect(similarityPercent("New single out now on all platforms", "completely different words about something else entirely")).toBe(0);
    expect(similarityPercent(null, "")).toBe(100);
    expect(similarityPercent(null, "text")).toBe(0);
  });
  it("a light edit stays high, a rewrite goes low", () => {
    const a = "The new single is out now go stream it on every platform tonight";
    expect(similarityPercent(a, "The new single is out now go stream it on every platform today")).toBeGreaterThanOrEqual(70);
    expect(similarityPercent(a, "Studio session story: how we recorded the chorus at dawn")).toBeLessThan(20);
  });
});

describe("findRepetitions (maxSimilar = 1: every further destination needs its own text)", () => {
  const same = "New single out now go stream it everywhere tonight";
  const item = (id: string, platform: string, text: string | null, contentId = "c1") => ({ id, platform, contentId, text });

  it("flags the second and third destination that repeat the same text on one platform, never the first", () => {
    const r = findRepetitions([item("a", "TIKTOK", same), item("b", "TIKTOK", same), item("c", "TIKTOK", same)], 85, 1);
    expect(r.map((x) => [x.id, x.repeats])).toEqual([["b", "a"], ["c", "a"]]);
  });
  it("different platforms, different contents and different texts never repeat each other", () => {
    expect(findRepetitions([item("a", "TIKTOK", same), item("b", "INSTAGRAM", same)], 85, 1)).toEqual([]);
    expect(findRepetitions([item("a", "TIKTOK", same, "c1"), item("b", "TIKTOK", same, "c2")], 85, 1)).toEqual([]);
    expect(findRepetitions([item("a", "TIKTOK", same), item("b", "TIKTOK", "A completely different caption written for another page")], 85, 1)).toEqual([]);
  });
  it("a higher allowance lets that many share text", () => {
    const items = [item("a", "TIKTOK", same), item("b", "TIKTOK", same), item("c", "TIKTOK", same)];
    expect(findRepetitions(items, 85, 2).map((x) => x.id)).toEqual(["c"]);
    expect(findRepetitions(items, 85, 3)).toEqual([]);
  });
  it("two destinations without any text count as repeating each other (same asset, nothing distinguishes them)", () => {
    expect(findRepetitions([item("a", "TIKTOK", null), item("b", "TIKTOK", "")], 85, 1).map((x) => x.id)).toEqual(["b"]);
  });
});
