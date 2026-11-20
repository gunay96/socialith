import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Test-only: real FFmpeg generates real sample media from synthetic sources, so the tests need no downloaded files. */
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
/** Real-FFmpeg tests run wherever FFmpeg exists; CI installs it and sets CI=true, so a missing FFmpeg there is a FAILURE, never a silent skip. */
export const runRealFfmpegTests = FFMPEG_AVAILABLE || process.env.CI === "true";

const ff = (args: string[]) => execFileSync(FFMPEG, ["-y", "-v", "error", ...args], { timeout: 120_000 });

export interface WorkerSampleMedia {
  /** 640x360 25 fps 2 s H.264 + AAC */
  video: string;
  /** 1080x1920 25 fps 3 s H.264, no audio */
  vertical: string;
  /** 800x600 */
  png: string;
  /** 1000x1000 */
  jpg: string;
  /** 3 s mono sine */
  wav: string;
  /** 2 s sine */
  mp3: string;
}

export function makeWorkerSampleMedia(dir: string): WorkerSampleMedia {
  mkdirSync(dir, { recursive: true });
  const m: WorkerSampleMedia = { video: join(dir, "a.mp4"), vertical: join(dir, "b.mp4"), png: join(dir, "c.png"), jpg: join(dir, "d.jpg"), wav: join(dir, "e.wav"), mp3: join(dir, "f.mp3") };
  ff(["-f", "lavfi", "-i", "testsrc=size=640x360:rate=25", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", m.video]);
  ff(["-f", "lavfi", "-i", "testsrc=size=1080x1920:rate=25", "-t", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", m.vertical]);
  ff(["-f", "lavfi", "-i", "testsrc=size=800x600", "-frames:v", "1", m.png]);
  ff(["-f", "lavfi", "-i", "testsrc2=size=1000x1000", "-frames:v", "1", "-q:v", "3", m.jpg]);
  ff(["-f", "lavfi", "-i", "sine=frequency=330:sample_rate=22050", "-t", "3", "-ac", "1", m.wav]);
  ff(["-f", "lavfi", "-i", "sine=frequency=550:sample_rate=44100", "-t", "2", "-c:a", "libmp3lame", m.mp3]);
  writeFileSync(join(dir, "marker"), "x");
  return m;
}