import { execFileSync } from "node:child_process";
import { FFMPEG, FFPROBE } from "./ffmpeg-fixtures.js";

/**
 * Test-only helpers for the rendering tests: synthetic sources (flat colours, so text is trivial to find) and frame
 * measurements. A rendered frame is read back with real FFmpeg and measured: where the text ink is, how much of it there
 * is, how many separate lines it forms. These measurements are what the "visual regression" assertions compare, because
 * they stay true across FFmpeg and FreeType versions where a pixel-exact image would not.
 */
export interface SolidVideoOptions {
  width: number;
  height: number;
  durationS: number;
  fps?: number;
  /** FFmpeg colour name or 0xRRGGBB. */
  color?: string;
  audio?: boolean;
  /** A 90-degree display rotation, written into the MP4 track header (a phone's portrait clip). */
  rotate90?: boolean;
}

function ff(args: string[]): void {
  execFileSync(FFMPEG, ["-y", "-v", "error", ...args], { timeout: 120_000 });
}

export function makeSolidVideo(path: string, o: SolidVideoOptions): void {
  const fps = o.fps ?? 24;
  const args = ["-f", "lavfi", "-i", `color=c=${o.color ?? "black"}:s=${o.width}x${o.height}:r=${fps}:d=${o.durationS}`];
  if (o.audio) args.push("-f", "lavfi", "-i", `sine=frequency=440:sample_rate=44100:duration=${o.durationS}`);
  args.push("-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p");
  if (o.audio) args.push("-c:a", "aac", "-shortest");
  args.push(path);
  ff(args);
}

export function makeSolidImage(path: string, o: { width: number; height: number; color?: string }): void {
  ff(["-f", "lavfi", "-i", `color=c=${o.color ?? "black"}:s=${o.width}x${o.height}`, "-frames:v", "1", path]);
}

export interface GrayFrame {
  width: number;
  height: number;
  data: Buffer;
}

/** One frame as 8-bit grey, at `atS` seconds (a still image ignores the time). */
export function readGrayFrame(path: string, width: number, height: number, atS = 0): GrayFrame {
  const data = execFileSync(FFMPEG, ["-v", "error", "-ss", atS.toFixed(3), "-i", path, "-frames:v", "1", "-pix_fmt", "gray", "-f", "rawvideo", "-"], { maxBuffer: width * height * 2 + 1024, timeout: 60_000 });
  if (data.length !== width * height) throw new Error(`expected ${width * height} bytes of frame data, got ${data.length}`);
  return { width, height, data };
}

export interface Ink {
  left: number;
  top: number;
  right: number;
  bottom: number;
  /** Number of pixels brighter than the threshold. */
  count: number;
  /** Vertical bands of rows that contain ink (one per text line, when lines are separated by blank rows). */
  bands: { top: number; bottom: number }[];
}

/** Where the text is: pixels brighter than `threshold` on a black background. */
export function measureInk(frame: GrayFrame, threshold = 40, region?: { top: number; bottom: number }): Ink {
  const { width, height, data } = frame;
  let left = width;
  let right = -1;
  let top = height;
  let bottom = -1;
  let count = 0;
  const rows: boolean[] = new Array<boolean>(height).fill(false);
  for (let y = region?.top ?? 0; y < (region?.bottom ?? height); y++) {
    for (let x = 0; x < width; x++) {
      if (data[y * width + x]! > threshold) {
        count++;
        rows[y] = true;
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  const bands: { top: number; bottom: number }[] = [];
  let start = -1;
  for (let y = 0; y <= height; y++) {
    if (y < height && rows[y]) {
      if (start < 0) start = y;
    } else if (start >= 0) {
      bands.push({ top: start, bottom: y - 1 });
      start = -1;
    }
  }
  return { left, top, right, bottom, count, bands };
}

/** The same row bands with bands closer than `gap` rows merged (accents and descenders touch the next line's tops). */
export function mergeBands(bands: { top: number; bottom: number }[], gap: number): { top: number; bottom: number }[] {
  const out: { top: number; bottom: number }[] = [];
  for (const b of bands) {
    const last = out.at(-1);
    if (last && b.top - last.bottom <= gap) last.bottom = b.bottom;
    else out.push({ ...b });
  }
  return out;
}

export function probeJson(path: string): { streams: { codec_type: string; codec_name: string; width?: number; height?: number }[]; format: { duration: string; format_name: string } } {
  return JSON.parse(execFileSync(FFPROBE, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path], { timeout: 30_000 }).toString("utf8")) as ReturnType<typeof probeJson>;
}
