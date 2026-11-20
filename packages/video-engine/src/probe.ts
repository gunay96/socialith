import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Everything the library records about a media file. Every field is MEASURED by ffprobe; a fact ffprobe did not report
 * is `null`, never a default or a guess (this is what closes TD-49).
 */
export interface MediaFacts {
  kind: "video" | "image" | "audio" | "unknown";
  /** Effective (display) size: already swapped for 90/270-degree rotated phone videos. */
  width: number | null;
  height: number | null;
  rotation: number;
  /** "9:16", "16:9", "1:1", "4:5", ... a standard label when within 1 %, else a reduced ratio, else "1.85:1". */
  aspectRatio: string | null;
  aspectDecimal: number | null;
  durationMs: number | null;
  fps: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  hasAudio: boolean;
  bitrateKbps: number | null;
  container: string | null;
  sampleRate: number | null;
  channels: number | null;
  sizeBytes: number | null;
}

export class ProbeError extends Error {
  /** An @socialith/types ERROR_CODES-style code. */
  readonly errorCode: "CONFIGURATION_ERROR" | "INVALID_MEDIA";
  constructor(
    message: string,
    errorCode: "CONFIGURATION_ERROR" | "INVALID_MEDIA",
    readonly stderrTail?: string,
  ) {
    super(message);
    this.name = "ProbeError";
    this.errorCode = errorCode;
  }
}

const STANDARD_ASPECTS: [string, number][] = [
  ["9:16", 9 / 16],
  ["16:9", 16 / 9],
  ["1:1", 1],
  ["4:5", 4 / 5],
  ["5:4", 5 / 4],
  ["3:4", 3 / 4],
  ["4:3", 4 / 3],
  ["2:3", 2 / 3],
  ["3:2", 3 / 2],
  ["21:9", 21 / 9],
];

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/** A readable aspect ratio for a size: a standard label within 1 %, else the reduced ratio when small, else decimal. */
export function describeAspectRatio(width: number, height: number): { label: string; decimal: number } | null {
  if (!(width > 0) || !(height > 0)) return null;
  const decimal = width / height;
  for (const [label, value] of STANDARD_ASPECTS) {
    if (Math.abs(decimal - value) / value <= 0.01) return { label, decimal };
  }
  const d = gcd(width, height);
  const w = width / d;
  const h = height / d;
  return { label: w <= 32 && h <= 32 ? `${w}:${h}` : `${decimal.toFixed(2)}:1`, decimal };
}

function parseRate(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const [n, d] = value.split("/").map(Number);
  if (!Number.isFinite(n) || !Number.isFinite(d) || !d || n === 0) return null;
  return Math.round((n! / d!) * 1000) / 1000;
}

const num = (v: unknown): number | null => {
  const n = typeof v === "string" || typeof v === "number" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

interface RawStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  sample_rate?: string;
  channels?: number;
  duration?: string;
  tags?: Record<string, string>;
  disposition?: Record<string, number>;
  side_data_list?: { rotation?: number | string }[];
}

const IMAGE_FORMATS = ["image2", "png_pipe", "jpeg_pipe", "webp_pipe", "mjpeg", "gif", "bmp_pipe", "tiff_pipe"];

/** Pure: turns ffprobe's JSON (`-show_format -show_streams`) into MediaFacts. */
export function parseProbe(raw: unknown, sizeBytes: number | null = null): MediaFacts {
  const root = (raw ?? {}) as { format?: Record<string, string>; streams?: RawStream[] };
  const format = root.format ?? {};
  const streams = root.streams ?? [];
  // cover art in an MP3 is an "attached picture" video stream: not a video
  const video = streams.find((s) => s.codec_type === "video" && s.disposition?.attached_pic !== 1);
  const audio = streams.find((s) => s.codec_type === "audio");
  const formatName = format.format_name ?? null;

  let width = video?.width ?? null;
  let height = video?.height ?? null;
  const tagRotate = num(video?.tags?.rotate);
  const sideRotate = num(video?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation);
  const rotation = (((tagRotate ?? sideRotate ?? 0) % 360) + 360) % 360;
  if ((rotation === 90 || rotation === 270) && width && height) [width, height] = [height, width];

  const durationSeconds = num(format.duration) ?? num(video?.duration) ?? num(audio?.duration);
  const durationMs = durationSeconds !== null && durationSeconds > 0 ? Math.round(durationSeconds * 1000) : null;

  const isImageContainer = formatName !== null && IMAGE_FORMATS.some((f) => formatName.split(",").includes(f));
  let kind: MediaFacts["kind"] = "unknown";
  if (video && (isImageContainer || durationMs === null)) kind = "image";
  else if (video) kind = "video";
  else if (audio) kind = "audio";

  const aspect = width && height ? describeAspectRatio(width, height) : null;
  const bitRate = num(format.bit_rate);
  return {
    kind,
    width: width ?? null,
    height: height ?? null,
    rotation,
    aspectRatio: aspect?.label ?? null,
    aspectDecimal: aspect ? Math.round(aspect.decimal * 10_000) / 10_000 : null,
    durationMs: kind === "image" ? null : durationMs,
    fps: kind === "video" ? parseRate(video?.avg_frame_rate) ?? parseRate(video?.r_frame_rate) : null,
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    hasAudio: Boolean(audio),
    bitrateKbps: bitRate !== null ? Math.round(bitRate / 1000) : null,
    container: formatName,
    sampleRate: num(audio?.sample_rate),
    channels: audio?.channels ?? null,
    sizeBytes: sizeBytes ?? num(format.size),
  };
}

/** Runs ffprobe on a local file and returns the measured facts. Arguments are passed as an array: no shell, no injection. */
export async function probeMedia(ffprobePath: string, filePath: string, options: { timeoutMs?: number; sizeBytes?: number | null } = {}): Promise<MediaFacts> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(ffprobePath, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", "--", filePath], {
      timeout: options.timeoutMs ?? 60_000,
      maxBuffer: 20 * 1024 * 1024,
    }));
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };
    if (e.code === "ENOENT") {
      throw new ProbeError(`ffprobe "${ffprobePath}" was not found. Install FFmpeg (it includes ffprobe) or set FFPROBE_PATH.`, "CONFIGURATION_ERROR");
    }
    if (e.killed) throw new ProbeError("ffprobe took too long and was stopped.", "INVALID_MEDIA");
    throw new ProbeError("ffprobe could not read this file: it is damaged or not a media file.", "INVALID_MEDIA", (e.stderr ?? "").slice(-1500));
  }
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    throw new ProbeError("ffprobe returned an unreadable answer.", "INVALID_MEDIA");
  }
  return parseProbe(json, options.sizeBytes ?? null);
}

export async function assertFfprobeAvailable(ffprobePath: string): Promise<void> {
  try {
    await execFileAsync(ffprobePath, ["-version"], { timeout: 15_000 });
  } catch {
    throw new ProbeError(`ffprobe "${ffprobePath}" is not available. Install FFmpeg (it includes ffprobe) or set FFPROBE_PATH.`, "CONFIGURATION_ERROR");
  }
}
