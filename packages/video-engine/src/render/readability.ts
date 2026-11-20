import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { EffectiveValues, TextPlan } from "@socialith/studio";
import { baseFitFilter } from "./command.js";

const execFileAsync = promisify(execFile);

/**
 * Is the text readable on THIS picture? The renderer looks at the pixels behind the text block (a few moments of the
 * source, reduced to their average colour) and computes the WCAG contrast ratio against the text colour, with the
 * recipe's own background box or band blended in when there is one. It is a measurement of the average, so it is a
 * warning, never a refusal: a shadow or a busy picture can make text easier or harder to read than the average says.
 */
export interface ReadabilitySample {
  atMs: number;
  rgb: [number, number, number];
  contrast: number;
}

export interface Readability {
  status: "GOOD" | "FAIR" | "LOW";
  minContrast: number;
  samples: ReadabilitySample[];
  /** "GOOD" at 4.5:1 or more, "FAIR" at 3:1 (large text), else "LOW". */
  thresholds: { good: 4.5; fair: 3 };
}

const channel = (c: number): number => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};
export const luminance = (rgb: [number, number, number]): number => 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
export function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
export const parseHex = (hex: string): [number, number, number] => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];

export function assessReadability(samples: { atMs: number; rgb: [number, number, number] }[], textColor: string, background: TextPlan["background"]): Readability {
  const text = parseHex(textColor);
  const bg = parseHex(background.color);
  const out: ReadabilitySample[] = samples.map((s) => {
    const behind: [number, number, number] = background.mode === "NONE" ? s.rgb : [0, 1, 2].map((i) => Math.round(bg[i]! * background.opacity + s.rgb[i]! * (1 - background.opacity))) as [number, number, number];
    return { atMs: s.atMs, rgb: behind, contrast: Number(contrastRatio(text, behind).toFixed(2)) };
  });
  const min = out.length ? Math.min(...out.map((s) => s.contrast)) : 21;
  return { status: min >= 4.5 ? "GOOD" : min >= 3 ? "FAIR" : "LOW", minContrast: min, samples: out, thresholds: { good: 4.5, fair: 3 } };
}

/** The average colour behind the text block at a few moments of the source, measured with FFmpeg. */
export async function sampleBackdrop(opts: { ffmpegPath: string; sourcePath: string; kind: "IMAGE" | "VIDEO"; durationMs: number; values: EffectiveValues; plan: TextPlan }): Promise<{ atMs: number; rgb: [number, number, number] }[]> {
  const { plan } = opts;
  const times = opts.kind === "IMAGE" ? [0] : [0.1, 0.5, 0.9].map((f) => Math.round(opts.durationMs * f));
  const region = `crop=${plan.outer.width}:${plan.outer.height}:${plan.outer.left}:${plan.outer.top},scale=1:1:flags=area,format=rgb24`;
  const out: { atMs: number; rgb: [number, number, number] }[] = [];
  for (const atMs of times) {
    const args = ["-v", "error", ...(opts.kind === "VIDEO" ? ["-ss", (atMs / 1000).toFixed(3)] : []), "-i", opts.sourcePath, "-frames:v", "1", "-vf", `${baseFitFilter(opts.values, plan.frame.width, plan.frame.height)},${region}`, "-f", "rawvideo", "-"];
    const { stdout } = await execFileAsync(opts.ffmpegPath, args, { encoding: "buffer", timeout: 60_000, maxBuffer: 1024 });
    if (stdout.length >= 3) out.push({ atMs, rgb: [stdout[0]!, stdout[1]!, stdout[2]!] });
  }
  return out;
}
