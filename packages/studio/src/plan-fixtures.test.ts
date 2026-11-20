import { describe, expect, it } from "vitest";
import { recipeConfigSchema } from "./recipe.js";
import { resolveEffectiveRecipe } from "./recipe-resolve.js";
import { planSubtitles } from "./subtitles.js";
import { planText } from "./text-plan.js";
import { buildTimeline } from "./timeline.js";

/**
 * Layout fixtures: the exact plan (line breaks, sizes, positions, box, motion times) for a fixed set of recipes, texts
 * and aspect ratios, stored in __fixtures__/plans.json. The preview and the renderer both follow this plan, so a change
 * that moves a line break or a pixel shows up here as a diff to review, not as a surprise in a rendered video. To
 * accept an intended change run the studio tests with `-u` and commit the new fixture file.
 */
const values = (config: Record<string, unknown>) => resolveEffectiveRecipe({ config: recipeConfigSchema.parse(config) }).values;

const TEXTS: Record<string, { text: string; language: string }> = {
  short: { text: "Small steps every day.", language: "en" },
  long: { text: "Never give up on the thing you started, because the best is still ahead. Discipline is choosing what you want most over what you want now.", language: "en" },
  turkish: { text: "Vazgeçme, güzel günler ışık saçar.", language: "tr" },
  lines: { text: "First line\nSecond line is a little longer\n\nFourth after a gap", language: "en" },
};

const BASE = { typography: { font: "liberation-sans", sizePct: 6, weight: "BOLD", color: "#ffffff" }, position: { vertical: "LOWER_THIRD", align: "CENTER", maxWidthPct: 80 }, duration: { mode: "FIXED", seconds: 6 } };

const RECIPES: Record<string, Record<string, unknown>> = {
  plain: BASE,
  box: { ...BASE, background: { mode: "BOX", color: "#000000", opacityPct: 55, paddingPct: 2 } },
  band: { ...BASE, position: { vertical: "CENTER", align: "LEFT", maxWidthPct: 80 }, background: { mode: "BAND", color: "#101010", opacityPct: 70, paddingPct: 2 } },
  serifUpper: { ...BASE, typography: { font: "dejavu-serif", sizePct: 5, weight: "REGULAR", color: "#ffd700", transform: "UPPERCASE" }, position: { vertical: "UPPER_THIRD", align: "RIGHT", maxWidthPct: 70 } },
  typewriter: { ...BASE, animation: { text: "TYPEWRITER", entry: "ZOOM_IN", exit: "FADE_OUT", entryMs: 800, exitMs: 600 }, subtitles: { enabled: true, wordsPerCue: 4 } },
  lineByLine: { ...BASE, animation: { text: "LINE_BY_LINE", entry: "SLIDE_UP", exit: "SLIDE_DOWN", entryMs: 700, exitMs: 700 } },
};

const ASPECTS = ["9:16", "1:1", "16:9", "4:5"] as const;

function fixture() {
  const out: Record<string, unknown> = {};
  for (const [rName, rConfig] of Object.entries(RECIPES)) {
    for (const [tName, t] of Object.entries(TEXTS)) {
      for (const aspect of ASPECTS) {
        const v = values({ ...rConfig, aspectRatio: aspect });
        const plan = planText({ text: t.text, language: t.language, values: v });
        const tl = buildTimeline(v, plan, 6000);
        const subs = planSubtitles({ text: t.text, language: t.language, values: v, plan, durationMs: 6000 });
        out[`${rName}/${tName}/${aspect}`] = {
          frame: plan.frame,
          fontSizePx: plan.fontSizePx,
          stepPx: plan.stepPx,
          fits: plan.fits,
          adjustments: plan.adjustments,
          unsupported: plan.unsupported,
          outer: plan.outer,
          inner: plan.inner,
          lines: plan.lines.map((l) => [l.text, Math.round(l.leftPx), l.topPx, l.baselinePx, Math.round(l.widthPx)]),
          timeline: { entry: tl.entry, exit: tl.exit, slidePx: tl.slidePx, reveal: { kind: tl.reveal.kind, durationMs: tl.reveal.durationMs, steps: tl.reveal.steps.length, lineStartsMs: tl.reveal.lineStartsMs, lineFadeMs: tl.reveal.lineFadeMs } },
          subtitleCues: subs.cues.map((c) => [c.startMs, c.endMs, c.lines.map((l) => l.text)]),
        };
      }
    }
  }
  return out;
}

describe("layout fixtures (the plan the preview and the renderer follow)", () => {
  it("matches the stored plans for every recipe, text and aspect ratio", async () => {
    await expect(`${JSON.stringify(fixture(), null, 1)}\n`).toMatchFileSnapshot("./__fixtures__/plans.json");
  });
  it("covers all four aspect ratios, the three backgrounds and all five animations", () => {
    const f = fixture();
    expect(Object.keys(f)).toHaveLength(Object.keys(RECIPES).length * Object.keys(TEXTS).length * ASPECTS.length);
    const kinds = new Set(Object.values(f).flatMap((p) => { const t = (p as { timeline: { entry: { kind: string }; exit: { kind: string }; reveal: { kind: string } } }).timeline; return [t.entry.kind, t.exit.kind, t.reveal.kind]; }));
    for (const k of ["ZOOM_IN", "SLIDE_UP", "FADE_OUT", "SLIDE_DOWN", "TYPEWRITER", "LINE_BY_LINE"]) expect(kinds.has(k)).toBe(true);
  });
  it("every plan in the fixture fits its frame's safe area horizontally", () => {
    for (const p of Object.values(fixture()) as { frame: { width: number }; outer: { left: number; width: number } }[]) {
      expect(p.outer.left).toBeGreaterThanOrEqual(0);
      expect(p.outer.left + p.outer.width).toBeLessThanOrEqual(p.frame.width);
    }
  });
});
