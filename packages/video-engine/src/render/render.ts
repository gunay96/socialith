import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { buildTimeline, decideOutput, planSubtitles, planText, textRenderProblem, type EffectiveValues, type SubtitlePlan, type TextPlan, type Timeline } from "@socialith/studio";
import { buildRenderCommand, type OutputExpectation } from "./command.js";
import { resolveFontFace, type FontResolution } from "./fonts.js";
import { assessReadability, sampleBackdrop, type Readability } from "./readability.js";
import { filterScriptFlag, runRender } from "./runner.js";
import { validateOutput, type OutputValidation } from "./validate.js";

/** The job cannot be rendered as asked, and the reason is something a person can fix (nothing was run). */
export class RenderRefusedError extends Error {
  constructor(
    readonly code: "UNSUPPORTED_TEXT" | "TEXT_DOES_NOT_FIT" | "SOURCE_UNUSABLE" | "FONT_UNAVAILABLE",
    message: string,
    readonly remedy: string,
  ) {
    super(message);
    this.name = "RenderRefusedError";
  }
}

/** FFmpeg ran but the file it wrote does not match what was promised. */
export class OutputInvalidError extends Error {
  constructor(
    message: string,
    readonly validation: OutputValidation,
  ) {
    super(message);
    this.name = "OutputInvalidError";
  }
}

export interface RenderSourceFacts {
  path: string;
  kind: "IMAGE" | "VIDEO";
  hasAudio: boolean;
  durationMs: number | null;
  width: number | null;
  height: number | null;
}

export interface ComposeInput {
  ffmpegPath: string;
  ffprobePath: string;
  /** The job's own directory (the caller creates and removes it). */
  workDir: string;
  source: RenderSourceFacts;
  values: EffectiveValues;
  text: string;
  language: string | null;
  outputPath: string;
  fontDirs?: string[];
  x264?: { preset: string; crf: number };
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Real progress: milliseconds of output produced so far, of the total that will be produced. Not called for stills. */
  onProgress?: (producedMs: number, totalMs: number) => void;
  /** Called when the work moves to its next phase, for the task's stage text. */
  onStage?: (stage: string) => void;
}

export interface ComposePlanOnly {
  outputKind: "VIDEO" | "IMAGE";
  durationMs: number;
  values: EffectiveValues;
  plan: TextPlan;
  timeline: Timeline;
  subtitles: SubtitlePlan;
  fonts: FontResolution;
  warnings: string[];
}

export interface ComposeResult extends ComposePlanOnly {
  expect: OutputExpectation;
  validation: OutputValidation;
  readability: Readability | null;
  elapsedMs: number;
  filtergraph: string;
}

/**
 * Everything decided BEFORE FFmpeg runs, and refused early with a reason if it cannot work: the output kind and length,
 * the real font (with a reported fallback), the text plan (characters the font cannot draw, text that cannot fit),
 * the motion timeline and the subtitles. Pure apart from looking for the font file.
 */
export function planComposition(input: Pick<ComposeInput, "source" | "values" | "text" | "language" | "fontDirs">): ComposePlanOnly {
  const { source } = input;
  const warnings: string[] = [];
  const decision = decideOutput(input.values, source);
  if (!decision.ok) throw new RenderRefusedError(decision.code, decision.message, decision.remedy);
  const { outputKind, durationMs } = decision;
  warnings.push(...decision.warnings);

  let fonts: FontResolution;
  try {
    fonts = resolveFontFace(input.values.font, input.values.weight, input.fontDirs ? { dirs: input.fontDirs } : {});
  } catch (err) {
    throw new RenderRefusedError("FONT_UNAVAILABLE", err instanceof Error ? err.message : "No font could be found.", "An administrator must install the font packages on the worker (fonts-dejavu-core and fonts-liberation), or set FONT_DIRS.");
  }
  if (fonts.note) warnings.push(fonts.note);
  const values: EffectiveValues = { ...input.values, font: fonts.used.fontId, weight: fonts.used.weight };

  const plan = planText({ text: input.text, language: input.language, values });
  const problem = textRenderProblem(plan);
  if (problem) throw new RenderRefusedError(problem.code, problem.message, problem.remedy);
  warnings.push(...plan.adjustments);

  const still = outputKind === "IMAGE";
  const anyMotion = input.values.entryAnimation !== "NONE" || input.values.exitAnimation !== "NONE" || input.values.textAnimation !== "NONE";
  if (still && anyMotion) warnings.push("The recipe has motion, but a still image cannot move, so the text is shown complete. Set a fixed length in the recipe to render a video.");
  if (still && input.values.subtitlesEnabled) warnings.push("Subtitles are not drawn on a still image.");
  const timeline = buildTimeline(values, plan, durationMs, { still });
  const subtitles = still ? { enabled: false, fontSizePx: 0, stepPx: 0, cues: [] } : planSubtitles({ text: input.text, language: input.language, values, plan, durationMs });
  if (source.width && source.height && (source.width < plan.frame.width * 0.75 || source.height < plan.frame.height * 0.75) && input.values.fit === "COVER") {
    warnings.push(`The source (${source.width} x ${source.height}) is smaller than the ${plan.frame.width} x ${plan.frame.height} output and is enlarged, so it can look soft.`);
  }
  return { outputKind, durationMs, values, plan, timeline, subtitles, fonts, warnings };
}

/** Plans, renders with FFmpeg, and validates. Throws RenderRefusedError / RenderFailedError / RenderCancelledError / RenderTimeoutError / OutputInvalidError. */
export async function composeAndRender(input: ComposeInput): Promise<ComposeResult> {
  input.onStage?.("Planning the layout");
  const planned = planComposition(input);
  const { plan, values } = planned;

  input.onStage?.("Checking the picture behind the text");
  let readability: Readability | null = null;
  if (plan.lines.some((l) => l.length > 0)) {
    try {
      const samples = await sampleBackdrop({ ffmpegPath: input.ffmpegPath, sourcePath: input.source.path, kind: input.source.kind, durationMs: input.source.durationMs ?? 0, values, plan });
      readability = assessReadability(samples, values.color, plan.background);
      if (readability.status === "LOW") planned.warnings.push(`The text may be hard to read on this picture (contrast ${readability.minContrast}:1, at least 3:1 is recommended). Choose a lighter or darker text color, a text background, or another picture.`);
    } catch {
      planned.warnings.push("The picture behind the text could not be measured, so readability was not checked.");
    }
  }

  const command = buildRenderCommand({
    source: { path: input.source.path, kind: input.source.kind, hasAudio: input.source.hasAudio },
    values,
    plan,
    timeline: planned.timeline,
    subtitles: planned.subtitles,
    output: { kind: planned.outputKind, path: input.outputPath, durationMs: planned.durationMs, fps: values.exportFps, imageFormat: values.imageFormat },
    fontFile: "font.ttf",
    filterScriptFlag: await filterScriptFlag(input.ffmpegPath),
    ...(input.x264 ? { x264: input.x264 } : {}),
  });

  await mkdir(dirname(input.outputPath), { recursive: true });
  input.onStage?.(planned.outputKind === "VIDEO" ? "Encoding the video" : "Rendering the image");
  const run = await runRender({
    ffmpegPath: input.ffmpegPath,
    workDir: input.workDir,
    command,
    fontSourcePath: planned.fonts.path,
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.onProgress && planned.outputKind === "VIDEO" ? { onProgress: (ms: number) => input.onProgress!(Math.min(ms, planned.durationMs), planned.durationMs) } : {}),
  });

  // FFmpeg's last progress line can stop a few milliseconds short of the planned length (it reported 2987 of 3000 ms
  // on FFmpeg 6.1). It has now exited successfully, so the whole output is produced: report exactly that.
  if (input.onProgress && planned.outputKind === "VIDEO") input.onProgress(planned.durationMs, planned.durationMs);

  input.onStage?.("Checking the finished file");
  const validation = await validateOutput(input.ffmpegPath, input.ffprobePath, input.outputPath, command.expect);
  if (!validation.ok) throw new OutputInvalidError(`The rendered file did not pass its checks: ${validation.problems.join("; ")}.`, validation);
  return { ...planned, expect: command.expect, validation, readability, elapsedMs: run.elapsedMs, filtergraph: command.filtergraph };
}
