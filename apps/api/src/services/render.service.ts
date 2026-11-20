import { createHash } from "node:crypto";
import { prisma } from "@socialith/database";
import type { MediaRenderJob, Prisma, RenderJobStatus } from "@socialith/database";
import { matchRecipeToPage, parseRecipeConfig, recipeAdjustmentSchema, type RecipeAdjustment, type RecipeMatch } from "@socialith/studio";
import { ERROR_CODES } from "@socialith/types";
import { ApiHttpError } from "../middleware/error-handler.js";
import { enqueueMediaRender, QueueUnavailableError, removeQueuedMediaRender } from "../lib/queue.js";
import { createAuditLog } from "../repositories/audit-log.repository.js";
import type { SafeUser } from "../types/auth.js";
import { ASSET_INCLUDE, assetDto, conflict, notFound } from "./media-common.js";
import { createTask, taskDto } from "./operation-task.service.js";
import { evaluate } from "./recipe.service.js";

const audit = (actor: SafeUser, action: Parameters<typeof createAuditLog>[0]["action"], targetId: string, metadata?: Record<string, unknown>) =>
  createAuditLog({ organizationId: actor.organizationId, userId: actor.id, action, targetType: "MediaRenderJob", targetId, ...(metadata ? { metadata } : {}) });
const bad = (message: string, details?: unknown) => new ApiHttpError(400, ERROR_CODES.INVALID_REQUEST, message, details);
const isUnique = (err: unknown) => typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const ACTIVE: RenderJobStatus[] = ["QUEUED", "RUNNING"];
const FINISHED: RenderJobStatus[] = ["SUCCEEDED", "FAILED", "CANCELLED"];

// ------------------------------------------------------------------------------------------------ choosing the recipe

export interface RecipeCandidate {
  id: string;
  name: string;
  matchedBy: RecipeMatch | "chosen";
  mediaKinds: string[];
}

/**
 * Which recipe applies. If the person named one, that one. Otherwise, for a page: its own recipes first, then its group's,
 * then its category's, then recipes for everyone (the order of Phase 5B), restricted to recipes that accept the media
 * type; for a page group: recipes assigned to the group, then recipes for everyone. Several can fit: the first is chosen
 * and all are returned so the person can pick another.
 */
export async function resolveRecipeChoice(actor: SafeUser, input: { recipeId?: string | undefined; pageId?: string | undefined; groupId?: string | undefined; mediaKind: "IMAGE" | "VIDEO" }): Promise<{ chosen: RecipeCandidate | null; candidates: RecipeCandidate[] }> {
  const org = actor.organizationId;
  const rows = await prisma.contentRecipe.findMany({
    where: { organizationId: org, status: "ACTIVE" },
    include: { pageCategories: true, pageGroups: true, pages: true },
    orderBy: { name: "asc" },
  });
  const kindsOf = (config: unknown) => {
    const parsed = parseRecipeConfig(config);
    return parsed.ok ? parsed.config.compatibleMedia : [];
  };
  const scoped = rows.filter((r) => kindsOf(r.config).includes(input.mediaKind));
  let candidates: RecipeCandidate[] = [];
  if (input.pageId) {
    const page = await prisma.managedPage.findFirst({ where: { id: input.pageId, organizationId: org }, select: { id: true, categoryId: true, groupMemberships: { select: { groupId: true } } } });
    if (!page) throw notFound("Page");
    const rank: Record<RecipeMatch, number> = { page: 0, group: 1, category: 2, everyone: 3 };
    candidates = scoped
      .flatMap((r) => {
        const matchedBy = matchRecipeToPage({ pageIds: r.pages.map((p) => p.pageId), pageGroupIds: r.pageGroups.map((g) => g.groupId), pageCategoryIds: r.pageCategories.map((c) => c.categoryId) }, { id: page.id, categoryId: page.categoryId, groupIds: page.groupMemberships.map((g) => g.groupId) });
        return matchedBy ? [{ id: r.id, name: r.name, matchedBy, mediaKinds: kindsOf(r.config), rank: rank[matchedBy] }] : [];
      })
      .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name))
      .map(({ rank: _rank, ...c }) => c);
  } else if (input.groupId) {
    if (!(await prisma.pageGroup.findFirst({ where: { id: input.groupId, organizationId: org }, select: { id: true } }))) throw notFound("Page group");
    candidates = scoped
      .flatMap((r) => {
        const unrestricted = r.pages.length + r.pageGroups.length + r.pageCategories.length === 0;
        const matchedBy: RecipeMatch | null = r.pageGroups.some((g) => g.groupId === input.groupId) ? "group" : unrestricted ? "everyone" : null;
        return matchedBy ? [{ id: r.id, name: r.name, matchedBy, mediaKinds: kindsOf(r.config) }] : [];
      })
      .sort((a, b) => (a.matchedBy === b.matchedBy ? a.name.localeCompare(b.name) : a.matchedBy === "group" ? -1 : 1));
  }
  if (input.recipeId) {
    const row = rows.find((r) => r.id === input.recipeId);
    if (!row) throw notFound("Recipe");
    const chosen: RecipeCandidate = { id: row.id, name: row.name, matchedBy: "chosen", mediaKinds: kindsOf(row.config) };
    return { chosen, candidates: [chosen, ...candidates.filter((c) => c.id !== row.id)] };
  }
  return { chosen: candidates[0] ?? null, candidates };
}

/** The checks and the plan for a render, before anything is queued: what the Rendering Studio shows next to the "Render" button. */
export async function resolveForRender(actor: SafeUser, input: { assetId: string; textId: string; recipeId?: string | undefined; pageId?: string | undefined; groupId?: string | undefined; adjustment?: RecipeAdjustment | undefined }) {
  const asset = await prisma.mediaAsset.findFirst({ where: { id: input.assetId, organizationId: actor.organizationId }, select: { id: true, kind: true } });
  if (!asset) throw notFound("Media file");
  if (asset.kind !== "IMAGE" && asset.kind !== "VIDEO") throw bad("Only a picture or a video can be rendered.");
  const resolved = await resolveRecipeChoice(actor, { recipeId: input.recipeId, pageId: input.pageId, groupId: input.groupId, mediaKind: asset.kind });
  if (!resolved.chosen) return { ...resolved, evaluation: null };
  const evaluation = await evaluate(actor, { recipeId: resolved.chosen.id, assetId: input.assetId, textId: input.textId, pageId: input.pageId ?? null, groupId: input.groupId ?? null, ...(input.adjustment ? { adjustment: input.adjustment } : {}), purpose: "RENDER" });
  return { ...resolved, evaluation };
}

// ------------------------------------------------------------------------------------------------ DTOs

type JobRow = MediaRenderJob;

async function lookups(rows: JobRow[], organizationId: string) {
  const ids = (pick: (j: JobRow) => string | null) => [...new Set(rows.map(pick).filter((v): v is string => Boolean(v)))];
  const [tasks, outputs, sources, pages, groups] = await Promise.all([
    prisma.operationTask.findMany({ where: { id: { in: ids((j) => j.taskId) } } }),
    prisma.mediaAsset.findMany({ where: { organizationId, id: { in: ids((j) => j.outputAssetId) } }, include: ASSET_INCLUDE }),
    prisma.mediaAsset.findMany({ where: { organizationId, id: { in: ids((j) => j.sourceAssetId) } }, include: ASSET_INCLUDE }),
    prisma.managedPage.findMany({ where: { organizationId, id: { in: ids((j) => j.pageId) } }, select: { id: true, name: true } }),
    prisma.pageGroup.findMany({ where: { organizationId, id: { in: ids((j) => j.pageGroupId) } }, select: { id: true, name: true } }),
  ]);
  return {
    tasks: new Map(tasks.map((t) => [t.id, t])),
    outputs: new Map(outputs.map((a) => [a.id, a])),
    sources: new Map(sources.map((a) => [a.id, a])),
    pages: new Map(pages.map((p) => [p.id, p])),
    groups: new Map(groups.map((g) => [g.id, g])),
  };
}

function renderDto(j: JobRow, l: Awaited<ReturnType<typeof lookups>>, detail: boolean) {
  const task = j.taskId ? l.tasks.get(j.taskId) : undefined;
  const output = j.outputAssetId ? l.outputs.get(j.outputAssetId) : undefined;
  const source = l.sources.get(j.sourceAssetId);
  const result = (j.result ?? null) as Record<string, unknown> | null;
  return {
    id: j.id,
    status: j.status,
    createdAt: j.createdAt,
    startedAt: j.startedAt,
    finishedAt: j.finishedAt,
    attempts: j.attempts,
    retryOfId: j.retryOfId,
    cancelRequested: j.cancelRequestedAt !== null,
    task: task ? taskDto(task) : null,
    source: source ? { id: source.id, name: source.originalName, kind: source.kind, status: source.status, thumbnailUrl: assetDto(source).thumbnailUrl, width: source.width, height: source.height, durationMs: source.durationMs } : { id: j.sourceAssetId, name: null, kind: null, status: null, thumbnailUrl: null, width: null, height: null, durationMs: null },
    text: { id: j.textId, snapshot: detail ? j.textSnapshot : j.textSnapshot.length > 160 ? `${[...j.textSnapshot].slice(0, 160).join("")}...` : j.textSnapshot, language: j.textLanguage },
    recipe: { id: j.recipeId, name: j.recipeName, version: j.recipeVersion },
    page: j.pageId ? (l.pages.get(j.pageId) ?? { id: j.pageId, name: null }) : null,
    group: j.pageGroupId ? (l.groups.get(j.pageGroupId) ?? { id: j.pageGroupId, name: null }) : null,
    campaignId: j.campaignId,
    outputKind: j.outputKind,
    output: output ? assetDto(output) : null,
    error: j.errorCode ? { code: j.errorCode, message: j.errorMessage, remedy: j.errorRemedy } : null,
    warnings: Array.isArray(result?.warnings) ? (result!.warnings as string[]) : [],
    ...(detail
      ? {
          effective: j.effective,
          adjustment: j.adjustment,
          recipeConfig: j.recipeConfig,
          result,
        }
      : {}),
  };
}

// ------------------------------------------------------------------------------------------------ create

export interface CreateRenderInput {
  assetId: string;
  textId: string;
  recipeId?: string | undefined;
  pageId?: string | undefined;
  groupId?: string | undefined;
  campaignId?: string | undefined;
  adjustment?: unknown;
  force?: boolean | undefined;
}

export async function createRender(actor: SafeUser, input: CreateRenderInput) {
  const org = actor.organizationId;
  const adjustment = input.adjustment ? recipeAdjustmentSchema.parse(input.adjustment) : undefined;
  if (input.campaignId && !(await prisma.campaign.findFirst({ where: { id: input.campaignId, organizationId: org }, select: { id: true } }))) throw notFound("Campaign");

  const resolved = await resolveForRender(actor, { assetId: input.assetId, textId: input.textId, recipeId: input.recipeId, pageId: input.pageId, groupId: input.groupId, adjustment });
  if (!resolved.chosen || !resolved.evaluation) throw new ApiHttpError(422, ERROR_CODES.VALIDATION_FAILED, "No recipe suits this page or group and this kind of media. Choose a recipe, or assign one to the page, its group or its category.", { code: "NO_RECIPE" });
  const evaluation = resolved.evaluation;
  const errors = evaluation.issues.filter((i) => i.severity === "ERROR");
  if (errors.length > 0) throw new ApiHttpError(422, ERROR_CODES.VALIDATION_FAILED, `This combination cannot be rendered: ${errors.map((e) => e.message).join(" ")}`, { code: "NOT_RENDERABLE", issues: evaluation.issues });

  const [asset, text, recipe] = await Promise.all([
    prisma.mediaAsset.findFirstOrThrow({ where: { id: input.assetId, organizationId: org } }),
    prisma.textEntry.findFirstOrThrow({ where: { id: input.textId, organizationId: org } }),
    prisma.contentRecipe.findFirstOrThrow({ where: { id: resolved.chosen.id, organizationId: org } }),
  ]);
  const dedupeKey = sha256(JSON.stringify({ asset: asset.id, assetSha: asset.sha256, textSha: sha256(text.body), recipe: recipe.id, values: evaluation.effective.values, page: input.pageId ?? null, group: input.groupId ?? null }));

  const clash = await prisma.mediaRenderJob.findFirst({ where: { organizationId: org, activeKey: dedupeKey } });
  if (clash) {
    if (clash.status === "SUCCEEDED" && input.force === true) {
      await prisma.mediaRenderJob.update({ where: { id: clash.id }, data: { activeKey: null } }); // superseded by the new render
    } else {
      throw conflict(clash.status === "SUCCEEDED" ? "This exact render was already made. Open the result, or render it again on purpose." : "This exact render is already waiting or running.", { code: "DUPLICATE_RENDER", jobId: clash.id, status: clash.status, outputAssetId: clash.outputAssetId, canForce: clash.status === "SUCCEEDED" });
    }
  }

  let job: MediaRenderJob;
  try {
    job = await prisma.mediaRenderJob.create({
      data: {
        organizationId: org,
        sourceAssetId: asset.id,
        sourceSha256: asset.sha256,
        textId: text.id,
        textSnapshot: text.body,
        textLanguage: text.language,
        recipeId: recipe.id,
        recipeName: recipe.name,
        recipeVersion: recipe.version,
        pageId: input.pageId ?? null,
        pageGroupId: input.groupId ?? null,
        campaignId: input.campaignId ?? null,
        recipeConfig: recipe.config as Prisma.InputJsonValue,
        ...(adjustment ? { adjustment: adjustment as unknown as Prisma.InputJsonValue } : {}),
        effective: { values: evaluation.effective.values, sources: evaluation.effective.sources, warnings: evaluation.effective.warnings } as unknown as Prisma.InputJsonValue,
        dedupeKey,
        activeKey: dedupeKey,
        createdById: actor.id,
      },
    });
  } catch (err) {
    if (isUnique(err)) {
      const again = await prisma.mediaRenderJob.findFirst({ where: { organizationId: org, activeKey: dedupeKey } });
      throw conflict("This exact render is already waiting or running.", { code: "DUPLICATE_RENDER", jobId: again?.id, status: again?.status, canForce: false });
    }
    throw err;
  }
  return queueJob(actor, job, "RENDER_REQUESTED", { recipeId: recipe.id, assetId: asset.id, textId: text.id, pageId: input.pageId, groupId: input.groupId });
}

/** The ledger task and the queue job for a render job; if the queue is down the job is failed at once instead of waiting forever. */
async function queueJob(actor: SafeUser, job: MediaRenderJob, action: "RENDER_REQUESTED" | "RENDER_RETRIED", metadata: Record<string, unknown>) {
  const task = await createTask(prisma, { organizationId: actor.organizationId, type: "RENDER", subjectType: "MediaRenderJob", subjectId: job.id, queueName: "media-render", createdById: actor.id, stage: "Queued", unit: "ms of output" });
  await prisma.mediaRenderJob.update({ where: { id: job.id }, data: { taskId: task.id } });
  try {
    await enqueueMediaRender({ kind: "RENDER", taskId: task.id, renderJobId: job.id });
  } catch (err) {
    const message = err instanceof Error ? err.message : "The job could not be queued.";
    await prisma.operationTask.update({ where: { id: task.id }, data: { status: "FAILED", finishedAt: new Date(), errorCode: "CONFIGURATION_ERROR", errorMessage: message, errorRemedy: "Check that Redis and the worker are running, then try again." } });
    await prisma.mediaRenderJob.update({ where: { id: job.id }, data: { status: "FAILED", activeKey: null, errorCode: "CONFIGURATION_ERROR", errorMessage: message, errorRemedy: "Check that Redis and the worker are running, then try again.", finishedAt: new Date() } });
    if (err instanceof QueueUnavailableError) throw new ApiHttpError(503, ERROR_CODES.CONFIGURATION_ERROR, "Background processing is not available right now, so the render was not started. Check that Redis and the worker are running, then try again.");
    throw err;
  }
  await audit(actor, action, job.id, metadata);
  return getRender(actor, job.id);
}

// ------------------------------------------------------------------------------------------------ read

export interface ListRendersQuery {
  state: "active" | "finished" | "all";
  status?: RenderJobStatus | undefined;
  pageId?: string | undefined;
  sourceAssetId?: string | undefined;
  page: number;
  pageSize: number;
}

export async function listRenders(actor: SafeUser, q: ListRendersQuery) {
  const org = actor.organizationId;
  const where: Prisma.MediaRenderJobWhereInput = {
    organizationId: org,
    ...(q.status ? { status: q.status } : q.state === "active" ? { status: { in: ACTIVE } } : q.state === "finished" ? { status: { in: FINISHED } } : {}),
    ...(q.pageId ? { pageId: q.pageId } : {}),
    ...(q.sourceAssetId ? { sourceAssetId: q.sourceAssetId } : {}),
  };
  const [rows, total, grouped] = await Promise.all([
    prisma.mediaRenderJob.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    prisma.mediaRenderJob.count({ where }),
    prisma.mediaRenderJob.groupBy({ by: ["status"], where: { organizationId: org }, _count: { _all: true } }),
  ]);
  const l = await lookups(rows, org);
  const counts: Record<string, number> = { QUEUED: 0, RUNNING: 0, SUCCEEDED: 0, FAILED: 0, CANCELLED: 0 };
  for (const g of grouped) counts[g.status] = g._count._all;
  return { items: rows.map((r) => renderDto(r, l, false)), total, page: q.page, pageSize: q.pageSize, counts };
}

async function loadJob(actor: SafeUser, id: string): Promise<MediaRenderJob> {
  const row = await prisma.mediaRenderJob.findFirst({ where: { id, organizationId: actor.organizationId } });
  if (!row) throw notFound("Render");
  return row;
}

export async function getRender(actor: SafeUser, id: string) {
  const row = await loadJob(actor, id);
  const l = await lookups([row], actor.organizationId);
  const attempts = await prisma.mediaRenderJob.findMany({ where: { organizationId: actor.organizationId, OR: [{ retryOfId: id }, ...(row.retryOfId ? [{ id: row.retryOfId }, { retryOfId: row.retryOfId }] : [])], NOT: { id } }, select: { id: true, status: true, createdAt: true }, orderBy: { createdAt: "asc" } });
  return { ...renderDto(row, l, true), relatedAttempts: attempts };
}

// ------------------------------------------------------------------------------------------------ cancel and retry

/**
 * Cancels a render. One that has not started is taken out of the queue and ends at once. One that is running is told to
 * stop: the worker checks every second, kills FFmpeg and ends it as CANCELLED (until then it still shows as running, with
 * "stopping"). A finished render cannot be cancelled.
 */
export async function cancelRender(actor: SafeUser, id: string) {
  const row = await loadJob(actor, id);
  if (!ACTIVE.includes(row.status)) throw conflict(`A render that is ${row.status.toLowerCase()} cannot be cancelled.`);
  if (row.status === "QUEUED") {
    const moved = await prisma.mediaRenderJob.updateMany({ where: { id, status: "QUEUED" }, data: { status: "CANCELLED", activeKey: null, cancelRequestedAt: new Date(), finishedAt: new Date() } });
    if (moved.count === 1) {
      if (row.taskId) await prisma.operationTask.updateMany({ where: { id: row.taskId, status: { in: ["QUEUED", "RUNNING"] } }, data: { status: "CANCELLED", stage: "Cancelled", finishedAt: new Date() } });
      await removeQueuedMediaRender(id).catch(() => undefined);
      await audit(actor, "RENDER_CANCEL_REQUESTED", id, { was: "QUEUED" });
      return getRender(actor, id);
    }
  }
  // it started (now, or before): the worker stops it
  await prisma.mediaRenderJob.updateMany({ where: { id, status: { in: ACTIVE } }, data: { cancelRequestedAt: new Date() } });
  await audit(actor, "RENDER_CANCEL_REQUESTED", id, { was: "RUNNING" });
  return getRender(actor, id);
}

/**
 * Runs a failed or cancelled render again as a NEW render job with the SAME frozen settings and words (so it is the same
 * render, not whatever the recipe has become). The source file and the text must still be usable.
 */
export async function retryRender(actor: SafeUser, id: string) {
  const org = actor.organizationId;
  const old = await loadJob(actor, id);
  if (old.status !== "FAILED" && old.status !== "CANCELLED") throw conflict(`Only a failed or cancelled render can be retried (this one is ${old.status.toLowerCase()}).`);
  const [asset, text] = await Promise.all([
    prisma.mediaAsset.findFirst({ where: { id: old.sourceAssetId, organizationId: org } }),
    prisma.textEntry.findFirst({ where: { id: old.textId, organizationId: org } }),
  ]);
  if (!asset || asset.status !== "READY" || asset.rightsStatus === "RESTRICTED") throw conflict("The source file is no longer available for rendering (removed, not ready, or marked 'do not use').");
  if (asset.sha256 !== old.sourceSha256) throw conflict("The source file is not the one this render was made for. Start a new render instead.");
  if (!text || text.approvalStatus !== "APPROVED" || text.rightsStatus === "RESTRICTED") throw conflict("The text is no longer approved for use. Approve it again, or start a new render with another text.");
  const clash = await prisma.mediaRenderJob.findFirst({ where: { organizationId: org, activeKey: old.dedupeKey } });
  if (clash) throw conflict("The same render is already waiting, running or finished.", { code: "DUPLICATE_RENDER", jobId: clash.id, status: clash.status });
  let job: MediaRenderJob;
  try {
    job = await prisma.mediaRenderJob.create({
      data: {
        organizationId: org,
        sourceAssetId: old.sourceAssetId,
        sourceSha256: old.sourceSha256,
        textId: old.textId,
        textSnapshot: old.textSnapshot,
        textLanguage: old.textLanguage,
        recipeId: old.recipeId,
        recipeName: old.recipeName,
        recipeVersion: old.recipeVersion,
        pageId: old.pageId,
        pageGroupId: old.pageGroupId,
        campaignId: old.campaignId,
        recipeConfig: old.recipeConfig as Prisma.InputJsonValue,
        ...(old.adjustment ? { adjustment: old.adjustment as Prisma.InputJsonValue } : {}),
        effective: old.effective as Prisma.InputJsonValue,
        dedupeKey: old.dedupeKey,
        activeKey: old.dedupeKey,
        retryOfId: old.id,
        createdById: actor.id,
      },
    });
  } catch (err) {
    if (isUnique(err)) throw conflict("The same render is already waiting or running.", { code: "DUPLICATE_RENDER" });
    throw err;
  }
  return queueJob(actor, job, "RENDER_RETRIED", { retryOf: old.id });
}
