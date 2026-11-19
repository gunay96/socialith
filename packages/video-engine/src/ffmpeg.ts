import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class FfmpegUnavailableError extends Error {
  /** An @socialith/types ERROR_CODES value — this package doesn't depend on @socialith/types, so the string is inlined rather than imported (callers like video-render.processor.ts already re-export/compare against the real constant). */
  readonly errorCode = "CONFIGURATION_ERROR";

  constructor(binaryPath: string, cause: unknown) {
    super(
      `FFmpeg binary "${binaryPath}" is not available (checked via "${binaryPath} -version"). ` +
        `Install FFmpeg and ensure it's on PATH, or set FFMPEG_PATH to its full path.`,
    );
    this.name = "FfmpegUnavailableError";
    this.cause = cause;
  }
}

/** Fails fast with a clear, actionable error rather than letting a real render job crash deep inside execFile. */
export async function assertFfmpegAvailable(binaryPath: string): Promise<void> {
  try {
    await execFileAsync(binaryPath, ["-version"]);
  } catch (err) {
    throw new FfmpegUnavailableError(binaryPath, err);
  }
}

/**
 * Real FFmpeg invocation — extracts a single frame as a thumbnail. This is
 * the one VideoRenderOperation this phase implements for real (see
 * schema.prisma's VideoRenderOperation comment); crop/subtitles/
 * intro-outro are future operations, not stubbed here.
 * `-ss 00:00:00.5` seeks half a second in so a 1-frame test clip (or a
 * video that opens on a black frame) still yields a usable thumbnail;
 * `-frames:v 1` stops after the first decoded frame instead of encoding
 * the whole input.
 */
export async function extractThumbnail(binaryPath: string, sourcePath: string, outputPath: string): Promise<void> {
  await execFileAsync(binaryPath, [
    "-y",
    "-ss",
    "00:00:00.5",
    "-i",
    sourcePath,
    "-frames:v",
    "1",
    "-q:v",
    "2",
    outputPath,
  ]);
}
