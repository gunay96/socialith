import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Test-only helpers: real FFmpeg generates real sample media from synthetic sources (lavfi test patterns), so the
 * tests need no downloaded files and no checked-in binaries.
 */
export const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
export const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";

function works(bin: string): boolean {
  try {
    execFileSync(bin, ["-version"], { stdio: "ignore", timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}
export const FFMPEG_AVAILABLE = works(FFMPEG) && works(FFPROBE);

/**
 * Real-FFmpeg tests run wherever FFmpeg exists. CI installs it and sets CI=true, so a missing FFmpeg there is a FAILURE
 * (the tests must never be skipped silently in the place that is supposed to prove the renderer works).
 */
export const runRealFfmpegTests = FFMPEG_AVAILABLE || process.env.CI === "true";

function ff(args: string[]): void {
  execFileSync(FFMPEG, ["-y", "-v", "error", ...args], { timeout: 120_000 });
}

/**
 * Copies an MP4 and writes a 90-degree display matrix into its first track header (tkhd), which is exactly how a phone
 * marks a portrait clip. Done on the bytes because FFmpeg's `-display_rotation` option only exists from version 6, and
 * the worker image (Debian 12) ships 5.1.
 */
function copyWithDisplayRotation(source: string, target: string): void {
  const bytes = readFileSync(source);
  const at = bytes.indexOf("tkhd");
  if (at < 0) throw new Error("fixture: no tkhd box in the sample video");
  const version = bytes[at + 4];
  const matrix = at + 4 + (version === 1 ? 52 : 40);
  const fixed = [0, 0xffff0000, 0, 0x00010000, 0, 0, 0, 0, 0x40000000]; // a b u c d v x y w (16.16 / 2.30 fixed point)
  fixed.forEach((value, i) => bytes.writeUInt32BE(value, matrix + i * 4));
  writeFileSync(target, bytes);
}

export interface SampleMedia {
  dir: string;
  /** 640x360, 25 fps, 2 s, H.264 + AAC. */
  video: string;
  /** 1080x1920 (9:16), 25 fps, 3 s, H.264, no audio. */
  verticalVideo: string;
  /** The same 640x360 clip carrying a 90-degree display rotation (how a phone records a portrait clip). */
  rotatedVideo: string;
  /** 800x600 PNG. */
  png: string;
  /** 1000x1000 JPEG. */
  jpeg: string;
  /** 3 s mono sine wave. */
  wav: string;
  /** 2 s sine wave. */
  mp3: string;
  /** A text file pretending to be media. */
  notMedia: string;
}

export function makeSampleMedia(dir: string): SampleMedia {
  mkdirSync(dir, { recursive: true });
  const p = (name: string) => join(dir, name);
  const m: SampleMedia = {
    dir,
    video: p("sample.mp4"),
    verticalVideo: p("vertical.mp4"),
    rotatedVideo: p("rotated.mp4"),
    png: p("sample.png"),
    jpeg: p("sample.jpg"),
    wav: p("sample.wav"),
    mp3: p("sample.mp3"),
    notMedia: p("notes.mp4"),
  };
  ff(["-f", "lavfi", "-i", "testsrc=size=640x360:rate=25", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", m.video]);
  ff(["-f", "lavfi", "-i", "testsrc=size=1080x1920:rate=25", "-t", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", m.verticalVideo]);
  copyWithDisplayRotation(m.video, m.rotatedVideo);
  ff(["-f", "lavfi", "-i", "testsrc=size=800x600", "-frames:v", "1", m.png]);
  ff(["-f", "lavfi", "-i", "testsrc2=size=1000x1000", "-frames:v", "1", "-q:v", "3", m.jpeg]);
  ff(["-f", "lavfi", "-i", "sine=frequency=330:sample_rate=22050", "-t", "3", "-ac", "1", m.wav]);
  ff(["-f", "lavfi", "-i", "sine=frequency=550:sample_rate=44100", "-t", "2", "-c:a", "libmp3lame", m.mp3]);
  writeFileSync(m.notMedia, "this is not a video, just text\n".repeat(20));
  return m;
}
