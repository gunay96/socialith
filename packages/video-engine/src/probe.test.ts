import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeAspectRatio, parseProbe, probeMedia, ProbeError } from "./probe.js";
import { FFMPEG_AVAILABLE, FFPROBE, makeSampleMedia, runRealFfmpegTests, type SampleMedia } from "./testing/ffmpeg-fixtures.js";

describe("describeAspectRatio", () => {
  it("names the standard ratios, tolerating a pixel of rounding", () => {
    expect(describeAspectRatio(1080, 1920)?.label).toBe("9:16");
    expect(describeAspectRatio(1920, 1080)?.label).toBe("16:9");
    expect(describeAspectRatio(1080, 1350)?.label).toBe("4:5");
    expect(describeAspectRatio(1000, 1000)?.label).toBe("1:1");
    expect(describeAspectRatio(1079, 1919)?.label).toBe("9:16");
    expect(describeAspectRatio(2520, 1080)?.label).toBe("21:9");
  });
  it("falls back to a reduced ratio, then to a decimal, and refuses nonsense", () => {
    expect(describeAspectRatio(1000, 600)?.label).toBe("5:3");
    expect(describeAspectRatio(1234, 567)?.label).toBe("2.18:1");
    expect(describeAspectRatio(0, 100)).toBeNull();
    expect(describeAspectRatio(100, -1)).toBeNull();
  });
});

describe("parseProbe (pure)", () => {
  const video = { codec_type: "video", codec_name: "h264", width: 1920, height: 1080, avg_frame_rate: "30000/1001", r_frame_rate: "30/1" };
  const audio = { codec_type: "audio", codec_name: "aac", sample_rate: "48000", channels: 2 };

  it("reads a normal video", () => {
    const f = parseProbe({ format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "12.480", bit_rate: "5000000", size: "7800000" }, streams: [video, audio] });
    expect(f).toMatchObject({ kind: "video", width: 1920, height: 1080, aspectRatio: "16:9", durationMs: 12480, fps: 29.97, videoCodec: "h264", audioCodec: "aac", hasAudio: true, bitrateKbps: 5000, sampleRate: 48000, channels: 2, rotation: 0, sizeBytes: 7_800_000 });
  });

  it("swaps width and height for a portrait phone video recorded with a 90 degree rotation (tag and side data)", () => {
    const tag = parseProbe({ format: { format_name: "mov,mp4", duration: "5" }, streams: [{ ...video, tags: { rotate: "90" } }] });
    expect(tag).toMatchObject({ width: 1080, height: 1920, aspectRatio: "9:16", rotation: 90 });
    const side = parseProbe({ format: { format_name: "mov,mp4", duration: "5" }, streams: [{ ...video, side_data_list: [{ rotation: -90 }] }] });
    expect(side).toMatchObject({ width: 1080, height: 1920, rotation: 270 });
    const flipped = parseProbe({ format: { format_name: "mov,mp4", duration: "5" }, streams: [{ ...video, tags: { rotate: "180" } }] });
    expect(flipped).toMatchObject({ width: 1920, height: 1080, rotation: 180 });
  });

  it("recognises a still image: no duration, no frame rate", () => {
    const f = parseProbe({ format: { format_name: "png_pipe" }, streams: [{ codec_type: "video", codec_name: "png", width: 800, height: 600, avg_frame_rate: "25/1" }] });
    expect(f).toMatchObject({ kind: "image", width: 800, height: 600, aspectRatio: "4:3", durationMs: null, fps: null });
  });

  it("recognises audio, and does not mistake MP3 cover art for a video", () => {
    const f = parseProbe({ format: { format_name: "mp3", duration: "180.5", bit_rate: "128000" }, streams: [{ codec_type: "audio", codec_name: "mp3", sample_rate: "44100", channels: 2 }, { codec_type: "video", codec_name: "mjpeg", width: 600, height: 600, disposition: { attached_pic: 1 } }] });
    expect(f).toMatchObject({ kind: "audio", width: null, height: null, durationMs: 180_500, hasAudio: true, videoCodec: null, bitrateKbps: 128 });
  });

  it("never invents a fact ffprobe did not report", () => {
    const f = parseProbe({ format: { format_name: "mov,mp4" }, streams: [{ codec_type: "video", codec_name: "h264", avg_frame_rate: "0/0", r_frame_rate: "0/0" }] });
    expect(f).toMatchObject({ width: null, height: null, aspectRatio: null, aspectDecimal: null, fps: null, durationMs: null, bitrateKbps: null, hasAudio: false });
    expect(parseProbe({}).kind).toBe("unknown");
    expect(parseProbe(null).kind).toBe("unknown");
  });

  it("falls back to the stream duration when the container has none", () => {
    expect(parseProbe({ format: { format_name: "matroska,webm" }, streams: [{ ...video, duration: "3.5" }] }).durationMs).toBe(3500);
  });
});

describe.skipIf(!runRealFfmpegTests)("probeMedia with real ffprobe on real sample media", () => {
  let media: SampleMedia;
  let dir: string;
  beforeAll(() => {
    if (!FFMPEG_AVAILABLE) throw new Error("FFmpeg/ffprobe are required in CI: install ffmpeg before running the tests.");
    dir = mkdtempSync(join(tmpdir(), "ve-probe-"));
    media = makeSampleMedia(dir);
  }, 120_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("measures a video: size, aspect ratio, duration, frame rate, codecs, audio", async () => {
    const f = await probeMedia(FFPROBE, media.video);
    expect(f).toMatchObject({ kind: "video", width: 640, height: 360, aspectRatio: "16:9", fps: 25, videoCodec: "h264", audioCodec: "aac", hasAudio: true, container: expect.stringContaining("mp4") });
    expect(f.durationMs).toBeGreaterThan(1900);
    expect(f.durationMs).toBeLessThan(2300);
    expect(f.sizeBytes).toBeGreaterThan(10_000); // ffprobe itself reports the container size: a measured fact
  });

  it("measures a vertical 9:16 video without audio", async () => {
    expect(await probeMedia(FFPROBE, media.verticalVideo)).toMatchObject({ kind: "video", width: 1080, height: 1920, aspectRatio: "9:16", hasAudio: false });
  });

  it("applies a display rotation, as a phone portrait clip needs", async () => {
    expect(await probeMedia(FFPROBE, media.rotatedVideo)).toMatchObject({ kind: "video", width: 360, height: 640, aspectRatio: "9:16", rotation: 90 });
  });

  it("measures images and audio", async () => {
    expect(await probeMedia(FFPROBE, media.png)).toMatchObject({ kind: "image", width: 800, height: 600, aspectRatio: "4:3", durationMs: null });
    expect(await probeMedia(FFPROBE, media.jpeg)).toMatchObject({ kind: "image", width: 1000, height: 1000, aspectRatio: "1:1" });
    expect(await probeMedia(FFPROBE, media.wav)).toMatchObject({ kind: "audio", hasAudio: true, sampleRate: 22050, channels: 1 });
    expect((await probeMedia(FFPROBE, media.wav)).durationMs).toBeGreaterThan(2900);
    expect(await probeMedia(FFPROBE, media.mp3)).toMatchObject({ kind: "audio", audioCodec: "mp3" });
  });

  it("reports the size we pass in, not a guess", async () => {
    expect((await probeMedia(FFPROBE, media.png, { sizeBytes: 1234 })).sizeBytes).toBe(1234);
  });

  it("refuses a file that is not media, with an actionable error", async () => {
    await expect(probeMedia(FFPROBE, media.notMedia)).rejects.toMatchObject({ name: "ProbeError", errorCode: "INVALID_MEDIA" });
  });

  it("explains a missing ffprobe binary as a configuration problem", async () => {
    const err = await probeMedia("/definitely/not/ffprobe", media.png).catch((e) => e);
    expect(err).toBeInstanceOf(ProbeError);
    expect(err).toMatchObject({ errorCode: "CONFIGURATION_ERROR" });
    expect(err.message).toMatch(/FFPROBE_PATH/);
  });
});
