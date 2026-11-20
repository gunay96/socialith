import type { AspectRatio, TextPosition } from "@socialith/publishing";
import type { EffectiveValues } from "./recipe-resolve.js";

/**
 * Where the text goes in the frame. The browser preview and (Phase 5C) the renderer both take their geometry from this
 * one function, so what the preview shows is what the settings mean. All positions are fractions of the frame, so they
 * hold at any resolution.
 */

/** Vertical CENTER of the text block, as a percentage of the frame height, for each named position. */
export const POSITION_CENTER_PCT: Record<TextPosition, number> = { TOP: 12, UPPER_THIRD: 28, CENTER: 50, LOWER_THIRD: 72, BOTTOM: 88 };

const RATIO: Record<AspectRatio, [number, number]> = { "9:16": [9, 16], "4:5": [4, 5], "1:1": [1, 1], "16:9": [16, 9] };

export function aspectDecimal(ratio: AspectRatio): number {
  const [w, h] = RATIO[ratio];
  return w / h;
}

/** Output size in pixels. "1080": 1080 wide for portrait and square frames, 1080 high for 16:9 (so 1080x1920, 1080x1350, 1080x1080, 1920x1080). */
export function exportSize(ratio: AspectRatio, resolution: "720" | "1080"): { width: number; height: number } {
  const short = Number(resolution);
  const [w, h] = RATIO[ratio];
  const even = (n: number) => Math.round(n / 2) * 2;
  return w >= h ? { width: even((short * w) / h), height: short } : { width: short, height: even((short * h) / w) };
}

export interface TextLayout {
  frame: { width: number; height: number };
  /** The text block: horizontally centred on the frame and `widthPct` wide; its vertical centre is `centerYPct`. */
  block: { widthPct: number; centerYPct: number; align: "LEFT" | "CENTER" | "RIGHT" };
  fontSizePx: number;
  /** Padding around the text inside its background, in pixels. */
  paddingPx: number;
  /** The background is as wide as the text block (BOX), or the full frame width (BAND), or absent. */
  background: { mode: "NONE" | "BOX" | "BAND"; color: string; opacity: number };
  subtitleCenterYPct: number;
}

export function computeLayout(v: EffectiveValues): TextLayout {
  const frame = exportSize(v.aspectRatio, v.exportResolution);
  const centerYPct = Math.min(96, Math.max(4, POSITION_CENTER_PCT[v.vertical] + v.offsetPct));
  return {
    frame,
    block: { widthPct: v.maxWidthPct, centerYPct, align: v.align },
    fontSizePx: Math.round((v.sizePct / 100) * frame.height),
    paddingPx: Math.round((v.backgroundPaddingPct / 100) * frame.height),
    background: { mode: v.backgroundMode, color: v.backgroundColor, opacity: v.backgroundOpacityPct / 100 },
    subtitleCenterYPct: POSITION_CENTER_PCT[v.subtitlesPosition],
  };
}

/** Splits a text into subtitle cues of at most `wordsPerCue` words (the same split the renderer will use). */
export function splitIntoCues(text: string, wordsPerCue: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const cues: string[] = [];
  for (let i = 0; i < words.length; i += Math.max(1, wordsPerCue)) cues.push(words.slice(i, i + wordsPerCue).join(" "));
  return cues;
}
