import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@socialith/database";
import type { Prisma } from "@socialith/database";
import { recipeConfigSchema, resolveEffectiveRecipe } from "@socialith/studio";
import { LocalAssetStorage, OutputInvalidError, resolveFontFace, validateOutput, type ComposeResult } from "@socialith/video-engine";
import { libraryKeys } from "@socialith/media-pack";
import { cleanupStaleRenderDirs, runRenderJob, type RenderDeps } from "../render/process.js";
import type { TaskUpdate } from "../tasks/reporter.js";
import { FFMPEG, FFMPEG_AVAILABLE, FFPROBE, runRealFfmpegTests } from "../testing/media-fixtures.js";
import { execFileSync } from "node:child_process";

/**
 * Rendering on the REAL stack: MySQL, real FFmpeg and fonts, real file storage. The API creates the job; here the worker
 * takes a queued render job and must produce a real, validated file in the library, report real progress, survive being
 * interrupted, and end cancelled or failed with a reason, never half-done.
 */
const fontsAvailable = (() => {
  try {
    resolveFontFace("liberation-sans", "BOLD");
    return true;
  } catch {
    return false;
  }
})();
const enabled = Boolean(process.env.MYSQL_INTEGRATION_URL) && runRealFfmpegTests && (fontsAvailable || process.env.CI === "true");
const suite = enabled ? describe : describe.skip;

let root: string;
let library: string;
let storage: LocalAssetStorage;
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const ff = (args: string[]) => execFileSync(FFMPEG, ["-y", "-v", "error", ...args], { timeout: 120_000 });

const TEXT = "Never give up on the thing you started, because the best is still ahead.";
const BASE = {
  typography: { font: "liberation-sans", sizePct: 6, weight: "BOLD", color: "#ffffff", shadow: false },
  position: { vertical: "CENTER", align: "CENTER", maxWidthPct: 80 },
  export: { resolution: "720", fps: 24, imageFormat: "PNG" },
  duration: { mode: "FIXED", seconds: 2 },
};
const values = (config: Record<string, unknown> = {}) => resolveEffectiveRecipe({ config: recipeConfigSchema.parse({ ...BASE, ...config, typography: { ...BASE.typography, ...((config.typography as object) ?? {}) }, duration: { ...BASE.duration, ...((config.duration as object) ?? {}) } }) });

function makeDeps(over: Partial<RenderDeps> = {}) {
  const updates: TaskUpdate[] = [];
  const deps: RenderDeps = { env: { FFMPEG_PATH: FFMPEG, FFPROBE_PATH: FFPROBE, RENDER_X264_PRESET: "ultrafast", RENDER_X264_CRF: 30 }, storage, reporter: { minIntervalMs: 0, publish: (u) => void updates.push(u) }, tmpRoot: root, ...over };
  return { deps, updates };
}

async function makeOrg(label: string) {
  return prisma.organization.create({ data: { name: `IT ${label}`, slug: `it-render-${label}-${randomUUID().slice(0, 8)}` } });
}

async function seedSource(organizationId: string, file: string, kind: "IMAGE" | "VIDEO", facts: { width: number; height: number; durationMs?: number; hasAudio?: boolean }) {
  const bytes = readFileSync(file);
  const asset = await prisma.mediaAsset.create({
    data: { organizationId, originalName: `source-${randomUUID().slice(0, 6)}${file.slice(file.lastIndexOf("."))}`, kind, status: "READY", mimeType: kind === "VIDEO" ? "video/mp4" : "image/png", sizeBytes: BigInt(bytes.length), sha256: sha(bytes), width: facts.width, height: facts.height, durationMs: facts.durationMs ?? null, hasAudio: kind === "VIDEO" ? (facts.hasAudio ?? false) : null, analyzedAt: new Date() },
  });
  const key = libraryKeys.original(organizationId, asset.id, asset.originalName);
  await storage.putFile(key, file);
  return prisma.mediaAsset.update({ where: { id: asset.id }, data: { storageKey: key } });
}

async function seedJob(organizationId: string, source: { id: string; sha256: string }, over: { config?: Record<string, unknown>; text?: string; cancelRequested?: boolean; realText?: boolean } = {}) {
  const effective = values(over.config);
  // most tests use a text id that no longer exists in the library (the render keeps its own copy of the words);
  // `realText` creates the library text so the usage history can be checked
  const textId = over.realText
    ? (await prisma.textEntry.create({ data: { organizationId, body: over.text ?? TEXT, normalizedHash: randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, ""), searchText: (over.text ?? TEXT).toLowerCase(), charCount: (over.text ?? TEXT).length, language: "en", approvalStatus: "APPROVED" } })).id
    : `text-${randomUUID().slice(0, 6)}`;
  const job = await prisma.mediaRenderJob.create({
    data: {
      organizationId,
      sourceAssetId: source.id,
      sourceSha256: source.sha256,
      textId,
      textSnapshot: over.text ?? TEXT,
      textLanguage: "en",
      recipeId: `recipe-${randomUUID().slice(0, 6)}`,
      recipeName: "IT recipe",
      recipeVersion: 3,
      recipeConfig: {} as Prisma.InputJsonValue,
      effective: { values: effective.values, sources: effective.sources, warnings: effective.warnings } as unknown as Prisma.InputJsonValue,
      dedupeKey: randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "").slice(0, 32),
      ...(over.cancelRequested ? { cancelRequestedAt: new Date() } : {}),
    },
  });
  await prisma.mediaRenderJob.update({ where: { id: job.id }, data: { activeKey: job.dedupeKey } });
  const task = await prisma.operationTask.create({ data: { organizationId, type: "RENDER", subjectType: "MediaRenderJob", subjectId: job.id, queueName: "media-render", stage: "Queued", unit: "ms of output" } });
  await prisma.mediaRenderJob.update({ where: { id: job.id }, data: { taskId: task.id } });
  return { job: await prisma.mediaRenderJob.findUniqueOrThrow({ where: { id: job.id } }), task };
}
const jobRow = (id: string) => prisma.mediaRenderJob.findUniqueOrThrow({ where: { id } });
const taskRow = (id: string) => prisma.operationTask.findUniqueOrThrow({ where: { id } });

let wideVideo = "";
let longVideo = "";
let png = "";
let broken = "";

beforeAll(() => {
  if (!enabled) return;
  if (!FFMPEG_AVAILABLE) throw new Error("FFmpeg/ffprobe are required in CI: install ffmpeg before running the tests.");
  root = mkdtempSync(join(tmpdir(), "it-render-root-"));
  library = join(root, "library");
  storage = new LocalAssetStorage({ baseDir: library, baseUrl: "private://media-library" });
  mkdirSync(join(root, "samples"), { recursive: true });
  wideVideo = join(root, "samples", "wide.mp4");
  longVideo = join(root, "samples", "long.mp4");
  png = join(root, "samples", "c.png");
  broken = join(root, "samples", "broken.mp4");
  ff(["-f", "lavfi", "-i", "color=c=black:s=640x360:r=24:d=3", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=3", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", wideVideo]);
  ff(["-f", "lavfi", "-i", "color=c=black:s=1280x720:r=30:d=25", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", longVideo]);
  ff(["-f", "lavfi", "-i", "color=c=black:s=800x600", "-frames:v", "1", png]);
  writeFileSync(broken, Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypisom"), Buffer.alloc(24), Buffer.from("not a real video stream ".repeat(20))]));
}, 180_000);

afterAll(async () => {
  if (!enabled) return;
  await prisma.organization.deleteMany({ where: { slug: { startsWith: "it-render-" } } });
  rmSync(root, { recursive: true, force: true });
  await prisma.$disconnect();
});

suite("rendering in the worker (real MySQL, real FFmpeg, real storage)", () => {
  it("renders a video into the library: a validated MP4 with its audio, real progress, provenance, thumbnail, and the source untouched", async () => {
    const org = await makeOrg("video");
    const source = await seedSource(org.id, wideVideo, "VIDEO", { width: 640, height: 360, durationMs: 3000, hasAudio: true });
    const before = sha(readFileSync(join(library, source.storageKey!)));
    const { job, task } = await seedJob(org.id, source, { config: { duration: { mode: "SOURCE" }, animation: { entry: "FADE_IN", exit: "FADE_OUT" } } });
    const { deps, updates } = makeDeps();

    await runRenderJob(job.id, task.id, deps);

    const done = await jobRow(job.id);
    expect(done.status).toBe("SUCCEEDED");
    expect(done.errorCode).toBeNull();
    expect(done.outputKind).toBe("VIDEO");
    expect(done.attempts).toBe(1);
    const output = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: done.outputAssetId! }, include: { derivatives: true, tags: true } });
    expect(output).toMatchObject({ origin: "RENDER", renderJobId: job.id, kind: "VIDEO", status: "READY", mimeType: "video/mp4", folderPath: "Renders", width: 720, height: 1280, videoCodec: "h264", audioCodec: "aac", hasAudio: true });
    expect(Math.abs(output.durationMs! - 3000)).toBeLessThanOrEqual(300);
    expect(output.derivatives.map((d) => d.kind)).toContain("THUMBNAIL");
    expect(output.tags.map((t) => t.tag)).toContain("rendered");
    expect(existsSync(join(library, output.storageKey!))).toBe(true);
    // the output is a genuine file: it passes the same checks the worker applied
    const check = await validateOutput(FFMPEG, FFPROBE, join(library, output.storageKey!), { kind: "VIDEO", width: 720, height: 1280, durationMs: 3000, fps: 24, hasAudio: true, videoCodec: "h264" });
    expect(check.ok).toBe(true);
    // provenance: the frozen settings, the plan, the fonts and the validation are recorded
    const result = done.result as { frame: { width: number }; lines: { text: string }[]; fonts: { used: { fontId: string } }; validation: { ok: boolean }; warnings: string[]; timeline: { entry: { kind: string } } };
    expect(result.frame.width).toBe(720);
    expect(result.lines.map((l) => l.text).join(" ")).toBe(TEXT);
    expect(result.validation.ok).toBe(true);
    expect(result.timeline.entry.kind).toBe("FADE_IN");
    expect(done.recipeVersion).toBe(3);
    expect(done.textSnapshot).toBe(TEXT);
    // the original is byte-for-byte what it was
    expect(sha(readFileSync(join(library, source.storageKey!)))).toBe(before);
    expect((await prisma.mediaAsset.findUniqueOrThrow({ where: { id: source.id } })).sha256).toBe(source.sha256);
    // real progress: no total while preparing, then the real output length, never ahead, ending complete
    const t = await taskRow(task.id);
    expect(t).toMatchObject({ status: "SUCCEEDED", totalUnits: 3000, completedUnits: 3000, unit: "ms of output" });
    expect(updates[0]!.totalUnits).toBeNull();
    const withTotal = updates.filter((u) => u.totalUnits !== null);
    expect(withTotal.length).toBeGreaterThan(0);
    let last = 0;
    for (const u of withTotal) {
      expect(u.completedUnits).toBeLessThanOrEqual(u.totalUnits!);
      expect(u.completedUnits).toBeGreaterThanOrEqual(last);
      last = u.completedUnits;
    }
    expect(updates.map((u) => u.stage)).toEqual(expect.arrayContaining(["Preparing", "Reading the source file", "Encoding the video", "Saving the output to the Media Library"]));
  });

  it("renders a still image: a JPEG or PNG in the library with no progress total (nothing measurable)", async () => {
    const org = await makeOrg("still");
    const source = await seedSource(org.id, png, "IMAGE", { width: 800, height: 600 });
    const { job, task } = await seedJob(org.id, source, { config: { duration: { mode: "SOURCE" }, aspectRatio: "1:1" } });
    const { deps, updates } = makeDeps();
    await runRenderJob(job.id, task.id, deps);
    const done = await jobRow(job.id);
    expect(done.status).toBe("SUCCEEDED");
    const output = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: done.outputAssetId! } });
    expect(output).toMatchObject({ kind: "IMAGE", mimeType: "image/png", width: 720, height: 720, status: "READY" });
    expect(updates.every((u) => u.totalUnits === null)).toBe(true);
  });

  it("an image rendered to a video of a fixed length has no audio track", async () => {
    const org = await makeOrg("imgvideo");
    const source = await seedSource(org.id, png, "IMAGE", { width: 800, height: 600 });
    const { job, task } = await seedJob(org.id, source, { config: { duration: { mode: "FIXED", seconds: 2 } } });
    await runRenderJob(job.id, task.id, makeDeps().deps);
    const output = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: (await jobRow(job.id)).outputAssetId! } });
    expect(output).toMatchObject({ kind: "VIDEO", hasAudio: false, audioCodec: null });
  });

  it("links the output to the campaign and page group of the render", async () => {
    const org = await makeOrg("links");
    const campaign = await prisma.campaign.create({ data: { organizationId: org.id, name: "C" } });
    const group = await prisma.pageGroup.create({ data: { organizationId: org.id, name: "G", slug: "g" } });
    const source = await seedSource(org.id, png, "IMAGE", { width: 800, height: 600 });
    const { job, task } = await seedJob(org.id, source, { config: { duration: { mode: "SOURCE" } } });
    await prisma.mediaRenderJob.update({ where: { id: job.id }, data: { campaignId: campaign.id, pageGroupId: group.id } });
    await runRenderJob(job.id, task.id, makeDeps().deps);
    const outId = (await jobRow(job.id)).outputAssetId!;
    expect(await prisma.mediaAssetCampaign.count({ where: { assetId: outId, campaignId: campaign.id } })).toBe(1);
    expect(await prisma.mediaAssetPageGroup.count({ where: { assetId: outId, groupId: group.id } })).toBe(1);
  });

  it("a job delivered again after it finished changes nothing: still one output, still succeeded", async () => {
    const org = await makeOrg("again");
    const source = await seedSource(org.id, png, "IMAGE", { width: 800, height: 600 });
    const { job, task } = await seedJob(org.id, source, { config: { duration: { mode: "SOURCE" } } });
    await runRenderJob(job.id, task.id, makeDeps().deps);
    const first = await jobRow(job.id);
    await runRenderJob(job.id, task.id, makeDeps({ compose: () => Promise.reject(new Error("must not render twice")) }).deps);
    const second = await jobRow(job.id);
    expect(second.status).toBe("SUCCEEDED");
    expect(second.outputAssetId).toBe(first.outputAssetId);
    expect(await prisma.mediaAsset.count({ where: { renderJobId: job.id } })).toBe(1);
    expect((await taskRow(task.id)).status).toBe("SUCCEEDED");
  });

  it("records the use of the text in its usage history exactly once, also when the job is delivered again or the output is adopted", async () => {
    const org = await makeOrg("usage");
    const source = await seedSource(org.id, png, "IMAGE", { width: 800, height: 600 });
    const { job, task } = await seedJob(org.id, source, { config: { duration: { mode: "SOURCE" } }, realText: true });
    await runRenderJob(job.id, task.id, makeDeps().deps);
    const done = await jobRow(job.id);
    const usages = await prisma.textUsage.findMany({ where: { textId: job.textId } });
    expect(usages).toHaveLength(1);
    expect(usages[0]).toMatchObject({ kind: "RENDER", mediaAssetId: done.outputAssetId, recipeId: job.recipeId, organizationId: org.id });
    // delivered again after success, and delivered again after a crash before "succeeded" was recorded
    await runRenderJob(job.id, task.id, makeDeps({ compose: () => Promise.reject(new Error("must not render twice")) }).deps);
    await prisma.mediaRenderJob.update({ where: { id: job.id }, data: { status: "RUNNING", outputAssetId: null, finishedAt: null } });
    await prisma.operationTask.update({ where: { id: task.id }, data: { status: "RUNNING", finishedAt: null } });
    await runRenderJob(job.id, task.id, makeDeps({ compose: () => Promise.reject(new Error("must not render again")) }).deps);
    expect(await prisma.textUsage.count({ where: { textId: job.textId } })).toBe(1);
  });

  it("survives a worker that dies mid-render: the job stays running, BullMQ delivers it again, and it ends with exactly one output", async () => {
    const org = await makeOrg("crash");
    const source = await seedSource(org.id, wideVideo, "VIDEO", { width: 640, height: 360, durationMs: 3000, hasAudio: true });
    const { job, task } = await seedJob(org.id, source, { config: { duration: { mode: "SOURCE" } } });
    // first attempt: the process "dies" (the compose step throws something that is not a render outcome)
    const crash = makeDeps({ compose: () => Promise.reject(new Error("worker process killed")) });
    await expect(runRenderJob(job.id, task.id, crash.deps)).rejects.toThrow("worker process killed");
    expect((await jobRow(job.id)).status).toBe("RUNNING");
    expect((await taskRow(task.id)).status).toBe("RUNNING");
    // second attempt: a fresh worker takes over and finishes
    const { deps } = makeDeps();
    await runRenderJob(job.id, task.id, deps);
    const done = await jobRow(job.id);
    expect(done.status).toBe("SUCCEEDED");
    expect(done.attempts).toBe(2);
    expect(await prisma.mediaAsset.count({ where: { renderJobId: job.id } })).toBe(1);
    expect((await taskRow(task.id)).status).toBe("SUCCEEDED");
    // the dead attempt's scratch directory is gone, and progress started over for the new attempt
    expect(readdirSync(root).filter((n) => n.startsWith("socialith-render-"))).toEqual([]);
  });

  it("adopts an output that was stored just before a crash instead of rendering it a second time", async () => {
    const org = await makeOrg("adopt");
    const source = await seedSource(org.id, png, "IMAGE", { width: 800, height: 600 });
    const { job, task } = await seedJob(org.id, source, { config: { duration: { mode: "SOURCE" } } });
    await runRenderJob(job.id, task.id, makeDeps().deps);
    const finished = await jobRow(job.id);
    // pretend the worker died after storing and analysing the output but before recording success
    await prisma.mediaRenderJob.update({ where: { id: job.id }, data: { status: "RUNNING", outputAssetId: null, finishedAt: null } });
    await prisma.operationTask.update({ where: { id: task.id }, data: { status: "RUNNING", finishedAt: null } });
    await runRenderJob(job.id, task.id, makeDeps({ compose: () => Promise.reject(new Error("must not render again")) }).deps);
    const adopted = await jobRow(job.id);
    expect(adopted.status).toBe("SUCCEEDED");
    expect(adopted.outputAssetId).toBe(finished.outputAssetId);
    expect(await prisma.mediaAsset.count({ where: { renderJobId: job.id } })).toBe(1);
  });

  it("the database refuses two live jobs for the same render, and two outputs for one job", async () => {
    const org = await makeOrg("dup");
    const source = await seedSource(org.id, png, "IMAGE", { width: 800, height: 600 });
    const a = await seedJob(org.id, source);
    await expect(prisma.mediaRenderJob.create({ data: { ...strip(a.job), id: undefined, activeKey: a.job.activeKey } as never })).rejects.toThrow();
    // once the first one failed (activeKey cleared) the same render may be queued again
    await prisma.mediaRenderJob.update({ where: { id: a.job.id }, data: { status: "FAILED", activeKey: null } });
    const again = await prisma.mediaRenderJob.create({ data: { ...strip(a.job), id: undefined, activeKey: a.job.dedupeKey } as never });
    expect(again.id).not.toBe(a.job.id);
    // one output asset per job
    await prisma.mediaAsset.create({ data: { organizationId: org.id, originalName: "o1.mp4", kind: "VIDEO", status: "READY", mimeType: "video/mp4", sizeBytes: BigInt(1), sha256: "a".repeat(64), origin: "RENDER", renderJobId: again.id } });
    await expect(prisma.mediaAsset.create({ data: { organizationId: org.id, originalName: "o2.mp4", kind: "VIDEO", status: "READY", mimeType: "video/mp4", sizeBytes: BigInt(1), sha256: "b".repeat(64), origin: "RENDER", renderJobId: again.id } })).rejects.toThrow();
  });
});

const strip = (row: Record<string, unknown>) => {
  const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = row;
  return { ...rest, recipeConfig: rest.recipeConfig as Prisma.InputJsonValue, effective: rest.effective as Prisma.InputJsonValue, adjustment: undefined, result: undefined };
};

suite("renders that fail, are refused or are cancelled", () => {
  it("refuses text the font cannot draw, with a reason and what to do, and makes no output", async () => {
    const org = await makeOrg("refuse");
    const source = await seedSource(org.id, png, "IMAGE", { width: 800, height: 600 });
    const { job, task } = await seedJob(org.id, source, { text: "Hello \u{1F600}", config: { duration: { mode: "SOURCE" } } });
    await runRenderJob(job.id, task.id, makeDeps().deps);
    const done = await jobRow(job.id);
    expect(done).toMatchObject({ status: "FAILED", errorCode: "UNSUPPORTED_TEXT", activeKey: null, outputAssetId: null });
    expect(done.errorRemedy).toContain("Remove");
    const t = await taskRow(task.id);
    expect(t).toMatchObject({ status: "FAILED", errorCode: "UNSUPPORTED_TEXT" });
    expect(t.errorRemedy).toBeTruthy();
    expect(await prisma.mediaAsset.count({ where: { renderJobId: job.id } })).toBe(0);
  });

  it("fails clearly when the source file is gone, has changed, or cannot be decoded", async () => {
    const org = await makeOrg("source");
    const gone = await seedSource(org.id, png, "IMAGE", { width: 800, height: 600 });
    await prisma.mediaAsset.update({ where: { id: gone.id }, data: { storageKey: null } });
    const a = await seedJob(org.id, gone);
    await runRenderJob(a.job.id, a.task.id, makeDeps().deps);
    expect((await jobRow(a.job.id)).errorCode).toBe("SOURCE_MISSING");

    const changed = await seedSource(org.id, png, "IMAGE", { width: 800, height: 600 });
    const b = await seedJob(org.id, { id: changed.id, sha256: "f".repeat(64) });
    await runRenderJob(b.job.id, b.task.id, makeDeps().deps);
    expect((await jobRow(b.job.id)).errorCode).toBe("SOURCE_CHANGED");

    const damaged = await seedSource(org.id, broken, "VIDEO", { width: 640, height: 360, durationMs: 2000 });
    const c = await seedJob(org.id, damaged, { config: { duration: { mode: "SOURCE" } } });
    await runRenderJob(c.job.id, c.task.id, makeDeps().deps);
    const failed = await jobRow(c.job.id);
    expect(failed).toMatchObject({ status: "FAILED", errorCode: "RENDER_FAILED", activeKey: null });
    expect(failed.errorRemedy).toContain("Try again");
    expect((failed.result as { ffmpegStderr: string }).ffmpegStderr.length).toBeGreaterThan(0);
    expect(await prisma.mediaAsset.count({ where: { renderJobId: c.job.id } })).toBe(0);
  });

  it("fails with a configuration error and a remedy when FFmpeg is not installed", async () => {
    const org = await makeOrg("noffmpeg");
    const source = await seedSource(org.id, png, "IMAGE", { width: 800, height: 600 });
    const { job, task } = await seedJob(org.id, source, { config: { duration: { mode: "SOURCE" } } });
    await runRenderJob(job.id, task.id, makeDeps({ env: { FFMPEG_PATH: "definitely-not-ffmpeg", FFPROBE_PATH: FFPROBE } }).deps);
    const done = await jobRow(job.id);
    expect(done.errorCode).toBe("CONFIGURATION_ERROR");
    expect(done.errorRemedy).toContain("install FFmpeg");
  });

  it("a render whose finished file fails its checks ends FAILED, with the checks recorded, and no asset", async () => {
    const org = await makeOrg("invalid");
    const source = await seedSource(org.id, png, "IMAGE", { width: 800, height: 600 });
    const { job, task } = await seedJob(org.id, source, { config: { duration: { mode: "SOURCE" } } });
    const compose = (): Promise<ComposeResult> =>
      Promise.reject(new OutputInvalidError("The rendered file did not pass its checks: dimensions: expected 720 x 720, found 100 x 100.", { ok: false, problems: ["dimensions"], checks: [{ name: "dimensions", ok: false, expected: "720 x 720", actual: "100 x 100" }], facts: { container: null, videoCodec: null, pixelFormat: null, width: 100, height: 100, durationMs: null, fps: null, audioCodec: null, sizeBytes: 5 } }));
    await runRenderJob(job.id, task.id, makeDeps({ compose }).deps);
    const done = await jobRow(job.id);
    expect(done).toMatchObject({ status: "FAILED", errorCode: "OUTPUT_INVALID", outputAssetId: null });
    expect((done.result as { validation: { checks: { ok: boolean }[] } }).validation.checks.some((c) => !c.ok)).toBe(true);
    expect(await prisma.mediaAsset.count({ where: { renderJobId: job.id } })).toBe(0);
  });

  it("a job cancelled before it starts is never rendered", async () => {
    const org = await makeOrg("cancelq");
    const source = await seedSource(org.id, png, "IMAGE", { width: 800, height: 600 });
    const { job, task } = await seedJob(org.id, source, { cancelRequested: true });
    await runRenderJob(job.id, task.id, makeDeps({ compose: () => Promise.reject(new Error("must not start")) }).deps);
    expect(await jobRow(job.id)).toMatchObject({ status: "CANCELLED", activeKey: null });
    expect((await taskRow(task.id)).status).toBe("CANCELLED");
  });

  it("cancelling a running render stops FFmpeg, ends CANCELLED, leaves no output and removes the scratch directory", async () => {
    const org = await makeOrg("cancelrun");
    const source = await seedSource(org.id, longVideo, "VIDEO", { width: 1280, height: 720, durationMs: 25000 });
    const { job, task } = await seedJob(org.id, source, { config: { duration: { mode: "SOURCE" }, aspectRatio: "16:9", export: { resolution: "1080", fps: 30 } } });
    const { deps, updates } = makeDeps({ cancelPollMs: 100 });
    const running = runRenderJob(job.id, task.id, deps);
    // the person cancels as soon as real progress has been reported
    const started = Date.now();
    while (!updates.some((u) => u.totalUnits !== null && u.completedUnits > 0) && Date.now() - started < 60_000) await new Promise((r) => setTimeout(r, 50));
    await prisma.mediaRenderJob.update({ where: { id: job.id }, data: { cancelRequestedAt: new Date() } });
    await running;
    expect(await jobRow(job.id)).toMatchObject({ status: "CANCELLED", activeKey: null, outputAssetId: null });
    expect(await taskRow(task.id)).toMatchObject({ status: "CANCELLED" });
    expect(await prisma.mediaAsset.count({ where: { renderJobId: job.id } })).toBe(0);
    expect(readdirSync(root).filter((n) => n.startsWith("socialith-render-"))).toEqual([]);
  });

  it("removes work directories a killed worker left behind, but not fresh ones", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "it-render-stale-"));
    const old = join(scratch, "socialith-render-oldoldol");
    const young = join(scratch, "socialith-render-newnewnw");
    const other = join(scratch, "unrelated-folder");
    for (const d of [old, young, other]) mkdirSync(d);
    const past = new Date(Date.now() - 3 * 3600_000);
    utimesSync(old, past, past);
    utimesSync(other, past, past);
    expect(await cleanupStaleRenderDirs(scratch)).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(young)).toBe(true);
    expect(existsSync(other)).toBe(true);
    rmSync(scratch, { recursive: true, force: true });
  });
});
