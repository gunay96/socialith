import { describe, expect, it } from "vitest";
import { TEXT_MAX_LENGTH, checkText, cleanText, normalizeForDuplicate, normalizeForSearch, textLength } from "./text.js";

describe("cleanText", () => {
  it("normalizes line endings, trims lines and collapses blank runs", () => {
    expect(cleanText("  Hello  \r\nworld \r\n\r\n\r\n\r\nbye\t ")).toBe("Hello\nworld\n\nbye");
  });
  it("removes control, invisible and bidi-override characters but keeps emoji and Turkish letters", () => {
    expect(cleanText("a\u0000b\u200Bc\u202Ed\u0007 ığüşöç 😀")).toBe("abcd ığüşöç 😀");
  });
  it("keeps a zero-width joiner (needed by emoji sequences)", () => {
    expect(cleanText("👨\u200D👩\u200D👧")).toBe("👨\u200D👩\u200D👧");
  });
});

describe("checkText", () => {
  it("flags empty and too long texts by characters, not bytes", () => {
    expect(checkText("")).toBe("EMPTY");
    expect(checkText("a")).toBeNull();
    expect(checkText("😀".repeat(TEXT_MAX_LENGTH))).toBeNull();
    expect(checkText("😀".repeat(TEXT_MAX_LENGTH + 1))).toBe("TOO_LONG");
    expect(textLength("😀😀")).toBe(2);
  });
});

describe("normalizeForDuplicate", () => {
  it("ignores case, spacing and punctuation", () => {
    expect(normalizeForDuplicate("  Never   GIVE up!!  ")).toBe(normalizeForDuplicate("never give up"));
    expect(normalizeForDuplicate("“Never give up.”")).toBe(normalizeForDuplicate("never give up"));
  });
  it("folds the Turkish dotted and dotless i, so KAPI, Kapı and kapi are the same text", () => {
    const a = normalizeForDuplicate("KAPI");
    expect(normalizeForDuplicate("Kapı")).toBe(a);
    expect(normalizeForDuplicate("kapi")).toBe(a);
    expect(normalizeForDuplicate("İSTANBUL")).toBe(normalizeForDuplicate("istanbul"));
  });
  it("does NOT treat different words as the same: su and şu stay different", () => {
    expect(normalizeForDuplicate("su")).not.toBe(normalizeForDuplicate("şu"));
    expect(normalizeForDuplicate("gül")).not.toBe(normalizeForDuplicate("gul"));
  });
  it("keeps different texts different", () => {
    expect(normalizeForDuplicate("Believe in yourself")).not.toBe(normalizeForDuplicate("Believe in yourselves"));
  });
});

describe("normalizeForSearch", () => {
  it("lets a person search without Turkish letters", () => {
    expect(normalizeForSearch("Güzel ÇİÇEK, ışık")).toBe("guzel cicek isik");
    expect(normalizeForSearch("guzel")).toBe("guzel");
  });
});
