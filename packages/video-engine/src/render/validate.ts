import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";
import type { OutputExpectation } from "./command.js";

const execFileAsync = promisify(execFile);

export interface OutputCheck {
  name: string;
  ok: boolean;
  expected: string;
  actual: string;
}

export interface OutputValidation {
  ok: boolean;
  checks: OutputCheck[];
  /** Plain sentences for every check that failed. */
  problems: string[];
  facts: { container: string | null; videoCodec: string | null; pixelFormat: string | null; width: number | null; height: number | null; durationMs: number | null; fps: number | null; audioCodec: string | null; sizeBytes: number };
}

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  pix_fmt?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  duration?: string;
}

function fraction(s: string | undefined): number | null {
  if (!s) return null;
  const [a, b] = s.split("/").map(Number);
  return a !== undefined && b ? a / b : Number.isFinite(a) ? (a as number) : null;
}

/**
 * Checks what FFmpeg actually wrote against what the plan promised: the file exists and is not empty, container, video
 * codec, pixel format, dimensions, frame rate, duration, audio (present with AAC when the source had audio, absent
 * otherwise), and that the whole file decodes without a single error. A render that fails any check is a failed job,
 * never a "ready" asset.
 */
export async function validateOutput(ffmpegPath: string, ffprobePath: string, path: string, expect: OutputExpectation): Promise<OutputValidation> {
  const checks: OutputCheck[] = [];
  const add = (name: string, ok: boolean, expected: string, actual: string) => checks.push({ name, ok, expected, actual });

  const { size } = await stat(path).catch(() => ({ size: 0 }));
  add("file written", size > 0, "a non-empty file", `${size} bytes`);

  let streams: ProbeStream[] = [];
  let formatName: string | null = null;
  let durationS: number | null = null;
  try {
    const { stdout } = await execFileAsync(ffprobePath, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
    const parsed = JSON.parse(stdout) as { streams?: ProbeStream[]; format?: { format_name?: string; duration?: string } };
    streams = parsed.streams ?? [];
    formatName = parsed.format?.format_name ?? null;
    durationS = parsed.format?.duration ? Number(parsed.format.duration) : null;
  } catch {
    add("readable by ffprobe", false, "a readable media file", "ffprobe could not read it");
  }
  const video = streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");
  const fps = fraction(video?.avg_frame_rate);

  add("video stream", Boolean(video), "one video stream", video ? "present" : "missing");
  add("video codec", video?.codec_name === expect.videoCodec, expect.videoCodec, video?.codec_name ?? "none");
  if (expect.kind === "VIDEO") {
    add("container", Boolean(formatName?.includes("mp4")), "mp4", formatName ?? "unknown");
    add("pixel format", video?.pix_fmt === "yuv420p", "yuv420p", video?.pix_fmt ?? "unknown");
    const tolerance = Math.max(250, expect.durationMs * 0.03);
    const actualMs = durationS === null ? null : durationS * 1000;
    add("duration", actualMs !== null && Math.abs(actualMs - expect.durationMs) <= tolerance, `${(expect.durationMs / 1000).toFixed(2)} s (within ${(tolerance / 1000).toFixed(2)} s)`, actualMs === null ? "unknown" : `${(actualMs / 1000).toFixed(2)} s`);
    add("frame rate", fps !== null && Math.abs(fps - expect.fps) <= 0.5, `${expect.fps} fps`, fps === null ? "unknown" : `${fps.toFixed(2)} fps`);
    add("audio", expect.hasAudio ? audio?.codec_name === "aac" : !audio, expect.hasAudio ? "AAC audio kept from the source" : "no audio (the source has none)", audio ? (audio.codec_name ?? "audio") : "none");
  }
  add("dimensions", video?.width === expect.width && video?.height === expect.height, `${expect.width} x ${expect.height}`, video ? `${video.width} x ${video.height}` : "unknown");

  // integrity: decode every frame; any message on stderr means the file is damaged
  let decodeProblem = "";
  try {
    const { stderr } = await execFileAsync(ffmpegPath, ["-v", "error", "-xerror", "-i", path, "-f", "null", "-"], { timeout: 10 * 60_000, maxBuffer: 8 * 1024 * 1024 });
    decodeProblem = stderr.trim();
  } catch (err) {
    decodeProblem = String((err as { stderr?: string }).stderr ?? err).trim().slice(0, 300) || "decoding failed";
  }
  add("decodes without errors", decodeProblem === "", "no decoding errors", decodeProblem === "" ? "none" : decodeProblem.slice(0, 160));

  const problems = checks.filter((c) => !c.ok).map((c) => `${c.name}: expected ${c.expected}, found ${c.actual}`);
  return {
    ok: problems.length === 0,
    checks,
    problems,
    facts: { container: formatName, videoCodec: video?.codec_name ?? null, pixelFormat: video?.pix_fmt ?? null, width: video?.width ?? null, height: video?.height ?? null, durationMs: durationS === null ? null : Math.round(durationS * 1000), fps, audioCodec: audio?.codec_name ?? null, sizeBytes: size },
  };
}
