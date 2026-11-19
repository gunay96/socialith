import { join } from "node:path";
import { extractThumbnail } from "./ffmpeg.js";

export interface VideoOperationContext {
  ffmpegPath: string;
  sourcePath: string;
  /** A real, already-created temp directory (caller owns cleanup — see video-render.processor.ts). */
  outputDir: string;
}

export interface VideoOperationResult {
  outputPath: string;
  /** Matches @socialith/database's AssetType enum, kept as a plain string here so this package never has to depend on @socialith/database. */
  assetType: string;
  contentType: string;
}

export type VideoOperationHandler = (ctx: VideoOperationContext) => Promise<VideoOperationResult>;

/**
 * The one dispatch point video-render.processor.ts calls through — adding
 * a new VideoRenderOperation (schema.prisma) means adding one entry here,
 * never touching the processor itself. Each future operation's real
 * ffmpeg invocation is documented inline where it would go, per Phase 10
 * §11 ("architect for extensibility, not necessarily fully implement"):
 *
 * - RESIZE / PLATFORM_EXPORT: `-vf` with presets.ts's buildScalePadFilter()
 *   for the target PlatformExportPreset, `-c:v libx264 -r <fps> -b:v
 *   <targetBitrateKbps>k -c:a aac`. PLATFORM_EXPORT additionally trims to
 *   maxDurationSec via `-t`.
 * - CROP: `-vf "crop=w:h:x:y"` with caller-supplied crop coordinates.
 * - SUBTITLES: `-vf "subtitles=<path-to-srt-or-vtt>"` (burned-in) or a
 *   `-map` soft-subtitle stream copy, depending on whether the target
 *   platform supports soft captions.
 * - INTRO_OUTRO: ffmpeg's `concat` demuxer (a generated file list of
 *   intro/source/outro segments, all pre-normalized to the same
 *   codec/resolution first — concat requires matching parameters).
 * - WATERMARK: `-i <logo.png> -filter_complex overlay=<x>:<y>`.
 * - AUDIO_REPLACE: `-i <new-audio> -map 0:v -map 1:a -c:v copy -shortest`.
 *   Only meaningful once (if) a platform's real API supports attaching a
 *   Sound at all — see tiktok.provider.ts's describeSoundCapability for
 *   why this isn't wired to Sound today.
 *
 * None of the above are implemented — only THUMBNAIL (Phase 07) is real.
 * Adding one is: write the handler using the real ffmpeg flags above,
 * register it in this map, add the enum value to schema.prisma.
 */
export const VIDEO_OPERATIONS: Record<string, VideoOperationHandler> = {
  THUMBNAIL: async (ctx) => {
    const outputPath = join(ctx.outputDir, "thumbnail.png");
    await extractThumbnail(ctx.ffmpegPath, ctx.sourcePath, outputPath);
    return { outputPath, assetType: "THUMBNAIL", contentType: "image/png" };
  },
};

export function resolveVideoOperation(operation: string): VideoOperationHandler | undefined {
  return VIDEO_OPERATIONS[operation];
}
