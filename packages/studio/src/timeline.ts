import type { TextPlan } from "./text-plan.js";
import type { EffectiveValues } from "./recipe-resolve.js";

/**
 * The motion of a recipe as numbers on a time axis. The browser preview evaluates it (`stateAt`) and the renderer turns
 * the same numbers into FFmpeg filters, so fades, slides, zooms, the typewriter and the line-by-line reveal start, end
 * and ease identically.
 *
 *   FADE_IN / SLIDE_UP / ZOOM_IN   the whole text block fades in (linear) over `entry.ms`; slide also moves up
 *                                  `slidePx` and zoom also grows from `zoomFrom` to 1, both with ease-out cubic
 *   FADE_OUT / SLIDE_DOWN          the block fades out (linear) over the last `exit.ms`; slide also moves down, ease-in cubic
 *   TYPEWRITER                     characters appear in steps (at most 80 steps) over `reveal.durationMs`
 *   LINE_BY_LINE                   each line fades in (300 ms) at its own start time over `reveal.durationMs`
 */
export type EntryKind = "NONE" | "FADE_IN" | "SLIDE_UP" | "ZOOM_IN";
export type ExitKind = "NONE" | "FADE_OUT" | "SLIDE_DOWN";
export type RevealKind = "NONE" | "TYPEWRITER" | "LINE_BY_LINE";

export interface TypewriterStep {
  atMs: number;
  /** Characters visible from `atMs` on. */
  chars: number;
}

export interface Timeline {
  durationMs: number;
  entry: { kind: EntryKind; ms: number };
  exit: { kind: ExitKind; ms: number };
  slidePx: number;
  zoomFrom: number;
  reveal: { kind: RevealKind; startMs: number; durationMs: number; steps: TypewriterStep[]; lineStartsMs: number[]; lineFadeMs: number };
}

export const MAX_TYPEWRITER_STEPS = 80;
export const LINE_FADE_MS = 300;
export const ZOOM_FROM = 0.85;

export const easeOutCubic = (p: number): number => 1 - Math.pow(1 - p, 3);
export const easeInCubic = (q: number): number => q * q * q;
const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/**
 * `still` builds the timeline of a still image: nothing moves, everything is revealed (a still frame cannot animate,
 * and the job says so instead of pretending).
 */
export function buildTimeline(values: EffectiveValues, plan: TextPlan, durationMs: number, options: { still?: boolean } = {}): Timeline {
  const D = Math.max(1, Math.round(durationMs));
  const still = options.still === true;
  let entryMs = still || values.entryAnimation === "NONE" ? 0 : values.entryMs;
  let exitMs = still || values.exitAnimation === "NONE" ? 0 : values.exitMs;
  if (entryMs + exitMs > D * 0.9) {
    const k = (D * 0.9) / (entryMs + exitMs);
    entryMs = Math.floor(entryMs * k);
    exitMs = Math.floor(exitMs * k);
  }
  const revealKind: RevealKind = still || plan.totalChars === 0 ? "NONE" : values.textAnimation;
  // half the clip, but between 1.2 s and 6 s, and never longer than 90 % of the clip
  const revealDur = Math.min(Math.round(D * 0.9), Math.min(6000, Math.max(1200, Math.round(D * 0.5))));
  const steps: TypewriterStep[] = [];
  if (revealKind === "TYPEWRITER") {
    const n = Math.min(plan.totalChars, MAX_TYPEWRITER_STEPS);
    for (let k = 0; k < n; k++) steps.push({ atMs: Math.floor((revealDur * k) / n), chars: Math.ceil(((k + 1) * plan.totalChars) / n) });
  }
  const textLines = plan.lines.filter((l) => l.length > 0);
  const lineStartsMs = revealKind === "LINE_BY_LINE" ? plan.lines.map((l) => (l.length === 0 ? 0 : Math.floor((revealDur * textLines.indexOf(l)) / Math.max(1, textLines.length)))) : [];
  return {
    durationMs: D,
    entry: { kind: still ? "NONE" : values.entryAnimation, ms: entryMs },
    exit: { kind: still ? "NONE" : values.exitAnimation, ms: exitMs },
    slidePx: Math.round(0.04 * plan.frame.height),
    zoomFrom: ZOOM_FROM,
    reveal: { kind: revealKind, startMs: 0, durationMs: revealDur, steps, lineStartsMs, lineFadeMs: Math.min(LINE_FADE_MS, Math.max(100, Math.floor(revealDur / Math.max(1, textLines.length)))) },
  };
}

export interface FrameState {
  /** 0..1, entry and exit combined. */
  opacity: number;
  /** Vertical offset of the block in pixels (positive = down). */
  offsetYPx: number;
  scale: number;
  /** TYPEWRITER: characters visible; otherwise the total. */
  visibleChars: number;
  /** LINE_BY_LINE: opacity of each line; otherwise 1. */
  lineAlpha: number[];
}

export function stateAt(tl: Timeline, plan: TextPlan, tMs: number): FrameState {
  let opacity = 1;
  let offsetYPx = 0;
  let scale = 1;
  if (tl.entry.kind !== "NONE" && tl.entry.ms > 0) {
    const p = clamp01(tMs / tl.entry.ms);
    opacity *= p;
    if (tl.entry.kind === "SLIDE_UP") offsetYPx += tl.slidePx * (1 - easeOutCubic(p));
    if (tl.entry.kind === "ZOOM_IN") scale = tl.zoomFrom + (1 - tl.zoomFrom) * easeOutCubic(p);
  }
  if (tl.exit.kind !== "NONE" && tl.exit.ms > 0) {
    const q = clamp01((tMs - (tl.durationMs - tl.exit.ms)) / tl.exit.ms);
    opacity *= 1 - q;
    if (tl.exit.kind === "SLIDE_DOWN") offsetYPx += tl.slidePx * easeInCubic(q);
  }
  let visibleChars = plan.totalChars;
  if (tl.reveal.kind === "TYPEWRITER") {
    visibleChars = 0;
    for (const s of tl.reveal.steps) if (tMs >= s.atMs) visibleChars = s.chars;
  }
  const lineAlpha = plan.lines.map((l, i) => (tl.reveal.kind === "LINE_BY_LINE" && l.length > 0 ? clamp01((tMs - (tl.reveal.lineStartsMs[i] ?? 0)) / tl.reveal.lineFadeMs) : 1));
  return { opacity, offsetYPx, scale, visibleChars, lineAlpha };
}
