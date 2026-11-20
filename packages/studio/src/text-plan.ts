import { DEFAULT_FONT_ID } from "./fonts.js";
import { faceFor, measureLine, wrapText, type Face } from "./font-metrics.js";
import { POSITION_CENTER_PCT, exportSize } from "./layout.js";
import type { EffectiveValues } from "./recipe-resolve.js";
import { safeAreaPx } from "./safe-area.js";

/**
 * Where every line of the text goes, in pixels of the output frame. This is the ONE answer used by the browser preview
 * and by the renderer, so line breaks, sizes and positions cannot drift apart:
 *   1. the letter case is applied (Turkish-aware),
 *   2. the text is wrapped to the block width with the real font's advance widths,
 *   3. if it does not fit the safe area the font size is reduced (to at most 60 % of what was asked),
 *   4. the block is placed where the recipe says and moved, if needed, to stay inside the safe area.
 * Everything that was adjusted is reported; nothing is changed silently.
 */
export const LINE_HEIGHT_FACTOR = 1.2;
const MIN_FONT_SHRINK = 0.6;
const MIN_FONT_PX = 12;

export interface PlannedLine {
  text: string;
  /** Measured width in pixels (advance widths, no kerning). */
  widthPx: number;
  /** Left edge of the line in frame pixels, for its alignment. */
  leftPx: number;
  /** Top of the line's box in frame pixels (each line box is `stepPx` high). */
  topPx: number;
  /** Where the letters sit: the baseline in frame pixels (the font's content area is centred in the line box). */
  baselinePx: number;
  /** How many characters (code points) came before this line, and how many it has: the reveal animations count these. */
  startChar: number;
  length: number;
}

export interface TextPlan {
  frame: { width: number; height: number };
  fontId: string;
  weight: "REGULAR" | "BOLD";
  requestedFontSizePx: number;
  fontSizePx: number;
  /** Distance between consecutive line tops. */
  stepPx: number;
  lines: PlannedLine[];
  totalChars: number;
  align: "LEFT" | "CENTER" | "RIGHT";
  background: { mode: "NONE" | "BOX" | "BAND"; color: string; opacity: number; paddingPx: number };
  /** The outer rectangle (the background, when there is one) and the area text is wrapped into. */
  outer: { left: number; top: number; width: number; height: number };
  inner: { left: number; width: number };
  safeArea: { top: number; bottom: number; left: number; right: number; status: "ASSUMED" };
  /** What was adjusted, in plain words. Empty when the recipe was followed exactly. */
  adjustments: string[];
  /** Characters the font cannot draw (the job is refused when there are any). */
  unsupported: string[];
  rightToLeft: boolean;
  /** False when the text cannot be made to fit even at the smallest allowed size. */
  fits: boolean;
}

/** Letter case. Turkish and Azerbaijani have a dotted and a dotless i, so their uppercase of i is the dotted capital I (not I). */
/** Distance from the top of a line box to the baseline: the font's ascent plus half of the room the line box has beyond the font's content area. */
export function baselineOffset(face: Face, fontSizePx: number, stepPx: number): number {
  const ascent = (face.data.ascent * fontSizePx) / 1000;
  const content = ((face.data.ascent + face.data.descent) * fontSizePx) / 1000;
  return Math.round(ascent + (stepPx - content) / 2);
}

export function applyTransform(text: string, transform: "NONE" | "UPPERCASE", language: string | null): string {
  if (transform !== "UPPERCASE") return text;
  const lang = (language ?? "").toLowerCase().split("-")[0];
  return lang === "tr" || lang === "az" ? text.toLocaleUpperCase("tr") : text.toLocaleUpperCase("en");
}

export function planText(input: { text: string; language: string | null; values: EffectiveValues }): TextPlan {
  const { values: v } = input;
  const frame = exportSize(v.aspectRatio, v.exportResolution);
  const safe = safeAreaPx(v.aspectRatio, frame);
  const adjustments: string[] = [];
  const face: Face = faceFor(v.font, v.weight) ?? faceFor(DEFAULT_FONT_ID, v.weight)!;
  const text = applyTransform(input.text, v.transform, input.language);

  const requestedFontSizePx = Math.max(MIN_FONT_PX, Math.round((v.sizePct / 100) * frame.height));
  const usableWidth = frame.width - safe.left - safe.right;
  const requestedBlockWidth = Math.round((v.maxWidthPct / 100) * frame.width);
  const blockWidth = Math.min(requestedBlockWidth, usableWidth);
  if (blockWidth < requestedBlockWidth) adjustments.push("The text block is narrower than the recipe asks so it stays inside the safe area at the sides.");

  const mode = v.backgroundMode;
  const padding = mode === "NONE" ? 0 : Math.round((v.backgroundPaddingPct / 100) * frame.height);
  const innerWidth = mode === "BOX" ? Math.max(40, blockWidth - 2 * padding) : blockWidth;
  const outerWidth = mode === "BAND" ? frame.width : blockWidth;
  const availableHeight = frame.height - safe.top - safe.bottom;

  let fontSizePx = requestedFontSizePx;
  let wrapped = wrapText(face, text, fontSizePx, innerWidth);
  const heightFor = (px: number, n: number) => n * Math.round(px * LINE_HEIGHT_FACTOR) + 2 * padding;
  const smallest = Math.max(MIN_FONT_PX, Math.ceil(requestedFontSizePx * MIN_FONT_SHRINK));
  while (heightFor(fontSizePx, wrapped.lines.length) > availableHeight && fontSizePx > smallest) {
    fontSizePx = Math.max(smallest, Math.floor(fontSizePx * 0.95));
    wrapped = wrapText(face, text, fontSizePx, innerWidth);
  }
  const stepPx = Math.round(fontSizePx * LINE_HEIGHT_FACTOR);
  const outerHeight = heightFor(fontSizePx, wrapped.lines.length);
  const fits = outerHeight <= availableHeight;
  if (fontSizePx < requestedFontSizePx) adjustments.push(`The font size was reduced from ${requestedFontSizePx} to ${fontSizePx} px so the text fits the safe area.`);

  const requestedCenter = (POSITION_CENTER_PCT[v.vertical] / 100) * frame.height + (v.offsetPct / 100) * frame.height;
  const wantedTop = Math.round(requestedCenter - outerHeight / 2);
  const minTop = safe.top;
  const maxTop = frame.height - safe.bottom - outerHeight;
  const top = maxTop < minTop ? minTop : Math.min(Math.max(wantedTop, minTop), maxTop);
  if (top !== wantedTop) adjustments.push(`The text was moved ${top < wantedTop ? "up" : "down"} by ${Math.abs(wantedTop - top)} px to stay inside the safe area.`);

  const outerLeft = Math.round((frame.width - outerWidth) / 2);
  const innerLeft = Math.round((frame.width - innerWidth) / 2);
  let startChar = 0;
  const lines: PlannedLine[] = wrapped.lines.map((l, i) => {
    const widthPx = measureLine(face, l, fontSizePx);
    const leftPx = v.align === "LEFT" ? innerLeft : v.align === "RIGHT" ? Math.round(innerLeft + innerWidth - widthPx) : Math.round(innerLeft + (innerWidth - widthPx) / 2);
    const length = [...l].length;
    const lineTop = top + padding + i * stepPx;
    const line = { text: l, widthPx, leftPx, topPx: lineTop, baselinePx: lineTop + baselineOffset(face, fontSizePx, stepPx), startChar, length };
    startChar += length;
    return line;
  });

  return {
    frame,
    fontId: faceFor(v.font, v.weight) ? v.font : DEFAULT_FONT_ID,
    weight: v.weight,
    requestedFontSizePx,
    fontSizePx,
    stepPx,
    lines,
    totalChars: startChar,
    align: v.align,
    background: { mode, color: v.backgroundColor, opacity: v.backgroundOpacityPct / 100, paddingPx: padding },
    outer: { left: outerLeft, top, width: outerWidth, height: outerHeight },
    inner: { left: innerLeft, width: innerWidth },
    safeArea: { ...safe, status: "ASSUMED" },
    adjustments,
    unsupported: wrapped.unsupported,
    rightToLeft: wrapped.rightToLeft,
    fits,
  };
}

export interface TextRenderProblem {
  code: "UNSUPPORTED_TEXT" | "TEXT_DOES_NOT_FIT";
  message: string;
  remedy: string;
}

/** Why a planned text cannot be rendered, or null. The same words are shown before a render is accepted and when the renderer refuses. */
export function textRenderProblem(plan: Pick<TextPlan, "rightToLeft" | "unsupported" | "fits">): TextRenderProblem | null {
  if (plan.rightToLeft) return { code: "UNSUPPORTED_TEXT", message: "This text is written right to left (Arabic, Hebrew and similar), which the renderer cannot shape or order yet.", remedy: "Use a text in a left-to-right script for rendering." };
  if (plan.unsupported.length > 0) {
    const shown = plan.unsupported.slice(0, 8).map((c) => `"${c}" (U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")})`).join(", ");
    return { code: "UNSUPPORTED_TEXT", message: `The font cannot draw these characters: ${shown}. Emoji and symbols outside the supported alphabets would appear as empty boxes.`, remedy: "Remove those characters from the text, or choose a different text." };
  }
  if (!plan.fits) return { code: "TEXT_DOES_NOT_FIT", message: "The text is too long to fit the frame, even at the smallest allowed size.", remedy: "Shorten the text, choose a larger frame (for example 16:9 or 1:1 for long texts), or lower the font size in the recipe." };
  return null;
}
