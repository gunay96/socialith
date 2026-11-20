import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Job } from "bullmq";
import { loadEnv, resolveFfprobePath, resolveFontDirs, resolveLibraryStorageConfig, type Env } from "@socialith/config";
import { prisma } from "@socialith/database";
import type { Prisma } from "@socialith/database";
import { libraryKeys, sha256File } from "@socialith/media-pack";
import type { EffectiveValues } from "@socialith/studio";
import type { MediaRenderJobData } from "@socialith/types";
import {
  assertFfmpegAvailable,
  assertFfprobeAvailable,
  composeAndRender,
  OutputInvalidError,
  ProbeError,
  RenderCancelledError,
  RenderFailedError,
  RenderRefusedError,
  RenderTimeoutError,
  resolveAssetStorage,
  type AssetStorage,
  type ComposeResult,
} from "@socialith/video-engine";
import { logger } from "../logger.js";
import { analyzeLocalAsset } from "../media/analyze.js";
import { TaskReporter, type ReporterOptions } from "../tasks/reporter.js";

export interface RenderDeps {
  env: Pick<Env, "FFMPEG_PATH" | "FFPROBE_PATH"> & Partial<Env>;
  /** The PRIVATE library storage: sources are read from it and outputs are written to it. */
  storage: AssetStorage;
  reporter?: ReporterOptions;
  tmpRoot?: string;
  /** Replaceable in tests (to simulate a crash in the middle of a render). */
  compose?: typeof composeAndRender;
  /** How often the worker checks whether the person cancelled. */
  cancelPollMs?: number;
}

export function defaultRenderDeps(): RenderDeps {
  const env = loadEnv();
  return { env, storage: resolveAssetStorage(resolveLibraryStorageConfig(env)) };
}

const DIR_PREFIX = "socialith-render-";

/** Removes work directories left behind by a worker that was killed mid-render (run once when the worker starts). */
export async function cleanupStaleRenderDirs(root: string = tmpdir(), olderThanMs = 60 * 60_000): Promise<number> {
  let removed = 0;
  for (const name of await readdir(root).catch(() => [] as string[])) {
    if (!name.startsWith(DIR_PREFIX)) continue;
    const path = join(root, name);
    const info = await stat(path).catch(() => null);
    if (info && Date.now() - info.mtimeMs > olderThanMs) {
      await rm(path, { recursive: true, force: true }).catch(() => undefined);
      removed++;
    }
  }
  return removed;
}

/** BullMQ entry point. */
export async function processRenderJob(job: Job<MediaRenderJobData>, deps: RenderDeps = defaultRenderDeps()): Promise<void> {
  if (job.data.kind !== "RENDER") throw new Error(`Unknown render job: ${JSON.stringify(job.data)}`);
  return runRenderJob(job.data.renderJobId, job.data.taskId, deps);
}

const slug = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "render";
const MIME: Record<string, string> = { ".mp4": "video/mp4", ".jpg": "image/jpeg", ".png": "image/png" };

interface FailureInfo {
  code: string;
  message: string;
  remedy: string;
  result?: Prisma.InputJsonValue;
}

/**
 * Runs one render job end to end. Safe to run again after a crash or a stall: a finished job is left alone, an output
 * that was already stored is adopted instead of rendered twice (one output asset per job, enforced by a unique index),
 * and a cancelled or failed job stays so. Progress is the real output time FFmpeg reports.
 */
export async function runRenderJob(renderJobId: string, taskId: string, deps: RenderDeps): Promise<void> {
  const reporter = new TaskReporter(taskId, deps.reporter);
  await reporter.start({ stage: "Preparing", stageDetail: null, totalUnits: null, unit: "ms of output", completedUnits: 0 });

  const job = await prisma.mediaRenderJob.findUnique({ where: { id: renderJobId } });
  if (!job) {
    await reporter.fail({ code: "RENDER_JOB_NOT_FOUND", message: "The render job no longer exists.", remedy: "Start the render again." });
    return;
  }
  const finishTaskLike = async () => {
    if (job.status === "SUCCEEDED") await reporter.succeed();
    else if (job.status === "CANCELLED") await reporter.cancel();
    else await reporter.fail({ code: job.errorCode ?? "RENDER_FAILED", message: job.errorMessage ?? "The render failed.", ...(job.errorRemedy ? { remedy: job.errorRemedy } : {}) });
  };
  if (job.status === "SUCCEEDED" || job.status === "FAILED" || job.status === "CANCELLED") {
    await finishTaskLike(); // a re-delivered job that already finished: only make the ledger agree
    return;
  }

  const failJob = async (f: FailureInfo) => {
    await prisma.mediaRenderJob.updateMany({
      where: { id: renderJobId, status: { in: ["QUEUED", "RUNNING"] } },
      data: { status: "FAILED", activeKey: null, errorCode: f.code.slice(0, 64), errorMessage: f.message, errorRemedy: f.remedy, finishedAt: new Date(), ...(f.result ? { result: f.result } : {}) },
    });
    await reporter.fail({ code: f.code, message: f.message, remedy: f.remedy });
  };
  const cancelJob = async () => {
    await prisma.mediaRenderJob.updateMany({ where: { id: renderJobId, status: { in: ["QUEUED", "RUNNING"] } }, data: { status: "CANCELLED", activeKey: null, finishedAt: new Date() } });
    await reporter.cancel();
  };

  if (job.cancelRequestedAt) {
    await cancelJob();
    return;
  }
  const claimed = await prisma.mediaRenderJob.updateMany({ where: { id: renderJobId, status: { in: ["QUEUED", "RUNNING"] } }, data: { status: "RUNNING", startedAt: job.startedAt ?? new Date(), attempts: { increment: 1 } } });
  if (claimed.count === 0) return; // finished or cancelled between the read and now

  // A previous attempt stored the output and died before recording success: adopt it, do not render again.
  const existing = await prisma.mediaAsset.findUnique({ where: { renderJobId } });
  if (existing && existing.status === "READY") {
    await prisma.mediaRenderJob.updateMany({ where: { id: renderJobId, status: "RUNNING" }, data: { status: "SUCCEEDED", outputAssetId: existing.id, outputKind: existing.kind, finishedAt: new Date(), errorCode: null, errorMessage: null, errorRemedy: null } });
    await reporter.succeed();
    return;
  }

  const source = await prisma.mediaAsset.findFirst({ where: { id: job.sourceAssetId, organizationId: job.organizationId } });
  if (!source || !source.storageKey || (source.kind !== "IMAGE" && source.kind !== "VIDEO")) {
    await failJob({ code: "SOURCE_MISSING", message: "The source picture or video no longer exists in the library.", remedy: "Choose another source file and render again." });
    return;
  }
  if (source.sha256 !== job.sourceSha256) {
    await failJob({ code: "SOURCE_CHANGED", message: "The source file is not the one this render was requested for.", remedy: "Start a new render with the file you want." });
    return;
  }

  const values = (job.effective as unknown as { values: EffectiveValues }).values;
  const workDir = await mkdtemp(join(deps.tmpRoot ?? tmpdir(), `${DIR_PREFIX}${randomUUID().slice(0, 8)}-`));
  const abort = new AbortController();
  let cancelWatch: ReturnType<typeof setInterval> | undefined;
  try {
    await assertFfmpegAvailable(deps.env.FFMPEG_PATH);
    const ffprobePath = deps.env.FFPROBE_PATH ?? resolveFfprobePath(deps.env as Env);
    await assertFfprobeAvailable(ffprobePath);

    // the person can cancel at any time: checked once a second, for stills too (they report no progress)
    cancelWatch = setInterval(() => {
      void prisma.mediaRenderJob.findUnique({ where: { id: renderJobId }, select: { cancelRequestedAt: true } }).then((row) => {
        if (row?.cancelRequestedAt) abort.abort();
      });
    }, deps.cancelPollMs ?? 1000);

    await reporter.stage("Reading the source file", source.originalName);
    const ext = source.originalName.slice(source.originalName.lastIndexOf(".")).toLowerCase();
    const localSource = join(workDir, `source${ext}`);
    await deps.storage.downloadToFile(source.storageKey, localSource);
    // the fingerprint taken when the render was requested must still describe the bytes that are about to be rendered
    if ((await sha256File(localSource)) !== job.sourceSha256) {
      await failJob({ code: "SOURCE_CHANGED", message: "The stored source file no longer matches the fingerprint taken when this render was requested; it was modified or damaged after that.", remedy: "Restore the original file, or start a new render from the file you want." });
      return;
    }

    let totalSet = false;
    const compose = deps.compose ?? composeAndRender;
    const outputName = values.durationMode === "FIXED" || source.kind === "VIDEO" ? "output.mp4" : values.imageFormat === "JPEG" ? "output.jpg" : "output.png";
    const result: ComposeResult = await compose({
      ffmpegPath: deps.env.FFMPEG_PATH,
      ffprobePath,
      workDir,
      source: { path: localSource, kind: source.kind, hasAudio: source.hasAudio === true, durationMs: source.durationMs, width: source.width, height: source.height },
      values,
      text: job.textSnapshot,
      language: job.textLanguage,
      outputPath: join(workDir, outputName),
      ...(resolveFontDirs(deps.env as Env) ? { fontDirs: resolveFontDirs(deps.env as Env)! } : {}),
      x264: { preset: deps.env.RENDER_X264_PRESET ?? "veryfast", crf: deps.env.RENDER_X264_CRF ?? 21 },
      timeoutMs: deps.env.RENDER_TIMEOUT_MS ?? 900_000,
      signal: abort.signal,
      onStage: (stage) => void reporter.stage(stage),
      onProgress: (producedMs, totalMs) => {
        // the total is known only now (the length of what is being produced); from here the percentage is real
        if (!totalSet) {
          totalSet = true;
          void reporter.setTotal(totalMs, "ms of output");
        }
        void reporter.progress(producedMs);
      },
    });
    if (abort.signal.aborted) throw new RenderCancelledError();

    await reporter.stage("Saving the output to the Media Library");
    const outPath = join(workDir, outputName);
    const outExt = outputName.slice(outputName.lastIndexOf("."));
    const key = libraryKeys.render(job.organizationId, job.id, outExt);
    await deps.storage.putFile(key, outPath, { contentType: MIME[outExt] ?? "application/octet-stream", overwrite: true });
    const sha256 = await sha256File(outPath);
    const outKind = result.outputKind === "VIDEO" ? "VIDEO" : "IMAGE";
    const aspect = values.aspectRatio.replace(":", "x");
    const asset = await prisma.mediaAsset.upsert({
      where: { renderJobId },
      update: {},
      create: {
        organizationId: job.organizationId,
        folderPath: "Renders",
        originalName: `${slug(job.recipeName)}-${aspect}-${job.id.slice(-6)}${outExt}`,
        kind: outKind,
        status: "ANALYZING",
        mimeType: MIME[outExt] ?? "application/octet-stream",
        sizeBytes: BigInt((await stat(outPath)).size),
        sha256,
        storageKey: key,
        origin: "RENDER",
        renderJobId,
        rightsNotes: `Rendered from "${source.originalName}" (rights: ${source.rightsStatus.toLowerCase()}) with the recipe "${job.recipeName}". An administrator confirms the usage rights of the result.`,
        createdById: job.createdById,
        tags: { create: [{ organizationId: job.organizationId, tag: "rendered" }] },
        ...(job.campaignId ? { campaigns: { create: [{ campaignId: job.campaignId }] } } : {}),
        ...(job.pageGroupId ? { pageGroups: { create: [{ groupId: job.pageGroupId }] } } : {}),
      },
    });
    await reporter.stage("Measuring the output and making its thumbnail");
    const analysis = await analyzeLocalAsset({ ffmpegPath: deps.env.FFMPEG_PATH, ffprobePath, storage: deps.storage, workDir }, { id: asset.id, organizationId: asset.organizationId, kind: asset.kind, originalName: asset.originalName }, outPath);
    if (analysis.status === "FAILED") {
      await failJob({ code: "OUTPUT_UNREADABLE", message: `The rendered file could not be analyzed: ${analysis.reason}`, remedy: "Render again. If it keeps failing, ask an administrator to check the worker logs." });
      return;
    }

    // The text's usage history (Phase 5B, TD-68): one RENDER entry per output, written before the job is marked done so a
    // crash in between leaves exactly one entry after the re-delivery.
    if (!(await prisma.textUsage.findFirst({ where: { organizationId: job.organizationId, kind: "RENDER", mediaAssetId: asset.id }, select: { id: true } }))) {
      try {
        await prisma.textUsage.create({
          data: { organizationId: job.organizationId, textId: job.textId, kind: "RENDER", note: `Rendered with the recipe "${job.recipeName}".`.slice(0, 500), pageId: job.pageId, campaignId: job.campaignId, recipeId: job.recipeId, mediaAssetId: asset.id, recordedById: job.createdById },
        });
      } catch (err) {
        // the library text was deleted while the render ran: there is nothing to log the use against (the render keeps its own copy of the words)
        if ((err as { code?: string }).code !== "P2003") throw err;
      }
    }

    const summary = {
      outputKind: result.outputKind,
      durationMs: result.durationMs,
      elapsedMs: result.elapsedMs,
      frame: result.plan.frame,
      fontSizePx: result.plan.fontSizePx,
      requestedFontSizePx: result.plan.requestedFontSizePx,
      lines: result.plan.lines.map((l) => ({ text: l.text, leftPx: l.leftPx, topPx: l.topPx, baselinePx: l.baselinePx, widthPx: Math.round(l.widthPx) })),
      block: { outer: result.plan.outer, inner: result.plan.inner, safeArea: result.plan.safeArea },
      adjustments: result.plan.adjustments,
      fonts: { requested: result.fonts.requested, used: result.fonts.used, fallback: result.fonts.fallback, standIn: result.fonts.standIn, note: result.fonts.note },
      timeline: { entry: result.timeline.entry, exit: result.timeline.exit, reveal: { kind: result.timeline.reveal.kind, durationMs: result.timeline.reveal.durationMs } },
      subtitleCues: result.subtitles.cues.length,
      readability: result.readability,
      warnings: result.warnings,
      validation: { ok: result.validation.ok, checks: result.validation.checks, facts: result.validation.facts },
      filtergraph: result.filtergraph.slice(0, 30_000),
    };
    await prisma.mediaRenderJob.updateMany({
      where: { id: renderJobId, status: "RUNNING" },
      data: { status: "SUCCEEDED", outputAssetId: asset.id, outputKind: result.outputKind, result: summary as unknown as Prisma.InputJsonValue, finishedAt: new Date(), errorCode: null, errorMessage: null, errorRemedy: null },
    });
    await reporter.succeed();
  } catch (err) {
    await handleFailure(err, { renderJobId, failJob, cancelJob, abort });
  } finally {
    if (cancelWatch) clearInterval(cancelWatch);
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function handleFailure(err: unknown, ctx: { renderJobId: string; failJob: (f: FailureInfo) => Promise<void>; cancelJob: () => Promise<void>; abort: AbortController }): Promise<void> {
  if (err instanceof RenderCancelledError || ctx.abort.signal.aborted) return ctx.cancelJob();
  if (err instanceof RenderRefusedError) return ctx.failJob({ code: err.code, message: err.message, remedy: err.remedy });
  if (err instanceof RenderTimeoutError) return ctx.failJob({ code: "RENDER_TIMEOUT", message: err.message, remedy: "Use a shorter clip or a lower export size, or ask an administrator to raise RENDER_TIMEOUT_MS." });
  if (err instanceof OutputInvalidError) {
    return ctx.failJob({ code: "OUTPUT_INVALID", message: err.message, remedy: "Render again. If the same checks keep failing, ask an administrator to check FFmpeg on the worker.", result: { validation: { ok: false, checks: err.validation.checks, facts: err.validation.facts } } as unknown as Prisma.InputJsonValue });
  }
  if (err instanceof RenderFailedError) {
    logger.error({ renderJobId: ctx.renderJobId, stderr: err.stderrTail }, "FFmpeg failed while rendering");
    return ctx.failJob({ code: "RENDER_FAILED", message: `FFmpeg could not render this: ${err.stderrTail.trim().split("\n").slice(-2).join(" ").slice(0, 300) || err.message}`, remedy: "Try again. If it keeps failing, the source file may be damaged: upload it again, or ask an administrator to check the worker logs.", result: { ffmpegStderr: err.stderrTail.slice(-2000) } as unknown as Prisma.InputJsonValue });
  }
  if ((err instanceof ProbeError && err.errorCode === "CONFIGURATION_ERROR") || (err instanceof Error && err.name === "FfmpegUnavailableError")) {
    return ctx.failJob({ code: "CONFIGURATION_ERROR", message: err.message, remedy: "An administrator must install FFmpeg (it includes ffprobe) on the worker, then try the render again." });
  }
  throw err; // anything else (a database or storage hiccup) is retried by BullMQ; the failed handler records the end if it never recovers
}
