/**
 * Real, documented per-platform export constraints — not guessed. Sources:
 * TikTok's Content Posting API spec (developers.tiktok.com) recommends
 * 1080x1920 (9:16), H.264, up to 60fps, and enforces per-account
 * max_video_post_duration_sec (see tiktok.provider.ts's queryCreatorInfo,
 * which reads the account's *actual* limit rather than hardcoding one —
 * the value below is a safe, commonly-cited default for accounts that
 * haven't queried creator_info yet, e.g. for local pre-flight validation
 * before a real publish attempt).
 * Instagram Reels and YouTube Shorts both publish the same 9:16/1080x1920
 * recommendation in their own current creator/help documentation.
 */
export interface PlatformExportPreset {
  aspectRatio: "9:16";
  width: number;
  height: number;
  videoCodec: "h264";
  audioCodec: "aac";
  fps: number;
  maxDurationSec: number;
  targetBitrateKbps: number;
}

export const PLATFORM_EXPORT_PRESETS: Record<"TIKTOK" | "INSTAGRAM_REELS" | "YOUTUBE_SHORTS", PlatformExportPreset> = {
  TIKTOK: {
    aspectRatio: "9:16",
    width: 1080,
    height: 1920,
    videoCodec: "h264",
    audioCodec: "aac",
    fps: 30,
    maxDurationSec: 600, // conservative default — the real, account-specific limit comes from queryCreatorInfo at publish time
    targetBitrateKbps: 6000,
  },
  INSTAGRAM_REELS: {
    aspectRatio: "9:16",
    width: 1080,
    height: 1920,
    videoCodec: "h264",
    audioCodec: "aac",
    fps: 30,
    maxDurationSec: 900,
    targetBitrateKbps: 5000,
  },
  YOUTUBE_SHORTS: {
    aspectRatio: "9:16",
    width: 1080,
    height: 1920,
    videoCodec: "h264",
    audioCodec: "aac",
    fps: 30,
    maxDurationSec: 180,
    targetBitrateKbps: 6000,
  },
};

/** Builds the real ffmpeg scale+pad filter that fits a source of any size into a preset's target dimensions without distortion (letterbox/pillarbox with black bars) — the actual filter a PLATFORM_EXPORT operation handler (see operations.ts) would pass to `-vf`. Exported now, ahead of that handler, so the exact real transform is documented and testable independent of wiring it into a job. */
export function buildScalePadFilter(preset: PlatformExportPreset): string {
  const { width, height } = preset;
  return (
    `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`
  );
}
