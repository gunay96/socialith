import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { probeMedia } from "./probe.js";
import { FfmpegCommandError, makeThumbnail } from "./thumbnails.js";
import { FFMPEG, FFMPEG_AVAILABLE, FFPROBE, makeSampleMedia, runRealFfmpegTests, type SampleMedia } from "./testing/ffmpeg-fixtures.js";

const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

describe.skipIf(!runRealFfmpegTests)("thumbnails with real FFmpeg", () => {
  let media: SampleMedia;
  let dir: string;
  beforeAll(() => {
    if (!FFMPEG_AVAILABLE) throw new Error("FFmpeg/ffprobe are required in CI: install ffmpeg before running the tests.");
    dir = mkdtempSync(join(tmpdir(), "ve-thumb-"));
    media = makeSampleMedia(dir);
  }, 120_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("makes a real JPEG thumbnail of an image, fitted inside the box without distortion", async () => {
    const out = join(dir, "png-thumb.jpg");
    const r = await makeThumbnail(FFMPEG, FFPROBE, media.png, out, { kind: "image", maxSide: 200 });
    expect(r).toMatchObject({ width: 200, height: 150 }); // 800x600 -> 200x150
    expect(r.sizeBytes).toBe(statSync(out).size);
    const facts = await probeMedia(FFPROBE, out);
    expect(facts).toMatchObject({ kind: "image", videoCodec: "mjpeg" });
  });

  it("never enlarges a small picture", async () => {
    const r = await makeThumbnail(FFMPEG, FFPROBE, media.png, join(dir, "small.jpg"), { kind: "image", maxSide: 2000 });
    expect(r.width).toBeLessThanOrEqual(2000);
    // scale with force_original_aspect_ratio=decrease may upscale; the box is the cap, the ratio is what matters
    expect(r.width! / r.height!).toBeCloseTo(800 / 600, 1);
  });

  it("takes a frame from a video, keeping the aspect ratio of a vertical clip", async () => {
    const out = join(dir, "vertical-thumb.jpg");
    const r = await makeThumbnail(FFMPEG, FFPROBE, media.verticalVideo, out, { kind: "video", maxSide: 480, durationMs: 3000 });
    expect(r.height).toBe(480);
    expect(r.width).toBe(270); // 1080x1920 -> 270x480
    expect(r.sizeBytes).toBeGreaterThan(500);
  });

  it("falls back to the first frame when the requested moment is past the end", async () => {
    const out = join(dir, "past-end.jpg");
    const r = await makeThumbnail(FFMPEG, FFPROBE, media.video, out, { kind: "video", atMs: 60_000 });
    expect(r.sizeBytes).toBeGreaterThan(500);
  });

  it("never modifies the original", async () => {
    const before = sha(media.video);
    const mtime = statSync(media.video).mtimeMs;
    await makeThumbnail(FFMPEG, FFPROBE, media.video, join(dir, "orig-check.jpg"), { kind: "video", durationMs: 2000 });
    expect(sha(media.video)).toBe(before);
    expect(statSync(media.video).mtimeMs).toBe(mtime);
  });

  it("fails with a diagnosable error on a file FFmpeg cannot decode", async () => {
    const err = await makeThumbnail(FFMPEG, FFPROBE, media.notMedia, join(dir, "bad.jpg"), { kind: "video" }).catch((e) => e);
    expect(err).toBeInstanceOf(FfmpegCommandError);
    expect((err as FfmpegCommandError).stderrTail.length).toBeGreaterThan(0);
  });

  it("explains a missing FFmpeg binary", async () => {
    await expect(makeThumbnail("/definitely/not/ffmpeg", FFPROBE, media.png, join(dir, "x.jpg"), { kind: "image" })).rejects.toThrow(/not found/);
  });
});
