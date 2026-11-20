import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";
import { probeMedia } from "./probe.js";

const execFileAsync = promisify(execFile);

/** A failed FFmpeg run, with the tail of its stderr for diagnosis (never shown to end users verbatim). */
export class FfmpegCommandError extends Error {
  constructor(
    message: string,
    readonly stderrTail: string,
  ) {
    super(message);
    this.name = "FfmpegCommandError";
  }
}

export async function runFfmpegOnce(ffmpegPath: string, args: string[], timeoutMs = 120_000): Promise<void> {
  try {
    await execFileAsync(ffmpegPath, args, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };
    if (e.code === "ENOENT") throw new FfmpegCommandError(`FFmpeg "${ffmpegPath}" was not found.`, "");
    throw new FfmpegCommandError(e.killed ? "FFmpeg took too long and was stopped." : "FFmpeg could not process this file.", (e.stderr ?? "").slice(-1500));
  }
}

export interface ThumbnailOptions {
  kind: "image" | "video";
  /** The thumbnail fits inside a square of this many pixels. */
  maxSide?: number;
  /** Video: where to take the frame; defaults to 10 % in, at most one second. */
  atMs?: number | null;
  /** Video duration when known, to keep the seek inside the file. */
  durationMs?: number | null;
}

export interface ThumbnailResult {
  width: number | null;
  height: number | null;
  sizeBytes: number;
}

/**
 * Writes a JPEG thumbnail. The source is read by FFmpeg from disk (never loaded into memory) and the original is never
 * modified. `scale=…:force_original_aspect_ratio=decrease` fits the picture in the box without distortion.
 */
export async function makeThumbnail(ffmpegPath: string, ffprobePath: string, sourcePath: string, outputPath: string, options: ThumbnailOptions): Promise<ThumbnailResult> {
  const side = options.maxSide ?? 480;
  const filter = `scale=${side}:${side}:force_original_aspect_ratio=decrease`;
  const seekMs = options.kind === "video" ? (options.atMs ?? Math.min(1000, Math.floor((options.durationMs ?? 0) * 0.1))) : 0;
  const args = ["-y", "-v", "error", ...(seekMs > 0 ? ["-ss", (seekMs / 1000).toFixed(3)] : []), "-i", sourcePath, "-frames:v", "1", "-vf", filter, "-q:v", "4", "-update", "1", outputPath];
  const fromStart = args.filter((_, i, a) => !(a[i] === "-ss" || a[i - 1] === "-ss"));
  // A seek past the end of a very short clip produces no frame: FFmpeg 5 exits 0 without writing a file, newer versions
  // exit with an error. Either way, retry from the start before giving up.
  const wroteFrame = async () => (await stat(outputPath).catch(() => null))?.size ?? 0;
  try {
    await runFfmpegOnce(ffmpegPath, args);
    if (seekMs > 0 && (await wroteFrame()) === 0) await runFfmpegOnce(ffmpegPath, fromStart);
  } catch (err) {
    if (seekMs > 0) await runFfmpegOnce(ffmpegPath, fromStart);
    else throw err;
  }
  const size = await wroteFrame();
  if (size === 0) throw new FfmpegCommandError("FFmpeg produced no frame for this file.", "");
  const facts = await probeMedia(ffprobePath, outputPath).catch(() => null);
  return { width: facts?.width ?? null, height: facts?.height ?? null, sizeBytes: size };
}
