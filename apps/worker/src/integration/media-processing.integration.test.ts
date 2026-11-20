import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@socialith/database";
import { libraryKeys, testing, withLimits, type MediaLimits } from "@socialith/media-pack";
import { LocalAssetStorage, type AssetStorage, type PutFileOptions, type StoredFile } from "@socialith/video-engine";
import { analyzeAsset, extractPack, type MediaDeps } from "../media/process.js";
import { TaskReporter, type TaskUpdate } from "../tasks/reporter.js";
import { FFMPEG, FFMPEG_AVAILABLE, FFPROBE, makeWorkerSampleMedia, runRealFfmpegTests, type WorkerSampleMedia } from "../testing/media-fixtures.js";

/**
 * Phase 5A on the REAL stack: MySQL, real FFmpeg/ffprobe on real generated media, real file storage. The API's part
 * (upload, validation, queueing) is covered by the API integration tests; here the worker takes a stored archive or asset
 * and must produce honest, persisted, resumable results.
 */
const enabled = Boolean(process.env.MYSQL_INTEGRATION_URL && process.env.REDIS_INTEGRATION_URL) && runRealFfmpegTests;
const suite = enabled ? describe : describe.skip;
const { buildZip } = testing;
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

let root: string;
let library: string;
let media: WorkerSampleMedia;
let storage: LocalAssetStorage;
const buffers: Record<string, Buffer> = {};

/** The worker's view of the world: real storage, real FFmpeg, and every progress write captured. */
function makeDeps(over: { storage?: AssetStorage; limits?: Partial<MediaLimits>; ffmpeg?: string; ffprobe?: string } = {}) {
  const updates: TaskUpdate[] = [];
  const deps: MediaDeps = {
    env: { FFMPEG_PATH: over.ffmpeg ?? FFMPEG, FFPROBE_PATH: over.ffprobe ?? FFPROBE },
    storage: over.storage ?? storage,
    limits: withLimits(over.limits),
    reporter: { minIntervalMs: 0, publish: (u) => void updates.push(u) },
    tmpRoot: root,
  };
  return { deps, updates };
}

async function makeOrg(label: string) {
  return prisma.organization.create({ data: { name: `IT ${label}`, slug: `it-media-${label}-${randomUUID().slice(0, 8)}` } });
}

/** Stores an archive and creates the pack + task rows exactly as the API's upload does. */
async function seedArchive(organizationId: string, zip: Buffer) {
  const pack = await prisma.mediaPack.create({ data: { organizationId, name: "IT pack", sourceType: "ZIP", sourceFileName: "pack.zip", sourceArchiveBytes: BigInt(zip.length), sourceArchiveSha256: sha(zip), status: "PROCESSING" } });
  const src = join(root, `${pack.id}.zip`);
  writeFileSync(src, zip);
  const key = libraryKeys.archive(organizationId, pack.id);
  await storage.putFile(key, src);
  await prisma.mediaPack.update({ where: { id: pack.id }, data: { sourceArchiveKey: key } });
  const task = await prisma.operationTask.create({ data: { organizationId, type: "MEDIA_ZIP_EXTRACT", subjectType: "MediaPack", subjectId: pack.id, unit: "files", stage: "Queued" } });
  return { pack, task };
}
const taskRow = (id: string) => prisma.operationTask.findUniqueOrThrow({ where: { id } });
const packRow = (id: string) => prisma.mediaPack.findUniqueOrThrow({ where: { id } });
const assets = (packId: string) => prisma.mediaAsset.findMany({ where: { packId }, include: { derivatives: true }, orderBy: { entryPath: "asc" } });
const byPath = (rows: Awaited<ReturnType<typeof assets>>, path: string) => rows.find((r) => r.entryPath === path)!;

async function keysInStorage(): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, prefix: string) => {
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (e.isDirectory()) await walk(join(dir, e.name), `${prefix}${e.name}/`);
      else out.push(`${prefix}${e.name}`);
    }
  };
  await walk(library, "");
  return out;
}

beforeAll(() => {
  if (!enabled) return;
  if (!FFMPEG_AVAILABLE) throw new Error("FFmpeg/ffprobe are required in CI: install ffmpeg before running the tests.");
  root = mkdtempSync(join(tmpdir(), "it-media-root-"));
  library = join(root, "library");
  storage = new LocalAssetStorage({ baseDir: library, baseUrl: "private://media-library" });
  media = makeWorkerSampleMedia(join(root, "samples"));
  for (const [name, path] of Object.entries(media)) buffers[name] = readFileSync(path);
}, 180_000);

afterAll(async () => {
  if (!enabled) return;
  await prisma.organization.deleteMany({ where: { slug: { startsWith: "it-media-" } } });
  rmSync(root, { recursive: true, force: true });
  await prisma.$disconnect();
});

const brokenMp4 = () => Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypisom"), Buffer.alloc(24), Buffer.from("this is not really a video stream at all".repeat(5))]);

suite("ZIP extraction in the worker (real MySQL, real FFmpeg, real storage)", () => {
  it("extracts a mixed archive: structure kept, files classified, facts measured, thumbnails made, bad files explained", async () => {
    const org = await makeOrg("mixed");
    const zip = buildZip([
      { name: "campaign/videos/clip.mp4", data: buffers.video },
      { name: "campaign/videos/vertical.mp4", data: buffers.vertical },
      { name: "campaign/images/cover.png", data: buffers.png, method: 8 },
      { name: "campaign/images/photo.jpg", data: buffers.jpg },
      { name: "campaign/audio/song.mp3", data: buffers.mp3 },
      { name: "campaign/audio/voice.wav", data: buffers.wav, method: 8 },
      { name: "campaign/text/notes.txt", data: Buffer.from("Line one\nLine two\n") },
      { name: "campaign/data/lines.csv", data: Buffer.from("text,category\nhello,Motivation\n") },
      { name: "campaign/images/cover-copy.png", data: buffers.png }, // same bytes as cover.png
      { name: "fake.png", data: Buffer.from("this is plain text pretending to be a picture\n".repeat(10)) },
      { name: "broken.mp4", data: brokenMp4() },
      { name: "tool.exe", data: Buffer.from("MZ not a program") },
      { name: "inner.zip", data: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]) },
      { name: "__MACOSX/._clip.mp4", data: Buffer.from("junk") },
    ]);
    const { pack, task } = await seedArchive(org.id, zip);
    const { deps, updates } = makeDeps();

    await extractPack(task.id, pack.id, deps);

    const rows = await assets(pack.id);
    const status = (p: string) => byPath(rows, p).status;

    // structure kept as metadata, classification, status
    expect(byPath(rows, "campaign/videos/clip.mp4")).toMatchObject({ folderPath: "campaign/videos", originalName: "clip.mp4", kind: "VIDEO", status: "READY", mimeType: "video/mp4" });
    expect(byPath(rows, "campaign/images/cover.png")).toMatchObject({ kind: "IMAGE", status: "READY", folderPath: "campaign/images" });
    expect(byPath(rows, "campaign/audio/song.mp3")).toMatchObject({ kind: "AUDIO", status: "READY" });
    expect(byPath(rows, "campaign/text/notes.txt")).toMatchObject({ kind: "TEXT", status: "READY" });
    expect(byPath(rows, "campaign/data/lines.csv")).toMatchObject({ kind: "SPREADSHEET", status: "READY" });

    // facts are measured, never guessed
    const clip = byPath(rows, "campaign/videos/clip.mp4");
    expect(clip).toMatchObject({ width: 640, height: 360, aspectRatio: "16:9", fps: 25, videoCodec: "h264", audioCodec: "aac", hasAudio: true });
    expect(clip.durationMs).toBeGreaterThan(1900);
    expect(clip.durationMs).toBeLessThan(2300);
    expect(byPath(rows, "campaign/videos/vertical.mp4")).toMatchObject({ width: 1080, height: 1920, aspectRatio: "9:16", hasAudio: false });
    expect(byPath(rows, "campaign/images/cover.png")).toMatchObject({ width: 800, height: 600, aspectRatio: "4:3", durationMs: null, fps: null });
    expect(byPath(rows, "campaign/images/photo.jpg")).toMatchObject({ width: 1000, height: 1000, aspectRatio: "1:1" });
    expect(byPath(rows, "campaign/audio/voice.wav")).toMatchObject({ sampleRate: 22050, channels: 1, width: null });
    expect(byPath(rows, "campaign/text/notes.txt")).toMatchObject({ width: null, durationMs: null, aspectRatio: null });

    // thumbnails only where they make sense, stored separately from the original
    expect(byPath(rows, "campaign/videos/clip.mp4").derivatives.map((d) => d.kind)).toEqual(["THUMBNAIL"]);
    expect(byPath(rows, "campaign/images/photo.jpg").derivatives).toHaveLength(1);
    expect(byPath(rows, "campaign/audio/song.mp3").derivatives).toHaveLength(0);
    expect(byPath(rows, "campaign/text/notes.txt").derivatives).toHaveLength(0);
    const thumb = clip.derivatives[0]!;
    expect(thumb.storageKey).not.toBe(clip.storageKey);
    expect(await storage.exists(thumb.storageKey)).toBe(true);

    // the original is stored untouched
    const stored = readFileSync(join(library, clip.storageKey!));
    expect(sha(stored)).toBe(clip.sha256);
    expect(sha(stored)).toBe(sha(buffers.video));

    // duplicate: recorded, nothing stored, pointing at the first
    const dup = byPath(rows, "campaign/images/cover-copy.png");
    expect(dup).toMatchObject({ status: "DUPLICATE", storageKey: null, duplicateOfId: byPath(rows, "campaign/images/cover.png").id });

    // refused and failed files carry a reason
    expect(byPath(rows, "fake.png")).toMatchObject({ status: "REJECTED", rejectionCode: "SIGNATURE_MISMATCH", storageKey: null });
    expect(byPath(rows, "tool.exe")).toMatchObject({ status: "REJECTED", rejectionCode: "UNSUPPORTED_TYPE" });
    expect(byPath(rows, "inner.zip")).toMatchObject({ status: "REJECTED", rejectionCode: "NESTED_ARCHIVE" });
    expect(byPath(rows, "broken.mp4")).toMatchObject({ status: "FAILED", rejectionCode: "NOT_DECODABLE" });
    expect(byPath(rows, "broken.mp4").rejectionReason).toBeTruthy();
    expect(rows.some((r) => r.entryPath?.includes("MACOSX"))).toBe(false); // archiver junk ignored silently
    expect(status("campaign/data/lines.csv")).toBe("READY");

    // pack summary
    const finished = await packRow(pack.id);
    expect(finished).toMatchObject({ status: "PARTIAL", entryCount: 14, ignoredCount: 1, assetCount: 8, rejectedCount: 3, duplicateCount: 1 });

    // only originals + thumbnails + the archive exist: nothing stored for rejected/duplicate files
    const keys = await keysInStorage();
    expect(keys.filter((k) => k.includes("/original")).length).toBe(9); // 8 READY + broken.mp4 (stored, but failed analysis)
    expect(keys.filter((k) => k.endsWith("thumbnail.jpg")).length).toBe(4);

    // progress: a real total, monotonic, finished at total
    const t = await taskRow(task.id);
    expect(t).toMatchObject({ status: "SUCCEEDED", totalUnits: 13, completedUnits: 13, unit: "files", errorCode: null });
    expect(t.startedAt).not.toBeNull();
    expect(t.finishedAt).not.toBeNull();
    expect(t.lastProgressAt).not.toBeNull();
    const withTotal = updates.filter((u) => u.totalUnits !== null);
    expect(withTotal.length).toBeGreaterThan(5);
    expect(new Set(withTotal.map((u) => u.totalUnits))).toEqual(new Set([13]));
    const completedSeries = updates.map((u) => u.completedUnits);
    expect([...completedSeries].sort((a, b) => a - b)).toEqual(completedSeries); // never goes backwards
    expect(completedSeries[completedSeries.length - 1]).toBe(13);
    expect(updates[updates.length - 1]).toMatchObject({ status: "SUCCEEDED" });
    // early updates (archive being read, total not yet known) are NOT given a made-up total
    expect(updates[0]!.totalUnits).toBeNull();
  }, 240_000);

  it("detects duplicates across packs of the SAME organization, and never across organizations", async () => {
    const orgA = await makeOrg("dupA");
    const orgB = await makeOrg("dupB");
    const first = await seedArchive(orgA.id, buildZip([{ name: "cover.png", data: buffers.png }]));
    await extractPack(first.task.id, first.pack.id, makeDeps().deps);
    const original = byPath(await assets(first.pack.id), "cover.png");
    expect(original.status).toBe("READY");

    const second = await seedArchive(orgA.id, buildZip([{ name: "renamed/cover-again.png", data: buffers.png }]));
    await extractPack(second.task.id, second.pack.id, makeDeps().deps);
    expect(byPath(await assets(second.pack.id), "renamed/cover-again.png")).toMatchObject({ status: "DUPLICATE", duplicateOfId: original.id, storageKey: null });

    const other = await seedArchive(orgB.id, buildZip([{ name: "cover.png", data: buffers.png }]));
    await extractPack(other.task.id, other.pack.id, makeDeps().deps);
    expect(byPath(await assets(other.pack.id), "cover.png")).toMatchObject({ status: "READY", duplicateOfId: null });
  }, 240_000);

  it("refuses a ZIP bomb before extracting anything and says what to do", async () => {
    const org = await makeOrg("bomb");
    const { pack, task } = await seedArchive(org.id, buildZip([{ name: "zeros.txt", data: Buffer.alloc(20 * 1024 * 1024), method: 8 }]));
    await extractPack(task.id, pack.id, makeDeps().deps);
    expect(await packRow(pack.id)).toMatchObject({ status: "FAILED", errorCode: "ZIP_RATIO_EXCEEDED" });
    const t = await taskRow(task.id);
    expect(t).toMatchObject({ status: "FAILED", errorCode: "ZIP_RATIO_EXCEEDED" });
    expect(t.errorRemedy).toMatch(/ZIP bomb/i);
    expect(await assets(pack.id)).toEqual([]);
    expect((await keysInStorage()).filter((k) => k.includes(`/${pack.id}/`) === false && k.includes("zeros"))).toEqual([]);
  });

  it("refuses an archive with a path traversal entry, extracting nothing from it", async () => {
    const org = await makeOrg("traversal");
    const { pack, task } = await seedArchive(org.id, buildZip([{ name: "good.png", data: buffers.png }, { name: "../../etc/evil.png", data: buffers.png }]));
    await extractPack(task.id, pack.id, makeDeps().deps);
    expect(await packRow(pack.id)).toMatchObject({ status: "FAILED", errorCode: "ZIP_UNSAFE_PATH" });
    expect(await taskRow(task.id)).toMatchObject({ status: "FAILED", errorCode: "ZIP_UNSAFE_PATH" });
    expect(await assets(pack.id)).toEqual([]);
  });

  it("enforces the configured entry limit", async () => {
    const org = await makeOrg("entries");
    const { pack, task } = await seedArchive(org.id, buildZip([1, 2, 3, 4, 5].map((i) => ({ name: `f${i}.txt`, data: Buffer.from(`file ${i}`) }))));
    await extractPack(task.id, pack.id, makeDeps({ limits: { zipMaxEntries: 3 } }).deps);
    expect(await packRow(pack.id)).toMatchObject({ status: "FAILED", errorCode: "ZIP_TOO_MANY_ENTRIES" });
    expect((await taskRow(task.id)).errorRemedy).toMatch(/MEDIA_ZIP_MAX_ENTRIES/);
  });

  it("stops at once when an entry inflates past what its header claimed; the entry gets no row and the pack fails", async () => {
    const org = await makeOrg("liar");
    const zip = buildZip([
      { name: "a-ok.png", data: buffers.png },
      { name: "b-liar.txt", data: Buffer.alloc(5 * 1024 * 1024), method: 8, declaredSize: 1000 },
      { name: "c-never.png", data: buffers.jpg },
    ]);
    const { pack, task } = await seedArchive(org.id, zip);
    await extractPack(task.id, pack.id, makeDeps().deps);
    expect(await packRow(pack.id)).toMatchObject({ status: "FAILED", errorCode: "ZIP_BOMB_DETECTED" });
    expect(await taskRow(task.id)).toMatchObject({ status: "FAILED", errorCode: "ZIP_BOMB_DETECTED" });
    const rows = await assets(pack.id);
    expect(rows.map((r) => r.entryPath)).toEqual(["a-ok.png"]); // processed before the lie was found; the liar and the rest never were
  }, 120_000);
});

suite("interrupted work resumes without duplicating or overwriting anything", () => {
  /** A storage that "crashes" the worker on the Nth original it is asked to store. */
  class CrashingStorage extends LocalAssetStorage {
    puts = 0;
    constructor(
      dir: string,
      private crashOn: number,
    ) {
      super({ baseDir: dir, baseUrl: "private://media-library" });
    }
    override async putFile(key: string, filePath: string, options?: PutFileOptions): Promise<StoredFile> {
      if (key.includes("/original")) {
        this.puts++;
        if (this.puts === this.crashOn) throw new Error("simulated worker crash while storing");
      }
      return super.putFile(key, filePath, options);
    }
  }

  it("a job that dies halfway is re-run by BullMQ and continues: each entry once, progress completes, attempts counted", async () => {
    const org = await makeOrg("resume");
    const zip = buildZip([
      { name: "one.png", data: buffers.png },
      { name: "two.jpg", data: buffers.jpg },
      { name: "three.mp3", data: buffers.mp3 },
      { name: "four.wav", data: buffers.wav },
    ]);
    const { pack, task } = await seedArchive(org.id, zip);

    await expect(extractPack(task.id, pack.id, makeDeps({ storage: new CrashingStorage(library, 3) }).deps)).rejects.toThrow("simulated worker crash");
    const midway = await taskRow(task.id);
    expect(midway.status).toBe("RUNNING"); // not finished, not failed: BullMQ will run it again
    expect(midway.completedUnits).toBe(2);
    expect(midway.totalUnits).toBe(4);
    expect((await assets(pack.id)).length).toBeGreaterThanOrEqual(2);

    const { deps, updates } = makeDeps();
    await extractPack(task.id, pack.id, deps);

    const rows = await assets(pack.id);
    expect(rows.map((r) => r.entryPath)).toEqual(["four.wav", "one.png", "three.mp3", "two.jpg"]); // exactly once each
    expect(rows.every((r) => r.status === "READY")).toBe(true);
    for (const r of rows) expect(await storage.exists(r.storageKey!)).toBe(true);
    const t = await taskRow(task.id);
    expect(t).toMatchObject({ status: "SUCCEEDED", completedUnits: 4, totalUnits: 4, attempts: 2 });
    expect(updates[0]!.completedUnits).toBe(2); // the second attempt starts from the persisted progress, not from zero
    expect(await packRow(pack.id)).toMatchObject({ status: "READY", assetCount: 4 });
  }, 240_000);

  it("a file stored but not yet analyzed when the worker died is analyzed on the re-run, and its original is not rewritten", async () => {
    const org = await makeOrg("halfway");
    const { pack, task } = await seedArchive(org.id, buildZip([{ name: "half.png", data: buffers.png }]));
    // what the worker leaves behind if it dies between storing the original and analyzing it
    const asset = await prisma.mediaAsset.create({ data: { organizationId: org.id, packId: pack.id, entryPath: "half.png", originalName: "half.png", kind: "IMAGE", status: "ANALYZING", mimeType: "image/png", sizeBytes: BigInt(buffers.png!.length), sha256: sha(buffers.png!) } });
    const key = libraryKeys.original(org.id, asset.id, "half.png");
    const src = join(root, "half.png");
    writeFileSync(src, buffers.png!);
    await storage.putFile(key, src);
    await prisma.mediaAsset.update({ where: { id: asset.id }, data: { storageKey: key } });
    const before = readFileSync(join(library, key));

    await extractPack(task.id, pack.id, makeDeps().deps);

    const rows = await assets(pack.id);
    expect(rows).toHaveLength(1); // not duplicated
    expect(rows[0]).toMatchObject({ id: asset.id, status: "READY", width: 800, height: 600 });
    expect(rows[0]!.derivatives).toHaveLength(1);
    expect(readFileSync(join(library, key)).equals(before)).toBe(true); // original untouched
  }, 120_000);
});

suite("analyzing one stored asset", () => {
  async function seedAsset(organizationId: string, kind: "VIDEO" | "IMAGE" | "AUDIO", fileName: string, bytes: Buffer, mime: string) {
    const asset = await prisma.mediaAsset.create({ data: { organizationId, originalName: fileName, kind, status: "ANALYZING", mimeType: mime, sizeBytes: BigInt(bytes.length), sha256: sha(bytes) } });
    const src = join(root, `${asset.id}${fileName.slice(fileName.lastIndexOf("."))}`);
    writeFileSync(src, bytes);
    const key = libraryKeys.original(organizationId, asset.id, fileName);
    await storage.putFile(key, src);
    await prisma.mediaAsset.update({ where: { id: asset.id }, data: { storageKey: key } });
    const task = await prisma.operationTask.create({ data: { organizationId, type: "MEDIA_ANALYZE", subjectType: "MediaAsset", subjectId: asset.id, stage: "Queued" } });
    return { asset, task };
  }
  const asset = (id: string) => prisma.mediaAsset.findUniqueOrThrow({ where: { id }, include: { derivatives: true } });

  it("measures a stored video and makes a thumbnail; the task has no invented total", async () => {
    const org = await makeOrg("single");
    const { asset: a, task } = await seedAsset(org.id, "VIDEO", "clip.mp4", buffers.video!, "video/mp4");
    await analyzeAsset(task.id, a.id, makeDeps().deps);
    expect(await asset(a.id)).toMatchObject({ status: "READY", width: 640, height: 360, aspectRatio: "16:9" });
    expect((await asset(a.id)).derivatives).toHaveLength(1);
    expect(await taskRow(task.id)).toMatchObject({ status: "SUCCEEDED", totalUnits: null });
  }, 120_000);

  it("marks an undecodable video FAILED with a reason and fails the task with a remedy", async () => {
    const org = await makeOrg("undecodable");
    const { asset: a, task } = await seedAsset(org.id, "VIDEO", "broken.mp4", brokenMp4(), "video/mp4");
    await analyzeAsset(task.id, a.id, makeDeps().deps);
    expect(await asset(a.id)).toMatchObject({ status: "FAILED", rejectionCode: "NOT_DECODABLE" });
    const t = await taskRow(task.id);
    expect(t).toMatchObject({ status: "FAILED", errorCode: "NOT_DECODABLE" });
    expect(t.errorRemedy).toBeTruthy();
  }, 120_000);

  it("fails a file whose content is not the kind its name claims", async () => {
    const org = await makeOrg("kind");
    const { asset: a, task } = await seedAsset(org.id, "IMAGE", "actually-a-video.png", buffers.video!, "image/png");
    await analyzeAsset(task.id, a.id, makeDeps().deps);
    expect(await asset(a.id)).toMatchObject({ status: "FAILED", rejectionCode: "KIND_MISMATCH" });
    expect((await asset(a.id)).rejectionReason).toMatch(/video content/);
  }, 120_000);

  it("a missing FFmpeg is a configuration failure with a remedy: the asset stays analyzable, nothing is marked bad", async () => {
    const org = await makeOrg("noffmpeg");
    const { asset: a, task } = await seedAsset(org.id, "IMAGE", "cover.png", buffers.png!, "image/png");
    await analyzeAsset(task.id, a.id, makeDeps({ ffmpeg: "/definitely/not/ffmpeg", ffprobe: "/definitely/not/ffprobe" }).deps);
    expect(await asset(a.id)).toMatchObject({ status: "ANALYZING", rejectionCode: null });
    const t = await taskRow(task.id);
    expect(t).toMatchObject({ status: "FAILED", errorCode: "CONFIGURATION_ERROR" });
    expect(t.errorRemedy).toMatch(/FFmpeg/);
  });

  it("a missing FFmpeg fails the whole archive with the real cause, not a vague error", async () => {
    const org = await makeOrg("noffmpegzip");
    const { pack, task } = await seedArchive(org.id, buildZip([{ name: "a.png", data: buffers.png }]));
    await extractPack(task.id, pack.id, makeDeps({ ffmpeg: "/definitely/not/ffmpeg" }).deps);
    expect(await packRow(pack.id)).toMatchObject({ status: "FAILED", errorCode: "CONFIGURATION_ERROR" });
    expect(await taskRow(task.id)).toMatchObject({ status: "FAILED", errorCode: "CONFIGURATION_ERROR" });
    expect(await assets(pack.id)).toEqual([]);
  });

  it("fails a task whose subject no longer exists instead of hanging", async () => {
    const org = await makeOrg("gone");
    const task = await prisma.operationTask.create({ data: { organizationId: org.id, type: "MEDIA_ANALYZE", stage: "Queued" } });
    await analyzeAsset(task.id, "does-not-exist", makeDeps().deps);
    expect(await taskRow(task.id)).toMatchObject({ status: "FAILED", errorCode: "ASSET_NOT_FOUND" });
  });
});

suite("the progress reporter", () => {
  async function newTask() {
    const org = await makeOrg("reporter");
    return prisma.operationTask.create({ data: { organizationId: org.id, type: "MEDIA_ZIP_EXTRACT", stage: "Queued" } });
  }

  it("persists what the worker measured and nothing else (no percentage is ever stored)", async () => {
    const task = await newTask();
    const r = new TaskReporter(task.id, { minIntervalMs: 0 });
    await r.start({ stage: "Reading", totalUnits: null, unit: "files" });
    await r.setTotal(8, "files");
    await r.progress(3, "Extracting", "a/b.png");
    const row = await taskRow(task.id);
    expect(row).toMatchObject({ status: "RUNNING", stage: "Extracting", stageDetail: "a/b.png", completedUnits: 3, totalUnits: 8, unit: "files", attempts: 1 });
    expect(Object.keys(row)).not.toContain("percentage");
    await r.succeed();
    expect(await taskRow(task.id)).toMatchObject({ status: "SUCCEEDED", completedUnits: 3 });
  });

  it("never resurrects a finished task: late progress, a second start and a second finish change nothing", async () => {
    const task = await newTask();
    const r = new TaskReporter(task.id, { minIntervalMs: 0 });
    await r.start({ totalUnits: 5 });
    await r.progress(5);
    await r.succeed();
    const done = await taskRow(task.id);
    await r.progress(1, "Late");
    await r.stage("Late stage");
    await r.fail({ code: "LATE", message: "too late" });
    await new TaskReporter(task.id, { minIntervalMs: 0 }).start({ stage: "Again" });
    const after = await taskRow(task.id);
    expect(after).toMatchObject({ status: "SUCCEEDED", completedUnits: 5, stage: "Done", errorCode: null });
    expect(after.finishedAt?.getTime()).toBe(done.finishedAt?.getTime());
    expect(after.attempts).toBe(done.attempts);
  });

  it("merges rapid progress writes inside the throttle window, but flush and terminal states always land", async () => {
    const task = await newTask();
    const r = new TaskReporter(task.id, { minIntervalMs: 60_000 });
    await r.start({ totalUnits: 100 });
    for (let i = 1; i <= 50; i++) await r.progress(i);
    expect((await taskRow(task.id)).completedUnits).toBe(0); // throttled: nothing written yet
    await r.flush();
    expect((await taskRow(task.id)).completedUnits).toBe(50);
    await r.progress(77);
    await r.succeed(100);
    expect(await taskRow(task.id)).toMatchObject({ status: "SUCCEEDED", completedUnits: 100 });
  });

  it("records a failure with a code and a remedy", async () => {
    const task = await newTask();
    const r = new TaskReporter(task.id, { minIntervalMs: 0 });
    await r.start();
    await r.fail({ code: "SOMETHING_BROKE", message: "It broke.", remedy: "Do this." });
    expect(await taskRow(task.id)).toMatchObject({ status: "FAILED", errorCode: "SOMETHING_BROKE", errorMessage: "It broke.", errorRemedy: "Do this." });
  });

  it("a failing notification never fails the work", async () => {
    const task = await newTask();
    const r = new TaskReporter(task.id, {
      minIntervalMs: 0,
      publish: () => {
        throw new Error("redis is down");
      },
    });
    await expect(r.start({ totalUnits: 2 })).resolves.toBeUndefined();
    await expect(r.progress(1)).resolves.toBeUndefined();
    await expect(r.succeed()).resolves.toBeUndefined();
    expect((await taskRow(task.id)).status).toBe("SUCCEEDED");
  });

  it("keeps the first start time across retries and restarts the attempt count", async () => {
    const task = await newTask();
    await new TaskReporter(task.id, { minIntervalMs: 0 }).start();
    const first = (await taskRow(task.id)).startedAt!;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await new TaskReporter(task.id, { minIntervalMs: 0 }).start();
    const second = await taskRow(task.id);
    expect(second.startedAt!.getTime()).toBe(first.getTime());
    expect(second.attempts).toBe(2);
  });
});
