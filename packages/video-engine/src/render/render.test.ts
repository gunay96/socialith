import { mkdtempSync, rmSync, statSync, truncateSync, copyFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportSize, recipeConfigSchema, resolveEffectiveRecipe, safeAreaPx } from "@socialith/studio";
import { FFMPEG, FFPROBE, runRealFfmpegTests } from "../testing/ffmpeg-fixtures.js";
import { makeSolidImage, makeSolidVideo, measureInk, mergeBands, probeJson, readGrayFrame } from "../testing/render-fixtures.js";
import { resolveFontFace } from "./fonts.js";
import { composeAndRender, planComposition, RenderRefusedError, type ComposeResult } from "./render.js";
import { RenderCancelledError, RenderTimeoutError } from "./runner.js";
import { validateOutput } from "./validate.js";

/**
 * Real FFmpeg, real fonts, real files. Each rendered frame is read back and MEASURED (where the ink is, how bright, how
 * many lines), and the measurements are compared with the plan the browser preview draws from. That is the visual
 * regression check: it proves the renderer puts the text where the plan says, for every aspect ratio, and that each
 * animation really moves the way the timeline says. CI installs FFmpeg and the fonts; with CI=true a missing font or
 * FFmpeg fails the suite instead of skipping it.
 */
const fontsAvailable = (() => {
  try {
    resolveFontFace("liberation-sans", "BOLD");
    return true;
  } catch {
    return false;
  }
})();
const suite = runRealFfmpegTests && (fontsAvailable || process.env.CI === "true") ? describe : describe.skip;

const TEXT = "Never give up on the thing you started, because the best is still ahead.";
let dir: string;
let counter = 0;
const src = { wide: "", wideAudio: "", tall: "", image: "", imageSquare: "" };

beforeAll(() => {
  if (!runRealFfmpegTests) return;
  dir = mkdtempSync(join(tmpdir(), "ve-render-"));
  src.wide = join(dir, "wide.mp4");
  src.wideAudio = join(dir, "wide-audio.mp4");
  src.tall = join(dir, "tall.mp4");
  src.image = join(dir, "image.png");
  src.imageSquare = join(dir, "square.png");
  makeSolidVideo(src.wide, { width: 640, height: 360, durationS: 3 });
  makeSolidVideo(src.wideAudio, { width: 640, height: 360, durationS: 3, audio: true });
  makeSolidVideo(src.tall, { width: 360, height: 640, durationS: 3 });
  makeSolidImage(src.image, { width: 640, height: 360 });
  makeSolidImage(src.imageSquare, { width: 500, height: 500 });
});
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const BASE = {
  typography: { font: "liberation-sans", sizePct: 6, weight: "BOLD", color: "#ffffff", shadow: false },
  position: { vertical: "CENTER", align: "CENTER", maxWidthPct: 80 },
  export: { resolution: "720", fps: 24, imageFormat: "PNG" },
  duration: { mode: "FIXED", seconds: 3 },
};
const merge = (a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = v && typeof v === "object" && !Array.isArray(v) && typeof a[k] === "object" ? merge(a[k] as Record<string, unknown>, v as Record<string, unknown>) : v;
  return out;
};
const valuesFor = (config: Record<string, unknown> = {}) => resolveEffectiveRecipe({ config: recipeConfigSchema.parse(merge(BASE, config)) }).values;

interface Rendered extends ComposeResult {
  path: string;
}
async function render(config: Record<string, unknown> = {}, o: { source?: "wide" | "wideAudio" | "tall" | "image" | "imageSquare" | string; text?: string; language?: string | null; kind?: "IMAGE" | "VIDEO"; durationMs?: number; width?: number; height?: number; hasAudio?: boolean; signal?: AbortSignal; timeoutMs?: number; onProgress?: (a: number, b: number) => void } = {}): Promise<Rendered> {
  const id = ++counter;
  const key = o.source ?? "wide";
  const path = key in src ? src[key as keyof typeof src] : key;
  const kind = o.kind ?? (key.startsWith("image") || key === "imageSquare" || /\.png$/.test(path) ? "IMAGE" : "VIDEO");
  const values = valuesFor(config);
  const workDir = join(dir, `work-${id}`);
  const { mkdirSync } = await import("node:fs");
  mkdirSync(workDir, { recursive: true });
  const outputPath = join(dir, `out-${id}.${values.durationMode === "FIXED" || kind === "VIDEO" ? "mp4" : values.imageFormat === "JPEG" ? "jpg" : "png"}`);
  const result = await composeAndRender({
    ffmpegPath: FFMPEG,
    ffprobePath: FFPROBE,
    workDir,
    source: { path, kind, hasAudio: o.hasAudio ?? key === "wideAudio", durationMs: o.durationMs ?? (kind === "VIDEO" ? 3000 : null), width: o.width ?? 640, height: o.height ?? 360 },
    values,
    text: o.text ?? TEXT,
    language: o.language === undefined ? "en" : o.language,
    outputPath,
    x264: { preset: "ultrafast", crf: 30 },
    ...(o.signal ? { signal: o.signal } : {}),
    ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),
    ...(o.onProgress ? { onProgress: o.onProgress } : {}),
  });
  return { ...result, path: outputPath };
}

const frameAt = (r: Rendered, s: number) => readGrayFrame(r.path, r.plan.frame.width, r.plan.frame.height, s);
const sumBrightness = (f: ReturnType<typeof frameAt>, rect: { left: number; top: number; width: number; height: number }) => {
  let sum = 0;
  for (let y = rect.top; y < rect.top + rect.height; y++) for (let x = rect.left; x < rect.left + rect.width; x++) sum += f.data[y * f.width + x]!;
  return sum;
};

suite("every aspect ratio: the ink lands where the plan says", () => {
  for (const [aspect, width, height] of [["9:16", 720, 1280], ["1:1", 720, 720], ["16:9", 1280, 720], ["4:5", 720, 900]] as const) {
    it(`${aspect} still image`, async () => {
      const r = await render({ aspectRatio: aspect, duration: { mode: "SOURCE" } }, { source: "image", kind: "IMAGE" });
      expect(r.outputKind).toBe("IMAGE");
      expect(r.plan.frame).toEqual({ width, height });
      expect(r.validation.ok).toBe(true);
      const ink = measureInk(frameAt(r, 0));
      const { plan } = r;
      const textLines = plan.lines.filter((l) => l.length > 0).length;
      // one separate band of ink per planned line (bands closer than a quarter of the font size are the same line)
      expect(mergeBands(ink.bands, Math.round(plan.fontSizePx * 0.12)).length).toBe(textLines);
      // inside the planned block, horizontally centred, inside the safe area
      const tol = 3;
      expect(ink.left).toBeGreaterThanOrEqual(plan.outer.left - tol);
      expect(ink.right).toBeLessThanOrEqual(plan.outer.left + plan.outer.width + tol);
      expect(ink.top).toBeGreaterThanOrEqual(plan.outer.top - tol);
      expect(ink.bottom).toBeLessThanOrEqual(plan.outer.top + plan.outer.height + tol);
      expect(Math.abs((ink.left + ink.right) / 2 - width / 2)).toBeLessThanOrEqual(width * 0.03);
      const safe = safeAreaPx(plan.frame.width === 1280 ? "16:9" : (aspect as "9:16"), plan.frame);
      expect(ink.top).toBeGreaterThanOrEqual(safe.top - tol);
      expect(ink.bottom).toBeLessThanOrEqual(height - safe.bottom + tol);
    });
  }
});

suite("text position, baseline, width and alignment", () => {
  it("puts the letters on the planned baseline (capitals have no descenders)", async () => {
    const r = await render({ duration: { mode: "SOURCE" } }, { source: "image", kind: "IMAGE", text: "HELLO WORLD" });
    const ink = measureInk(frameAt(r, 0));
    const line = r.plan.lines[0]!;
    expect(Math.abs(ink.bottom - line.baselinePx)).toBeLessThanOrEqual(Math.max(3, r.plan.fontSizePx * 0.04));
    // capital height of a sans font is about 0.7 em
    expect(ink.bottom - ink.top).toBeGreaterThan(r.plan.fontSizePx * 0.55);
    expect(ink.bottom - ink.top).toBeLessThan(r.plan.fontSizePx * 0.85);
  });
  it("draws a line about as wide as the plan measured it", async () => {
    const r = await render({ duration: { mode: "SOURCE" } }, { source: "image", kind: "IMAGE", text: "Football Headline" });
    const ink = measureInk(frameAt(r, 0));
    const line = r.plan.lines[0]!;
    // the ink is narrower than the advance width by the side bearings of the first and last letter
    expect(Math.abs(ink.right - ink.left + 1 - line.widthPx)).toBeLessThanOrEqual(r.plan.fontSizePx * 0.25);
  });
  it("aligns left and right inside the text area", async () => {
    const left = await render({ duration: { mode: "SOURCE" }, position: { align: "LEFT" } }, { source: "image", kind: "IMAGE" });
    expect(Math.abs(measureInk(frameAt(left, 0)).left - left.plan.inner.left)).toBeLessThanOrEqual(left.plan.fontSizePx * 0.12);
    const right = await render({ duration: { mode: "SOURCE" }, position: { align: "RIGHT" } }, { source: "image", kind: "IMAGE" });
    expect(Math.abs(measureInk(frameAt(right, 0)).right - (right.plan.inner.left + right.plan.inner.width))).toBeLessThanOrEqual(right.plan.fontSizePx * 0.15);
  });
  it("keeps text at the bottom of a vertical frame inside the safe area, and says it moved it", async () => {
    const r = await render({ duration: { mode: "SOURCE" }, position: { vertical: "BOTTOM" } }, { source: "image", kind: "IMAGE", text: "Bottom line" });
    const ink = measureInk(frameAt(r, 0));
    expect(ink.bottom).toBeLessThanOrEqual(r.plan.frame.height - r.plan.safeArea.bottom + 3);
    expect(r.warnings.join(" ")).toContain("safe area");
  });
  it("draws a background band across the whole frame and a box around the block", async () => {
    const band = await render({ duration: { mode: "SOURCE" }, typography: { color: "#000000" }, background: { mode: "BAND", color: "#ffffff", opacityPct: 100, paddingPct: 2 } }, { source: "image", kind: "IMAGE", text: "On a band" });
    const f = frameAt(band, 0);
    const midRow = band.plan.outer.top + 2;
    expect(f.data[midRow * f.width + 2]).toBeGreaterThan(240); // white at the far left edge
    expect(f.data[(band.plan.outer.top - 4) * f.width + 2]).toBeLessThan(10); // black above the band
    const box = await render({ duration: { mode: "SOURCE" }, typography: { color: "#000000" }, background: { mode: "BOX", color: "#ffffff", opacityPct: 100, paddingPct: 2 }, position: { maxWidthPct: 60 } }, { source: "image", kind: "IMAGE", text: "In a box" });
    const g = frameAt(box, 0);
    expect(g.data[(box.plan.outer.top + 3) * g.width + box.plan.outer.left + 3]).toBeGreaterThan(240);
    expect(g.data[(box.plan.outer.top + 3) * g.width + 2]).toBeLessThan(10);
  });
  it("renders Turkish text with all its letters", async () => {
    const r = await render({ duration: { mode: "SOURCE" }, typography: { transform: "UPPERCASE" } }, { source: "image", kind: "IMAGE", text: "Vazgeçme, güzel günler ışık saçar.", language: "tr" });
    expect(r.plan.lines.map((l) => l.text).join(" ")).toContain("VAZGEÇME");
    expect(r.plan.lines.map((l) => l.text).join(" ")).toContain("IŞIK");
    expect(r.plan.unsupported).toEqual([]);
    expect(measureInk(frameAt(r, 0)).count).toBeGreaterThan(500);
  });
});

suite("the five animations", () => {
  const ENTRY = 1000;
  it("fade in and fade out follow the timeline's opacity", async () => {
    const r = await render({ animation: { entry: "FADE_IN", exit: "FADE_OUT", entryMs: ENTRY, exitMs: ENTRY } });
    const full = sumBrightness(frameAt(r, 1.5), r.plan.outer);
    expect(full).toBeGreaterThan(0);
    const ratio = (s: number) => sumBrightness(frameAt(r, s), r.plan.outer) / full;
    expect(ratio(0.04)).toBeLessThan(0.12);
    expect(ratio(0.5)).toBeGreaterThan(0.38);
    expect(ratio(0.5)).toBeLessThan(0.62);
    expect(ratio(1.2)).toBeGreaterThan(0.9);
    expect(ratio(2.5)).toBeGreaterThan(0.38);
    expect(ratio(2.5)).toBeLessThan(0.62);
    expect(ratio(2.9)).toBeLessThan(0.16);
  });
  it("slide up moves the block up into place; slide down moves it away at the end", async () => {
    const r = await render({ animation: { entry: "SLIDE_UP", exit: "SLIDE_DOWN", entryMs: ENTRY, exitMs: ENTRY } });
    const final = measureInk(frameAt(r, 1.5), 12).top;
    const slide = r.timeline.slidePx;
    const early = measureInk(frameAt(r, 0.2), 12).top; // p = 0.2: the block is still 0.8^3 of the way down
    expect(Math.abs(early - final - slide * 0.512)).toBeLessThanOrEqual(5);
    const late = measureInk(frameAt(r, 2.8), 12).top; // q = 0.8 of the exit
    expect(Math.abs(late - final - slide * 0.512)).toBeLessThanOrEqual(5);
    expect(measureInk(frameAt(r, 1.2), 12).top).toBe(final);
  });
  it("zoom grows the block from 85 % to full size", async () => {
    const r = await render({ animation: { entry: "ZOOM_IN", entryMs: ENTRY } });
    const widthAt = (s: number) => {
      const ink = measureInk(frameAt(r, s), 12);
      return ink.right - ink.left;
    };
    const final = widthAt(1.5);
    const expected = 0.85 + 0.15 * (1 - Math.pow(1 - 0.2, 3)); // at p = 0.2
    expect(widthAt(0.2) / final).toBeGreaterThan(expected - 0.03);
    expect(widthAt(0.2) / final).toBeLessThan(expected + 0.03);
    expect(widthAt(1.2) / final).toBeGreaterThan(0.99);
  });
  it("typewriter shows more of the text over time and ends identical to the static render", async () => {
    const text = "Never give up on the thing you started, because the best is still ahead of you.";
    const r = await render({ animation: { text: "TYPEWRITER" } }, { text });
    const staticRender = await render({}, { text });
    const target = measureInk(frameAt(staticRender, 2.5)).count;
    const counts = [0.05, 0.4, 0.8, 1.2, 1.8, 2.5].map((s) => measureInk(frameAt(r, s)).count);
    for (let i = 1; i < counts.length; i++) expect(counts[i]!).toBeGreaterThanOrEqual(counts[i - 1]!);
    expect(counts[0]!).toBeLessThan(target * 0.25);
    expect(counts[2]!).toBeGreaterThan(target * 0.2);
    expect(counts[2]!).toBeLessThan(target * 0.85);
    expect(Math.abs(counts.at(-1)! - target) / target).toBeLessThan(0.04);
    // and it gets there in the planned number of steps
    expect(r.timeline.reveal.steps.length).toBeGreaterThan(5);
  });
  it("line by line reveals one more line at each planned moment", async () => {
    const r = await render({ animation: { text: "LINE_BY_LINE" }, position: { maxWidthPct: 60 } });
    const lines = r.plan.lines.filter((l) => l.length > 0).length;
    expect(lines).toBeGreaterThanOrEqual(4);
    const bands = (s: number) => mergeBands(measureInk(frameAt(r, s)).bands, Math.round(r.plan.fontSizePx * 0.12)).length;
    const starts = r.timeline.reveal.lineStartsMs.map((m) => m / 1000);
    const fade = r.timeline.reveal.lineFadeMs / 1000;
    expect(bands(starts[0]! + fade + 0.03)).toBe(1);
    expect(bands(starts[1]! + fade + 0.03)).toBe(2);
    expect(bands(starts[2]! + fade + 0.03)).toBe(3);
    expect(bands(2.9)).toBe(lines);
  });
  it("all five together on one clip still produce a valid file", async () => {
    const r = await render({ animation: { text: "TYPEWRITER", entry: "ZOOM_IN", exit: "SLIDE_DOWN" } }, { source: "wideAudio" });
    expect(r.validation.ok).toBe(true);
    const r2 = await render({ animation: { text: "LINE_BY_LINE", entry: "SLIDE_UP", exit: "FADE_OUT" } }, { source: "wideAudio" });
    expect(r2.validation.ok).toBe(true);
  });
});

suite("media types, resolutions, audio and output", () => {
  it("renders a video with its audio kept as AAC, and without audio when the source has none", async () => {
    const withAudio = await render({ duration: { mode: "SOURCE" } }, { source: "wideAudio" });
    const probe = probeJson(withAudio.path);
    expect(probe.streams.find((s) => s.codec_type === "audio")?.codec_name).toBe("aac");
    expect(probe.streams.find((s) => s.codec_type === "video")?.codec_name).toBe("h264");
    expect(withAudio.validation.ok).toBe(true);
    const silent = await render({ duration: { mode: "SOURCE" } }, { source: "wide" });
    expect(probeJson(silent.path).streams.some((s) => s.codec_type === "audio")).toBe(false);
  });
  it("trims a video to the recipe's fixed length, and never makes it longer than the source", async () => {
    const short = await render({ duration: { mode: "FIXED", seconds: 1 } }, { source: "wideAudio" });
    expect(Math.abs(short.validation.facts.durationMs! - 1000)).toBeLessThanOrEqual(250);
    const long = await render({ duration: { mode: "FIXED", seconds: 30 } }, { source: "wide" });
    expect(long.durationMs).toBe(3000);
    expect(long.warnings.join(" ")).toContain("lasts 3.0 s");
  });
  it("turns an image into a video of the fixed length (no audio), and keeps a still an image", async () => {
    const video = await render({ duration: { mode: "FIXED", seconds: 2 } }, { source: "image", kind: "IMAGE" });
    expect(video.outputKind).toBe("VIDEO");
    expect(video.path.endsWith(".mp4")).toBe(true);
    expect(Math.abs(video.validation.facts.durationMs! - 2000)).toBeLessThanOrEqual(250);
    expect(video.validation.facts.audioCodec).toBeNull();
    const jpeg = await render({ duration: { mode: "SOURCE" }, export: { imageFormat: "JPEG" } }, { source: "image", kind: "IMAGE" });
    expect(jpeg.validation.facts.videoCodec).toBe("mjpeg");
    const png = await render({ duration: { mode: "SOURCE" }, export: { imageFormat: "PNG" } }, { source: "image", kind: "IMAGE" });
    expect(png.validation.facts.videoCodec).toBe("png");
  });
  it("says so when motion is asked of a still image, and does not animate it", async () => {
    const r = await render({ duration: { mode: "SOURCE" }, animation: { entry: "FADE_IN", text: "TYPEWRITER" } }, { source: "image", kind: "IMAGE" });
    expect(r.warnings.join(" ")).toContain("still image cannot move");
    expect(measureInk(frameAt(r, 0)).count).toBeGreaterThan(500);
  });
  it("fills the frame by cropping, or keeps the whole picture with black bars", async () => {
    const white = join(dir, "white.png");
    makeSolidImage(white, { width: 640, height: 360, color: "white" });
    const cover = await render({ aspectRatio: "9:16", fit: "COVER", duration: { mode: "SOURCE" } }, { source: white, kind: "IMAGE", text: "" });
    const fc = frameAt(cover, 0);
    expect(fc.data[5 * fc.width + 5]).toBeGreaterThan(240);
    expect(fc.data[(fc.height - 5) * fc.width + 5]).toBeGreaterThan(240);
    const contain = await render({ aspectRatio: "9:16", fit: "CONTAIN", duration: { mode: "SOURCE" } }, { source: white, kind: "IMAGE", text: "" });
    const fk = frameAt(contain, 0);
    expect(fk.data[5 * fk.width + 5]).toBeLessThan(10);
    expect(fk.data[(fk.height / 2) * fk.width + fk.width / 2]).toBeGreaterThan(240);
  });
  it("handles sources of very different sizes and shapes", async () => {
    const big = join(dir, "big.mp4");
    makeSolidVideo(big, { width: 3840, height: 2160, durationS: 1, fps: 24 });
    const r4k = await render({ duration: { mode: "SOURCE" } }, { source: big, kind: "VIDEO", durationMs: 1000, width: 3840, height: 2160 });
    expect(r4k.validation.ok).toBe(true);
    expect(r4k.validation.facts.width).toBe(720);
    const tiny = join(dir, "tiny.png");
    makeSolidImage(tiny, { width: 160, height: 120 });
    const rTiny = await render({ duration: { mode: "SOURCE" } }, { source: tiny, kind: "IMAGE", width: 160, height: 120 });
    expect(rTiny.warnings.join(" ")).toContain("enlarged");
    const rTall = await render({ aspectRatio: "16:9", duration: { mode: "SOURCE" } }, { source: "tall", kind: "VIDEO", width: 360, height: 640 });
    expect(rTall.validation.facts.width).toBe(1280);
    expect(rTall.validation.facts.height).toBe(720);
  });
  it("draws subtitles cut from the text, one cue after another", async () => {
    const r = await render({ subtitles: { enabled: true, wordsPerCue: 3, position: "TOP" }, position: { vertical: "CENTER" } }, { text: "one two three four five six seven eight nine" });
    expect(r.subtitles.cues.length).toBe(3);
    const top = { top: 0, bottom: Math.round(r.plan.frame.height * 0.3) };
    const at = (s: number) => measureInk(frameAt(r, s), 40, top).count;
    expect(at(0.3)).toBeGreaterThan(200);
    expect(at(1.3)).toBeGreaterThan(200);
    expect(at(2.6)).toBeGreaterThan(200);
  });
  it("reports real progress: measured output time, never ahead of the total, reaching it", async () => {
    const seen: [number, number][] = [];
    const r = await render({ duration: { mode: "SOURCE" } }, { source: "wideAudio", onProgress: (a, b) => seen.push([a, b]) });
    expect(r.validation.ok).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
    for (const [a, b] of seen) {
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThanOrEqual(b);
    }
    for (let i = 1; i < seen.length; i++) expect(seen[i]![0]).toBeGreaterThanOrEqual(seen[i - 1]![0]);
    expect(seen.at(-1)![0]).toBe(seen.at(-1)![1]);
  });
});

suite("refusals, failures, cancellation and output validation", () => {
  const refuses = async (config: Record<string, unknown>, o: Parameters<typeof render>[1], code: string) => {
    const err = await render(config, o).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(RenderRefusedError);
    expect((err as RenderRefusedError).code).toBe(code);
    expect((err as RenderRefusedError).remedy.length).toBeGreaterThan(10);
  };
  it("refuses characters the font cannot draw (emoji), right-to-left text, and text that cannot fit, before running FFmpeg", async () => {
    await refuses({}, { source: "image", kind: "IMAGE", text: "Hello \u{1F600}" }, "UNSUPPORTED_TEXT");
    await refuses({}, { source: "image", kind: "IMAGE", text: "مرحبا" }, "UNSUPPORTED_TEXT");
    await refuses({ typography: { sizePct: 8 } }, { source: "image", kind: "IMAGE", text: "word ".repeat(600) }, "TEXT_DOES_NOT_FIT");
  });
  it("refuses a video whose length is not known", async () => {
    await refuses({}, { source: "wide", kind: "VIDEO", durationMs: 0 }, "SOURCE_UNUSABLE");
  });
  it("plans before it renders: the same inputs always give the same plan", () => {
    const input = { source: { path: "x", kind: "IMAGE" as const, hasAudio: false, durationMs: null, width: 640, height: 360 }, values: valuesFor({ duration: { mode: "SOURCE" } }), text: TEXT, language: "en" };
    expect(planComposition(input).plan).toEqual(planComposition(input).plan);
  });
  it("cancelling stops FFmpeg at once", async () => {
    const long = join(dir, "long.mp4");
    makeSolidVideo(long, { width: 1280, height: 720, durationS: 20, fps: 30 });
    const controller = new AbortController();
    const started = Date.now();
    const err = await render({ duration: { mode: "SOURCE" }, aspectRatio: "16:9", export: { resolution: "1080", fps: 30 } }, { source: long, kind: "VIDEO", durationMs: 20000, width: 1280, height: 720, signal: controller.signal, onProgress: () => controller.abort() }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(RenderCancelledError);
    expect(Date.now() - started).toBeLessThan(20_000);
  });
  it("a timeout stops FFmpeg and says so", async () => {
    const err = await render({ duration: { mode: "SOURCE" } }, { source: "wideAudio", timeoutMs: 1 }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(RenderTimeoutError);
  });
  it("output validation catches a wrong size, a missing audio track and a damaged file", async () => {
    const good = await render({ duration: { mode: "SOURCE" } }, { source: "wideAudio" });
    expect(good.validation.ok).toBe(true);
    const wrongSize = await validateOutput(FFMPEG, FFPROBE, good.path, { ...good.expect, width: 1080, height: 1920 });
    expect(wrongSize.ok).toBe(false);
    expect(wrongSize.problems.join(" ")).toContain("dimensions");
    const wrongAudio = await validateOutput(FFMPEG, FFPROBE, good.path, { ...good.expect, hasAudio: false });
    expect(wrongAudio.problems.join(" ")).toContain("audio");
    const wrongLength = await validateOutput(FFMPEG, FFPROBE, good.path, { ...good.expect, durationMs: 10_000 });
    expect(wrongLength.problems.join(" ")).toContain("duration");
    const damaged = join(dir, "damaged.mp4");
    copyFileSync(good.path, damaged);
    truncateSync(damaged, Math.floor(statSync(damaged).size * 0.6));
    const broken = await validateOutput(FFMPEG, FFPROBE, damaged, good.expect);
    expect(broken.ok).toBe(false);
    const missing = await validateOutput(FFMPEG, FFPROBE, join(dir, "nope.mp4"), good.expect);
    expect(missing.ok).toBe(false);
    expect(existsSync(join(dir, "nope.mp4"))).toBe(false);
  });
  it("says what the picture looks like behind the text, and warns when the text would be hard to read", async () => {
    const white = join(dir, "white2.png");
    makeSolidImage(white, { width: 640, height: 360, color: "white" });
    const bad = await render({ duration: { mode: "SOURCE" } }, { source: white, kind: "IMAGE" });
    expect(bad.readability?.status).toBe("LOW");
    expect(bad.warnings.join(" ")).toContain("hard to read");
    const good = await render({ duration: { mode: "SOURCE" } }, { source: "image", kind: "IMAGE" });
    expect(good.readability?.status).toBe("GOOD");
  });
});

describe("font resolution", () => {
  const dirs = ["/fonts/a"];
  const has = (...files: string[]) => (p: string) => files.some((f) => p.replace(/\\/g, "/").endsWith(f));
  it("uses the requested font's own file when it is installed", () => {
    const r = resolveFontFace("dejavu-sans", "BOLD", { dirs, exists: has("DejaVuSans-Bold.ttf"), platform: "linux" });
    expect(r).toMatchObject({ fallback: false, standIn: false, note: null, used: { fontId: "dejavu-sans", weight: "BOLD" } });
  });
  it("falls back to another installed family, says which and why", () => {
    const r = resolveFontFace("dejavu-serif", "REGULAR", { dirs, exists: has("LiberationSans-Regular.ttf"), platform: "linux" });
    expect(r.fallback).toBe(true);
    expect(r.used.fontId).toBe("liberation-sans");
    expect(r.note).toContain("DejaVu Serif");
    expect(r.note).toContain("not installed");
  });
  it("uses a metric-compatible stand-in on a Windows development machine, and says so", () => {
    const r = resolveFontFace("liberation-sans", "BOLD", { dirs, exists: has("arialbd.ttf"), platform: "win32" });
    expect(r).toMatchObject({ fallback: false, standIn: true, used: { fontId: "liberation-sans" } });
    expect(r.note).toContain("stand-in");
  });
  it("refuses, naming where it looked, when no font is installed at all", () => {
    expect(() => resolveFontFace("liberation-sans", "BOLD", { dirs, exists: () => false, platform: "linux" })).toThrow(/\/fonts\/a/);
  });
  it("plans line breaks for the font that is actually used, and reports the fallback", () => {
    const input = { source: { path: "x", kind: "IMAGE" as const, hasAudio: false, durationMs: null, width: 640, height: 360 }, values: valuesFor({ duration: { mode: "SOURCE" } }), text: TEXT, language: "en" };
    const planned = planComposition(input);
    expect(planned.fonts.used.fontId).toBeTruthy();
    expect(planned.plan.fontId).toBe(planned.fonts.used.fontId);
    void exportSize;
  });
  it("refuses the job when the configured font directories hold no font (Linux); a Windows development machine still has its stand-ins", () => {
    const input = { source: { path: "x", kind: "IMAGE" as const, hasAudio: false, durationMs: null, width: 640, height: 360 }, values: valuesFor({ duration: { mode: "SOURCE" } }), text: TEXT, language: "en" };
    if (process.platform === "win32") {
      expect(planComposition({ ...input, fontDirs: ["/definitely/not/there"] }).fonts.standIn).toBe(true);
    } else {
      expect(() => planComposition({ ...input, fontDirs: ["/definitely/not/there"] })).toThrow(/No usable font file was found/);
    }
  });
});
