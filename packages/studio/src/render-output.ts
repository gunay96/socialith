import type { EffectiveValues } from "./recipe-resolve.js";

/**
 * What a recipe applied to a source produces: a still image or a video, and how long. Decided in one place so the
 * preview, the API (before a render is accepted) and the renderer cannot disagree.
 *
 *   image + fixed length          -> a video of that length (no audio)
 *   image + "follow the source"   -> a still image
 *   video + "follow the source"   -> a video as long as the source
 *   video + fixed length          -> a video of that length, never longer than the source
 */
export const MIN_OUTPUT_MS = 500;

export interface OutputSource {
  kind: "IMAGE" | "VIDEO";
  durationMs: number | null;
}

export type OutputDecision =
  | { ok: true; outputKind: "VIDEO" | "IMAGE"; durationMs: number; warnings: string[] }
  | { ok: false; code: "SOURCE_UNUSABLE"; message: string; remedy: string };

export function decideOutput(values: Pick<EffectiveValues, "durationMode" | "durationSeconds">, source: OutputSource): OutputDecision {
  const warnings: string[] = [];
  if (source.kind === "IMAGE") {
    if (values.durationMode === "FIXED") return { ok: true, outputKind: "VIDEO", durationMs: Math.max(MIN_OUTPUT_MS, Math.round(values.durationSeconds * 1000)), warnings };
    return { ok: true, outputKind: "IMAGE", durationMs: 1000, warnings };
  }
  if (source.durationMs === null || source.durationMs <= 0) {
    return { ok: false, code: "SOURCE_UNUSABLE", message: "The length of the source video is not known.", remedy: "Use Re-analyze on the file in the Media Library, then render again." };
  }
  const wanted = values.durationMode === "FIXED" ? Math.round(values.durationSeconds * 1000) : source.durationMs;
  if (wanted > source.durationMs) warnings.push(`The recipe asks for ${(wanted / 1000).toFixed(1)} s but the video lasts ${(source.durationMs / 1000).toFixed(1)} s, so the result is as long as the video.`);
  return { ok: true, outputKind: "VIDEO", durationMs: Math.max(MIN_OUTPUT_MS, Math.min(wanted, source.durationMs)), warnings };
}
