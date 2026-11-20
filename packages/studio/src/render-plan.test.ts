import { describe, expect, it } from "vitest";
import { faceFor, measureLine, wrapText } from "./font-metrics.js";
import { recipeConfigSchema } from "./recipe.js";
import { resolveEffectiveRecipe } from "./recipe-resolve.js";
import { SAFE_AREAS } from "./safe-area.js";
import { planSubtitles } from "./subtitles.js";
import { applyTransform, planText } from "./text-plan.js";
import { buildTimeline, stateAt } from "./timeline.js";

const values = (config: Record<string, unknown> = {}) => resolveEffectiveRecipe({ config: recipeConfigSchema.parse(config) }).values;
const plan = (text: string, config: Record<string, unknown> = {}, language: string | null = "en") => planText({ text, language, values: values(config) });
const face = faceFor("liberation-sans", "REGULAR")!;

describe("wrapping with real font widths", () => {
  it("never makes a line wider than the block, and keeps every word", () => {
    const text = "Success is not final, failure is not fatal: it is the courage to continue that counts.";
    const w = wrapText(face, text, 60, 700);
    expect(w.lines.length).toBeGreaterThan(1);
    for (const l of w.lines) expect(measureLine(face, l, 60)).toBeLessThanOrEqual(700);
    expect(w.lines.join(" ").replace(/\s+/g, " ")).toBe(text);
  });
  it("keeps explicit line breaks and empty lines", () => {
    expect(wrapText(face, "one\n\ntwo", 40, 900).lines).toEqual(["one", "", "two"]);
  });
  it("splits a single word that is wider than a line between characters", () => {
    const w = wrapText(face, "Supercalifragilisticexpialidocious", 60, 300);
    expect(w.lines.length).toBeGreaterThan(1);
    for (const l of w.lines) expect(measureLine(face, l, 60)).toBeLessThanOrEqual(300);
    expect(w.lines.join("")).toBe("Supercalifragilisticexpialidocious");
  });
  it("measures Turkish letters as real glyphs (supported) and flags emoji and right-to-left text", () => {
    expect(wrapText(face, "Güzel ışık ğİ", 40, 900).unsupported).toEqual([]);
    expect(wrapText(face, "hello \u{1F600}", 40, 900).unsupported).toEqual(["\u{1F600}"]);
    expect(wrapText(face, "مرحبا", 40, 900).rightToLeft).toBe(true);
  });
  it("a bold face is wider than the regular one", () => {
    const bold = faceFor("liberation-sans", "BOLD")!;
    expect(measureLine(bold, "Football", 60)).toBeGreaterThan(measureLine(face, "Football", 60));
  });
});

describe("letter case", () => {
  it("uppercases Turkish text with the dotted capital I", () => {
    expect(applyTransform("istanbul ışık", "UPPERCASE", "tr")).toBe("İSTANBUL IŞIK");
    expect(applyTransform("istanbul", "UPPERCASE", "en")).toBe("ISTANBUL");
    expect(applyTransform("istanbul", "NONE", "tr")).toBe("istanbul");
  });
});

describe("planning the text block", () => {
  it("centres a short text where the recipe says, in frame pixels, for every aspect ratio", () => {
    for (const [aspect, w, h] of [["9:16", 1080, 1920], ["1:1", 1080, 1080], ["16:9", 1920, 1080], ["4:5", 1080, 1350]] as const) {
      const p = plan("Keep going", { aspectRatio: aspect, position: { vertical: "CENTER" } });
      expect(p.frame).toEqual({ width: w, height: h });
      const centre = p.outer.top + p.outer.height / 2;
      expect(Math.abs(centre - h / 2)).toBeLessThanOrEqual(2);
      expect(p.adjustments).toEqual([]);
      expect(p.fits).toBe(true);
    }
  });
  it("aligns lines left, centre and right inside the text area", () => {
    const text = "A longer line of text that has to be wrapped over several lines to show alignment";
    const at = (align: string) => plan(text, { position: { align, maxWidthPct: 70 }, typography: { sizePct: 5 } });
    const left = at("LEFT");
    expect(left.lines.every((l) => l.leftPx === left.inner.left)).toBe(true);
    const right = at("RIGHT");
    for (const l of right.lines) expect(Math.abs(l.leftPx + l.widthPx - (right.inner.left + right.inner.width))).toBeLessThanOrEqual(1);
    const centre = at("CENTER");
    for (const l of centre.lines) expect(Math.abs(l.leftPx + l.widthPx / 2 - 540)).toBeLessThanOrEqual(1);
  });
  it("moves text inside the safe area and says so (bottom of a vertical frame)", () => {
    const p = plan("Bottom text", { position: { vertical: "BOTTOM" } });
    const bottom = p.outer.top + p.outer.height;
    expect(bottom).toBeLessThanOrEqual(1920 - p.safeArea.bottom);
    expect(p.adjustments.join(" ")).toContain("safe area");
    expect(p.safeArea.status).toBe("ASSUMED");
    expect(SAFE_AREAS["9:16"].bottom).toBeGreaterThan(SAFE_AREAS["1:1"].bottom);
  });
  it("narrows the block to the safe area at the sides", () => {
    const p = plan("Wide", { position: { maxWidthPct: 100 } });
    expect(p.inner.width).toBeLessThanOrEqual(1080 - 2 * p.safeArea.left);
    expect(p.adjustments.join(" ")).toContain("narrower");
  });
  it("shrinks the font to fit a long text and reports it; refuses a text that cannot fit at all", () => {
    const long = "This is a rather long motivational text. ".repeat(4);
    const p = plan(long, { typography: { sizePct: 8 } });
    expect(p.fontSizePx).toBeLessThan(p.requestedFontSizePx);
    expect(p.fits).toBe(true);
    expect(p.adjustments.join(" ")).toContain("reduced");
    const absurd = plan("word ".repeat(600), { typography: { sizePct: 8 } });
    expect(absurd.fits).toBe(false);
  });
  it("sizes a band across the whole frame and a box around the text block", () => {
    const band = plan("Headline text", { background: { mode: "BAND", paddingPct: 2 } });
    expect(band.outer.width).toBe(1080);
    expect(band.outer.left).toBe(0);
    expect(band.inner.width).toBeLessThan(1080);
    const box = plan("Headline text", { background: { mode: "BOX", paddingPct: 2 }, position: { maxWidthPct: 80 } });
    expect(box.outer.width).toBe(Math.round(0.8 * 1080));
    expect(box.inner.width).toBe(box.outer.width - 2 * box.background.paddingPx);
    expect(box.outer.height).toBe(box.lines.length * box.stepPx + 2 * box.background.paddingPx);
  });
  it("counts characters per line for the reveal animations", () => {
    const p = plan("Hello world, this is a test of the counting of characters across lines", { position: { maxWidthPct: 50 } });
    expect(p.lines.length).toBeGreaterThan(1);
    let expected = 0;
    for (const l of p.lines) {
      expect(l.startChar).toBe(expected);
      expected += l.length;
    }
    expect(p.totalChars).toBe(expected);
  });
  it("is deterministic", () => {
    expect(plan("Same text", { typography: { sizePct: 6 } })).toEqual(plan("Same text", { typography: { sizePct: 6 } }));
  });
});

describe("the timeline", () => {
  const p = plan("Hello world, this is a test of the line by line and typewriter reveal of a text", { position: { maxWidthPct: 55 } });
  const tl = (config: Record<string, unknown>, durationMs = 6000, still = false) => {
    const v = values(config);
    const pl = planText({ text: "Hello world, this is a test of the line by line and typewriter reveal of a text", language: "en", values: v });
    return { tl: buildTimeline(v, pl, durationMs, { still }), plan: pl };
  };

  it("fade in and out: opacity ramps over the entry and the exit", () => {
    const { tl: t, plan: pl } = tl({ animation: { entry: "FADE_IN", exit: "FADE_OUT", entryMs: 1000, exitMs: 800 } });
    expect(stateAt(t, pl, 0).opacity).toBe(0);
    expect(stateAt(t, pl, 500).opacity).toBeCloseTo(0.5, 5);
    expect(stateAt(t, pl, 3000).opacity).toBe(1);
    expect(stateAt(t, pl, 6000 - 400).opacity).toBeCloseTo(0.5, 5);
    expect(stateAt(t, pl, 6000).opacity).toBe(0);
  });
  it("slide moves the block up into place at the start and down at the end, easing out then in", () => {
    const { tl: t, plan: pl } = tl({ animation: { entry: "SLIDE_UP", exit: "SLIDE_DOWN", entryMs: 1000, exitMs: 1000 } });
    expect(stateAt(t, pl, 0).offsetYPx).toBe(t.slidePx);
    expect(stateAt(t, pl, 500).offsetYPx).toBeCloseTo(t.slidePx * 0.125, 5); // ease-out cubic: (1-0.5)^3
    expect(stateAt(t, pl, 3000).offsetYPx).toBe(0);
    expect(stateAt(t, pl, 6000).offsetYPx).toBeCloseTo(t.slidePx, 5);
    expect(t.slidePx).toBe(Math.round(0.04 * pl.frame.height));
  });
  it("zoom grows from 85 % to full size", () => {
    const { tl: t, plan: pl } = tl({ animation: { entry: "ZOOM_IN", entryMs: 1000 } });
    expect(stateAt(t, pl, 0).scale).toBeCloseTo(0.85, 5);
    expect(stateAt(t, pl, 1000).scale).toBe(1);
    expect(stateAt(t, pl, 2000).scale).toBe(1);
  });
  it("typewriter shows more characters over time, ends complete, in at most 80 steps", () => {
    const { tl: t, plan: pl } = tl({ animation: { text: "TYPEWRITER" } });
    expect(t.reveal.steps.length).toBeLessThanOrEqual(80);
    let last = -1;
    for (let ms = 0; ms <= 6000; ms += 100) {
      const c = stateAt(t, pl, ms).visibleChars;
      expect(c).toBeGreaterThanOrEqual(last);
      last = c;
    }
    expect(stateAt(t, pl, 0).visibleChars).toBeGreaterThan(0);
    expect(stateAt(t, pl, 6000).visibleChars).toBe(pl.totalChars);
    expect(t.reveal.steps.at(-1)!.chars).toBe(pl.totalChars);
  });
  it("line by line starts each line later than the one before and fades each in", () => {
    const { tl: t, plan: pl } = tl({ animation: { text: "LINE_BY_LINE" } });
    expect(pl.lines.length).toBeGreaterThan(2);
    const starts = t.reveal.lineStartsMs;
    for (let i = 1; i < starts.length; i++) expect(starts[i]).toBeGreaterThan(starts[i - 1]!);
    expect(stateAt(t, pl, 0).lineAlpha[0]).toBe(0);
    expect(stateAt(t, pl, starts[1]! + t.reveal.lineFadeMs).lineAlpha[1]).toBe(1);
    expect(stateAt(t, pl, 6000).lineAlpha.every((a) => a === 1)).toBe(true);
    expect(stateAt(t, pl, starts[1]!).lineAlpha[2]).toBe(0);
  });
  it("a still image has no motion: everything is shown at once", () => {
    const { tl: t, plan: pl } = tl({ animation: { entry: "FADE_IN", exit: "FADE_OUT", text: "TYPEWRITER" } }, 1000, true);
    expect(t.entry.kind).toBe("NONE");
    expect(t.reveal.kind).toBe("NONE");
    const s = stateAt(t, pl, 0);
    expect(s.opacity).toBe(1);
    expect(s.visibleChars).toBe(pl.totalChars);
  });
  it("a very short clip squeezes entry and exit so they never overlap", () => {
    const { tl: t } = tl({ animation: { entry: "FADE_IN", exit: "FADE_OUT", entryMs: 2000, exitMs: 2000 } }, 1000);
    expect(t.entry.ms + t.exit.ms).toBeLessThanOrEqual(900);
  });
  it("ignores a reveal when there is no text", () => {
    const v = values({ animation: { text: "TYPEWRITER" } });
    const empty = planText({ text: "", language: "en", values: v });
    expect(buildTimeline(v, empty, 4000).reveal.kind).toBe("NONE");
    expect(p.totalChars).toBeGreaterThan(0);
  });
});

describe("subtitles", () => {
  it("cuts the text into cues spaced evenly across the clip, inside the safe area", () => {
    const v = values({ subtitles: { enabled: true, wordsPerCue: 3 } });
    const text = "one two three four five six seven eight nine ten";
    const pl = planText({ text, language: "en", values: v });
    const s = planSubtitles({ text, language: "en", values: v, plan: pl, durationMs: 8000 });
    expect(s.enabled).toBe(true);
    expect(s.cues.map((c) => c.lines.map((l) => l.text).join(" "))).toEqual(["one two three", "four five six", "seven eight nine", "ten"]);
    expect(s.cues[0]!.startMs).toBe(0);
    expect(s.cues[1]!.startMs).toBe(2000);
    expect(s.cues.at(-1)!.endMs).toBeLessThanOrEqual(8000);
    for (const c of s.cues) for (const l of c.lines) expect(l.topPx + s.stepPx).toBeLessThanOrEqual(1920 - pl.safeArea.bottom + 1);
  });
  it("is empty when subtitles are off, and drops cues a short clip cannot show", () => {
    const off = values({});
    expect(planSubtitles({ text: "a b c", language: "en", values: off, plan: planText({ text: "a b c", language: "en", values: off }), durationMs: 5000 }).cues).toEqual([]);
    const on = values({ subtitles: { enabled: true, wordsPerCue: 1 } });
    const text = "w1 w2 w3 w4 w5 w6 w7 w8 w9 w10";
    const s = planSubtitles({ text, language: "en", values: on, plan: planText({ text, language: "en", values: on }), durationMs: 2100 });
    expect(s.cues.length).toBe(3); // 700 ms minimum per cue
  });
});
