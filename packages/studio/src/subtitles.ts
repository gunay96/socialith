import { DEFAULT_FONT_ID } from "./fonts.js";
import { faceFor, measureLine, wrapText } from "./font-metrics.js";
import { POSITION_CENTER_PCT } from "./layout.js";
import type { EffectiveValues } from "./recipe-resolve.js";
import { safeAreaPx } from "./safe-area.js";
import { applyTransform, baselineOffset, type TextPlan } from "./text-plan.js";
import { splitIntoCues } from "./layout.js";

/**
 * Subtitles generated from the TEXT only: the text is cut into cues of at most `wordsPerCue` words, shown one after
 * another across the clip. Nothing is transcribed from the audio and nothing is timed to speech (Socialith has no
 * speech recognition); the cues are evenly spaced. Each cue is wrapped to the frame with the real font's widths.
 */
export interface SubtitleLine {
  text: string;
  baselinePx: number;
  widthPx: number;
  leftPx: number;
  topPx: number;
}

export interface SubtitleCue {
  index: number;
  startMs: number;
  endMs: number;
  lines: SubtitleLine[];
  /** Padding of the dark box behind each line. */
  boxPaddingPx: number;
}

export interface SubtitlePlan {
  enabled: boolean;
  fontSizePx: number;
  stepPx: number;
  cues: SubtitleCue[];
}

export const MIN_CUE_MS = 700;

export function planSubtitles(input: { text: string; language: string | null; values: EffectiveValues; plan: TextPlan; durationMs: number }): SubtitlePlan {
  const { values: v, plan } = input;
  if (!v.subtitlesEnabled) return { enabled: false, fontSizePx: 0, stepPx: 0, cues: [] };
  const face = faceFor(v.font, v.weight) ?? faceFor(DEFAULT_FONT_ID, v.weight)!;
  const frame = plan.frame;
  const safe = safeAreaPx(v.aspectRatio, frame);
  const fontSizePx = Math.max(16, Math.round(Math.max(0.03 * frame.height, 0.55 * plan.fontSizePx)));
  const stepPx = Math.round(fontSizePx * 1.25);
  const boxPaddingPx = v.subtitlesBackground ? Math.round(fontSizePx * 0.25) : 0;
  const maxWidth = frame.width - safe.left - safe.right - 2 * boxPaddingPx;
  const text = applyTransform(input.text.replace(/\s+/g, " ").trim(), v.transform, input.language);
  const cueTexts = splitIntoCues(text, v.subtitlesWordsPerCue);
  const perCue = Math.max(MIN_CUE_MS, Math.floor(input.durationMs / Math.max(1, cueTexts.length)));
  const centerY = (POSITION_CENTER_PCT[v.subtitlesPosition] / 100) * frame.height;
  const cues: SubtitleCue[] = [];
  cueTexts.forEach((cueText, index) => {
    const startMs = index * perCue;
    if (startMs >= input.durationMs) return; // more cues than the clip can show: the rest are dropped, not squeezed
    const wrapped = wrapText(face, cueText, fontSizePx, maxWidth).lines;
    const blockHeight = wrapped.length * stepPx;
    const top = Math.min(Math.max(Math.round(centerY - blockHeight / 2), safe.top), frame.height - safe.bottom - blockHeight);
    cues.push({
      index,
      startMs,
      endMs: Math.min(input.durationMs, startMs + perCue),
      boxPaddingPx,
      lines: wrapped.map((l, i) => {
        const widthPx = measureLine(face, l, fontSizePx);
        const lineTop = top + i * stepPx;
        return { text: l, widthPx, leftPx: Math.round((frame.width - widthPx) / 2), topPx: lineTop, baselinePx: lineTop + baselineOffset(face, fontSizePx, stepPx) };
      }),
    });
  });
  return { enabled: true, fontSizePx, stepPx, cues };
}
