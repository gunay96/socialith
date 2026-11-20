import { randomUUID } from "node:crypto";
import { Queue } from "bullmq";
import Redis from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@socialith/database";
import { QUEUE_NAMES, mediaRenderJobId } from "@socialith/types";
import { addUser, audit, get, makeOrg, post, seedAsset, seedNetwork, useServer, type Paged, type Session } from "./studio-harness.js";

/**
 * Rendering requests (Phase 5C) through the REAL express app against REAL MySQL and Redis/BullMQ: which recipe is chosen,
 * what is refused before anything is queued, that an identical render can never be queued twice (even at the same
 * instant), cancel and retry, and what the lists and details show. The worker's rendering is covered by the worker
 * integration tests; here nothing is rendered.
 */
const enabled = Boolean(process.env.MYSQL_INTEGRATION_URL && process.env.REDIS_INTEGRATION_URL);
const suite = enabled ? describe : describe.skip;
const SLUG = "it-render-api-";
useServer(SLUG);

let redis: Redis;
let renderQueue: Queue;
beforeAll(async () => {
  if (!enabled) return;
  redis = new Redis(process.env.REDIS_INTEGRATION_URL!, { maxRetriesPerRequest: null });
  renderQueue = new Queue(QUEUE_NAMES.MEDIA_RENDER, { connection: redis });
});
afterAll(async () => {
  if (!enabled) return;
  await renderQueue.obliterate({ force: true }).catch(() => undefined);
  await renderQueue.close();
  redis.disconnect();
});

interface RenderDto {
  id: string; status: string; attempts: number; retryOfId: string | null; cancelRequested: boolean;
  task: { id: string; status: string; type: string; unit: string | null; progress: { mode: string } } | null;
  source: { id: string; name: string | null }; text: { id: string; snapshot: string }; recipe: { id: string; name: string; version: number };
  page: { id: string; name: string | null } | null; group: { id: string; name: string | null } | null;
  output: { id: string; kind: string; contentUrl: string | null } | null; outputKind: string | null;
  error: { code: string; message: string | null; remedy: string | null } | null; warnings: string[];
  effective?: { values: Record<string, unknown>; sources: Record<string, string> }; adjustment?: unknown; recipeConfig?: unknown; relatedAttempts?: { id: string }[];
}
interface Resolved {
  chosen: { id: string; name: string; matchedBy: string } | null;
  candidates: { id: string; name: string; matchedBy: string }[];
  evaluation: { blocking: boolean; issues: { code: string; severity: string }[]; plan: { lines: { text: string }[]; frame: { width: number; height: number } }; output: { kind: string; durationMs: number } | null } | null;
}
type Err = { code?: string; jobId?: string; status?: string; canForce?: boolean; issues?: { code: string }[] };

const admin = () => makeOrg(SLUG, "ADMIN");
const colleague = (s: Session, role: "ADMIN" | "EDITOR" | "VIEWER") => addUser(s.orgId, role, "it-render-api");

async function seedText(s: Session, text: string, over: { status?: "APPROVED" | "PENDING" | "ARCHIVED"; rights?: "UNVERIFIED" | "CONFIRMED" | "RESTRICTED"; language?: string } = {}) {
  return prisma.textEntry.create({
    data: { organizationId: s.orgId, body: text, normalizedHash: randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, ""), searchText: text.toLowerCase(), charCount: text.length, language: over.language ?? "en", approvalStatus: over.status ?? "APPROVED", rightsStatus: over.rights ?? "UNVERIFIED" },
  });
}
async function seedRecipe(s: Session, name: string, config: Record<string, unknown> = {}, scope: { pageIds?: string[]; pageGroupIds?: string[]; pageCategoryIds?: string[] } = {}) {
  const r = await post<{ id: string }>(s, "/api/recipes", { name, config: { aspectRatio: "9:16", typography: { font: "liberation-sans" }, duration: { mode: "FIXED", seconds: 2 }, ...config }, ...scope });
  expect(r.status, r.text).toBe(201);
  return r.json.data;
}
const request = (s: Session, body: Record<string, unknown>) => post<RenderDto>(s, "/api/renders", body);

async function world() {
  const s = await admin();
  const net = await seedNetwork(s.orgId);
  const asset = await seedAsset(s.orgId, { width: 1920, height: 1080 });
  const text = await seedText(s, "Never give up on the thing you started.");
  const recipe = await seedRecipe(s, "Everyone");
  return { s, net, asset, text, recipe };
}

suite("which recipe is used", () => {
  it("offers a page's own recipes first, then its group's, then its category's, then everyone's, restricted to the media type", async () => {
    const { s, net, asset, text } = await world();
    const page = await seedRecipe(s, "A page", {}, { pageIds: [net.page.id] });
    const group = await seedRecipe(s, "B group", {}, { pageGroupIds: [net.group.id] });
    const category = await seedRecipe(s, "C category", {}, { pageCategoryIds: [net.category.id] });
    await seedRecipe(s, "D videos only", { compatibleMedia: ["VIDEO"] }, { pageIds: [net.page.id] });
    await seedRecipe(s, "E elsewhere", {}, { pageIds: [net.other.id] });
    const r = await post<Resolved>(s, "/api/renders/resolve", { assetId: asset.id, textId: text.id, pageId: net.page.id });
    expect(r.status, r.text).toBe(200);
    expect(r.json.data.candidates.map((c) => [c.name, c.matchedBy])).toEqual([["A page", "page"], ["B group", "group"], ["C category", "category"], ["Everyone", "everyone"]]);
    expect(r.json.data.chosen?.id).toBe(page.id);
    expect(r.json.data.evaluation?.plan.lines.length).toBeGreaterThan(0);
    expect(r.json.data.evaluation?.output).toMatchObject({ kind: "VIDEO", durationMs: 2000 });
    // a named recipe wins and still shows the others
    const named = await post<Resolved>(s, "/api/renders/resolve", { assetId: asset.id, textId: text.id, pageId: net.page.id, recipeId: category.id });
    expect(named.json.data.chosen).toMatchObject({ id: category.id, matchedBy: "chosen" });
    expect(named.json.data.candidates).toHaveLength(4);
    // a page group target: the group's recipe, then everyone's
    const forGroup = await post<Resolved>(s, "/api/renders/resolve", { assetId: asset.id, textId: text.id, groupId: net.group.id });
    expect(forGroup.json.data.candidates.map((c) => [c.name, c.matchedBy])).toEqual([["B group", "group"], ["Everyone", "everyone"]]);
    expect(group.id).toBeTruthy();
  });

  it("says plainly when no recipe fits, and needs a recipe or a page to choose one", async () => {
    const s = await admin();
    const net = await seedNetwork(s.orgId);
    const asset = await seedAsset(s.orgId, {});
    const text = await seedText(s, "Hello");
    await seedRecipe(s, "Videos only", { compatibleMedia: ["VIDEO"] });
    const none = await post<Resolved>(s, "/api/renders/resolve", { assetId: asset.id, textId: text.id, pageId: net.page.id });
    expect(none.json.data.chosen).toBeNull();
    const refused = await request(s, { assetId: asset.id, textId: text.id, pageId: net.page.id });
    expect(refused.status).toBe(422);
    expect((refused.json.error?.details as Err).issues ?? []).toEqual([]);
    expect(refused.json.error?.message).toContain("No recipe suits");
    const bare = await request(s, { assetId: asset.id, textId: text.id });
    expect(bare.status).toBe(422); // neither a recipe nor a page or group to choose one for
  });
});

suite("a render request: checked, then queued once", () => {
  it("queues one job with its frozen settings, words and provenance, a ledger task and ONE queue job under a deterministic id", async () => {
    const { s, net, asset, text, recipe } = await world();
    const r = await request(s, { assetId: asset.id, textId: text.id, pageId: net.page.id, groupId: net.group.id, recipeId: recipe.id, campaignId: net.campaign.id });
    expect(r.status, r.text).toBe(202);
    const job = r.json.data;
    expect(job).toMatchObject({ status: "QUEUED", attempts: 0, retryOfId: null, cancelRequested: false, recipe: { id: recipe.id, name: "Everyone", version: 1 }, text: { id: text.id, snapshot: "Never give up on the thing you started." } });
    expect(job.page?.id).toBe(net.page.id);
    expect(job.group?.id).toBe(net.group.id);
    expect(job.task).toMatchObject({ status: "QUEUED", type: "RENDER", unit: "ms of output" });
    expect(job.task!.progress.mode).not.toBe("determinate"); // nothing measured yet: no percentage
    // frozen: the effective values (with their sources), the recipe configuration and the asset's fingerprint
    const detail = await get<RenderDto>(s, `/api/renders/${job.id}`);
    expect(detail.json.data.effective?.values).toMatchObject({ aspectRatio: "9:16", font: "liberation-sans", durationMode: "FIXED" });
    expect(detail.json.data.effective?.sources.aspectRatio).toBe("recipe");
    const row = await prisma.mediaRenderJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(row).toMatchObject({ sourceAssetId: asset.id, sourceSha256: asset.sha256, activeKey: row.dedupeKey, campaignId: net.campaign.id, status: "QUEUED" });
    expect(row.taskId).toBe(job.task!.id);
    // the queue holds exactly this job
    const queued = await renderQueue.getJob(mediaRenderJobId(job.id));
    expect(queued?.data).toEqual({ kind: "RENDER", taskId: job.task!.id, renderJobId: job.id });
    expect((await audit(s.orgId, "RENDER_REQUESTED")).length).toBe(1);
  });

  it("changing the text after the request does not change what will be rendered", async () => {
    const { s, asset, text, recipe } = await world();
    const job = (await request(s, { assetId: asset.id, textId: text.id, recipeId: recipe.id })).json.data;
    await prisma.textEntry.update({ where: { id: text.id }, data: { body: "A different text entirely" } });
    expect((await get<RenderDto>(s, `/api/renders/${job.id}`)).json.data.text.snapshot).toBe("Never give up on the thing you started.");
  });

  it("refuses, before queueing anything, a text that is not approved, archived, restricted, undrawable or too long", async () => {
    const { s, asset, recipe } = await world();
    const queuedBefore = await renderQueue.count(); // the queue is shared with the other tests: compare, do not expect empty
    const refused = async (text: { id: string }, code: string) => {
      const r = await request(s, { assetId: asset.id, textId: text.id, recipeId: recipe.id });
      expect(r.status, code).toBe(422);
      const details = r.json.error?.details as Err;
      expect(details.code).toBe("NOT_RENDERABLE");
      expect(details.issues!.map((i) => i.code), code).toContain(code);
    };
    await refused(await seedText(s, "Draft text", { status: "PENDING" }), "TEXT_NOT_APPROVED");
    await refused(await seedText(s, "Archived text", { status: "ARCHIVED" }), "TEXT_ARCHIVED");
    await refused(await seedText(s, "Restricted text", { rights: "RESTRICTED" }), "TEXT_RIGHTS_RESTRICTED");
    await refused(await seedText(s, "Smile \u{1F600} please"), "RENDER_UNSUPPORTED_TEXT");
    await refused(await seedText(s, "word ".repeat(400)), "RENDER_TEXT_DOES_NOT_FIT");
    expect(await prisma.mediaRenderJob.count({ where: { organizationId: s.orgId } })).toBe(0);
    expect(await renderQueue.count()).toBe(queuedBefore);
  });

  it("refuses a source that is not a ready picture or video, a recipe that does not accept it, and unknown or foreign ids", async () => {
    const { s, text, recipe } = await world();
    const failed = await seedAsset(s.orgId, { status: "FAILED" });
    const audio = await seedAsset(s.orgId, { kind: "AUDIO" });
    const video = await seedAsset(s.orgId, { kind: "VIDEO", durationMs: 5000, width: 1280, height: 720 });
    const imagesOnly = await seedRecipe(s, "Images only", { compatibleMedia: ["IMAGE"] });
    const codes = async (body: Record<string, unknown>) => ((await request(s, body)).json.error?.details as Err | undefined)?.issues?.map((i) => i.code) ?? [];
    expect(await codes({ assetId: failed.id, textId: text.id, recipeId: recipe.id })).toContain("ASSET_NOT_READY");
    expect((await request(s, { assetId: audio.id, textId: text.id, recipeId: recipe.id })).status).toBe(400);
    expect(await codes({ assetId: video.id, textId: text.id, recipeId: imagesOnly.id })).toContain("ASSET_KIND_NOT_ACCEPTED");
    expect((await request(s, { assetId: "nope", textId: text.id, recipeId: recipe.id })).status).toBe(404);
    const stranger = await admin();
    const foreign = await seedAsset(stranger.orgId, {});
    expect((await request(s, { assetId: foreign.id, textId: text.id, recipeId: recipe.id })).status).toBe(404);
    expect((await request(s, { assetId: video.id, textId: "nope", recipeId: recipe.id })).status).toBe(404);
    expect((await request(s, { assetId: video.id, textId: text.id, recipeId: recipe.id, pageId: "nope" })).status).toBe(404);
  });

  it("a video render's length follows the source or the recipe, and an image becomes a video only with a fixed length", async () => {
    const { s, text } = await world();
    const video = await seedAsset(s.orgId, { kind: "VIDEO", durationMs: 7000, width: 1280, height: 720 });
    const image = await seedAsset(s.orgId, {});
    const follow = await seedRecipe(s, "Follow", { duration: { mode: "SOURCE" } });
    const asVideo = (await post<Resolved>(s, "/api/renders/resolve", { assetId: video.id, textId: text.id, recipeId: follow.id })).json.data.evaluation!;
    expect(asVideo.output).toMatchObject({ kind: "VIDEO", durationMs: 7000 });
    const asStill = (await post<Resolved>(s, "/api/renders/resolve", { assetId: image.id, textId: text.id, recipeId: follow.id })).json.data.evaluation!;
    expect(asStill.output?.kind).toBe("IMAGE");
  });

  it("the same render cannot be queued twice, even when six requests arrive at the same instant", async () => {
    const { s, asset, text, recipe } = await world();
    const results = await Promise.all(Array.from({ length: 6 }, () => request(s, { assetId: asset.id, textId: text.id, recipeId: recipe.id })));
    expect(results.filter((r) => r.status === 202)).toHaveLength(1);
    const losers = results.filter((r) => r.status === 409);
    expect(losers).toHaveLength(5);
    for (const l of losers) expect((l.json.error?.details as Err).code).toBe("DUPLICATE_RENDER");
    expect(await prisma.mediaRenderJob.count({ where: { organizationId: s.orgId } })).toBe(1);
    expect(await prisma.operationTask.count({ where: { organizationId: s.orgId, type: "RENDER" } })).toBe(1);
    const winner = results.find((r) => r.status === 202)!.json.data;
    expect(await renderQueue.getJob(mediaRenderJobId(winner.id))).toBeTruthy(); // exactly the winner is queued; the losers never reached the queue
    const org = await prisma.mediaRenderJob.findMany({ where: { organizationId: s.orgId }, select: { id: true } });
    expect(org.map((j) => j.id)).toEqual([winner.id]);
  });

  it("a finished render can be repeated only on purpose (force), and the older one is marked superseded", async () => {
    const { s, asset, text, recipe } = await world();
    const first = (await request(s, { assetId: asset.id, textId: text.id, recipeId: recipe.id })).json.data;
    const waiting = await request(s, { assetId: asset.id, textId: text.id, recipeId: recipe.id, force: true });
    expect(waiting.status).toBe(409); // force cannot jump a render that is still waiting
    expect((waiting.json.error?.details as Err).canForce).toBe(false);
    await prisma.mediaRenderJob.update({ where: { id: first.id }, data: { status: "SUCCEEDED", finishedAt: new Date() } });
    const again = await request(s, { assetId: asset.id, textId: text.id, recipeId: recipe.id });
    expect(again.status).toBe(409);
    expect((again.json.error?.details as Err)).toMatchObject({ code: "DUPLICATE_RENDER", jobId: first.id, status: "SUCCEEDED", canForce: true });
    const forced = await request(s, { assetId: asset.id, textId: text.id, recipeId: recipe.id, force: true });
    expect(forced.status).toBe(202);
    expect(forced.json.data.id).not.toBe(first.id);
    expect((await prisma.mediaRenderJob.findUniqueOrThrow({ where: { id: first.id } })).activeKey).toBeNull();
  });

  it("different words, a different picture, a different recipe setting or a different page are different renders", async () => {
    const { s, net, asset, text, recipe } = await world();
    const other = await seedText(s, "Another approved text");
    const asset2 = await seedAsset(s.orgId, {});
    const sized = await seedRecipe(s, "Bigger", { typography: { sizePct: 9 } });
    const bodies = [
      { assetId: asset.id, textId: text.id, recipeId: recipe.id },
      { assetId: asset.id, textId: other.id, recipeId: recipe.id },
      { assetId: asset2.id, textId: text.id, recipeId: recipe.id },
      { assetId: asset.id, textId: text.id, recipeId: sized.id },
      { assetId: asset.id, textId: text.id, recipeId: recipe.id, pageId: net.page.id },
      { assetId: asset.id, textId: text.id, recipeId: recipe.id, adjustment: { typography: { sizePct: 8 } } },
    ];
    const ids = new Set<string>();
    for (const b of bodies) {
      const r = await request(s, b);
      expect(r.status, JSON.stringify(b)).toBe(202);
      ids.add(r.json.data.id);
    }
    expect(ids.size).toBe(bodies.length);
  });

  it("only editors and above can start, cancel and retry; everyone can look; other organizations see nothing", async () => {
    const { s, asset, text, recipe } = await world();
    const viewer = await colleague(s, "VIEWER");
    const editor = await colleague(s, "EDITOR");
    expect((await request(viewer, { assetId: asset.id, textId: text.id, recipeId: recipe.id })).status).toBe(403);
    const job = (await request(editor, { assetId: asset.id, textId: text.id, recipeId: recipe.id })).json.data;
    expect((await post(viewer, `/api/renders/${job.id}/cancel`)).status).toBe(403);
    expect((await post(viewer, `/api/renders/${job.id}/retry`)).status).toBe(403);
    expect((await get<RenderDto>(viewer, `/api/renders/${job.id}`)).status).toBe(200);
    expect((await post<Resolved>(viewer, "/api/renders/resolve", { assetId: asset.id, textId: text.id, recipeId: recipe.id })).status).toBe(200);
    const stranger = await admin();
    expect((await get(stranger, `/api/renders/${job.id}`)).status).toBe(404);
    expect((await post(stranger, `/api/renders/${job.id}/cancel`)).status).toBe(404);
    expect((await get<{ items: unknown[] }>(stranger, "/api/renders")).json.data.items).toHaveLength(0);
  });
});

suite("cancel and retry", () => {
  it("cancels a render that has not started: it leaves the queue and ends cancelled at once", async () => {
    const { s, asset, text, recipe } = await world();
    const job = (await request(s, { assetId: asset.id, textId: text.id, recipeId: recipe.id })).json.data;
    expect(await renderQueue.getJob(mediaRenderJobId(job.id))).toBeTruthy();
    const r = await post<RenderDto>(s, `/api/renders/${job.id}/cancel`);
    expect(r.status).toBe(202);
    expect(r.json.data.status).toBe("CANCELLED");
    expect(r.json.data.task?.status).toBe("CANCELLED");
    expect(await renderQueue.getJob(mediaRenderJobId(job.id))).toBeFalsy();
    expect((await prisma.mediaRenderJob.findUniqueOrThrow({ where: { id: job.id } })).activeKey).toBeNull();
    expect((await post(s, `/api/renders/${job.id}/cancel`)).status).toBe(409); // already over
    expect((await audit(s.orgId, "RENDER_CANCEL_REQUESTED")).length).toBe(1);
    // the same render may now be requested again
    expect((await request(s, { assetId: asset.id, textId: text.id, recipeId: recipe.id })).status).toBe(202);
  });

  it("asks the worker to stop a render that is running: it stays running (stopping) until the worker ends it", async () => {
    const { s, asset, text, recipe } = await world();
    const job = (await request(s, { assetId: asset.id, textId: text.id, recipeId: recipe.id })).json.data;
    await prisma.mediaRenderJob.update({ where: { id: job.id }, data: { status: "RUNNING", startedAt: new Date() } });
    const r = await post<RenderDto>(s, `/api/renders/${job.id}/cancel`);
    expect(r.json.data).toMatchObject({ status: "RUNNING", cancelRequested: true });
  });

  it("retries a failed render as a new job with the same frozen settings and words", async () => {
    const { s, asset, text, recipe } = await world();
    const job = (await request(s, { assetId: asset.id, textId: text.id, recipeId: recipe.id, adjustment: { typography: { sizePct: 7 } } })).json.data;
    expect((await post(s, `/api/renders/${job.id}/retry`)).status).toBe(409); // still waiting: nothing to retry
    await prisma.mediaRenderJob.update({ where: { id: job.id }, data: { status: "FAILED", activeKey: null, errorCode: "RENDER_FAILED", errorMessage: "boom", finishedAt: new Date() } });
    // the recipe changes afterwards; the retry must still be the same render
    await prisma.contentRecipe.update({ where: { id: recipe.id }, data: { version: { increment: 1 }, config: { typography: { sizePct: 3 } } } });
    const retry = await post<RenderDto>(s, `/api/renders/${job.id}/retry`);
    expect(retry.status, retry.text).toBe(202);
    const next = retry.json.data;
    expect(next).toMatchObject({ status: "QUEUED", retryOfId: job.id, recipe: { version: 1 } });
    expect(next.id).not.toBe(job.id);
    const detail = await get<RenderDto>(s, `/api/renders/${next.id}`);
    const old = await get<RenderDto>(s, `/api/renders/${job.id}`);
    expect(detail.json.data.effective).toEqual(old.json.data.effective);
    expect(detail.json.data.adjustment).toEqual(old.json.data.adjustment);
    expect(old.json.data.relatedAttempts?.map((a) => a.id)).toContain(next.id);
    expect(await renderQueue.getJob(mediaRenderJobId(next.id))).toBeTruthy();
    expect((await audit(s.orgId, "RENDER_RETRIED")).length).toBe(1);
    // a second retry while the first retry is waiting is a duplicate
    await prisma.mediaRenderJob.update({ where: { id: job.id }, data: { status: "CANCELLED" } });
    expect((await post(s, `/api/renders/${job.id}/retry`)).status).toBe(409);
  });

  it("will not retry when the text is no longer approved or the source file is gone or changed", async () => {
    const { s, asset, text, recipe } = await world();
    const fail = async () => {
      const job = (await request(s, { assetId: asset.id, textId: text.id, recipeId: recipe.id })).json.data;
      await prisma.mediaRenderJob.update({ where: { id: job.id }, data: { status: "FAILED", activeKey: null, finishedAt: new Date() } });
      return job;
    };
    const a = await fail();
    await prisma.textEntry.update({ where: { id: text.id }, data: { approvalStatus: "ARCHIVED" } });
    const archived = await post(s, `/api/renders/${a.id}/retry`);
    expect(archived.status).toBe(409);
    expect(archived.json.error?.message).toContain("text is no longer approved");
    await prisma.textEntry.update({ where: { id: text.id }, data: { approvalStatus: "APPROVED" } });
    await prisma.mediaAsset.update({ where: { id: asset.id }, data: { sha256: "c".repeat(64) } });
    expect((await post(s, `/api/renders/${a.id}/retry`)).json.error?.message).toContain("not the one this render was made for");
    await prisma.mediaAsset.update({ where: { id: asset.id }, data: { status: "ARCHIVED", sha256: asset.sha256 } });
    expect((await post(s, `/api/renders/${a.id}/retry`)).json.error?.message).toContain("no longer available");
  });

});

suite("lists and details", () => {
  it("lists active and finished renders with counts, newest first, with the output and the reason a render failed", async () => {
    const { s, net, asset, text, recipe } = await world();
    const a = (await request(s, { assetId: asset.id, textId: text.id, recipeId: recipe.id })).json.data;
    const text2 = await seedText(s, "Second text");
    const b = (await request(s, { assetId: asset.id, textId: text2.id, recipeId: recipe.id, pageId: net.page.id })).json.data;
    const text3 = await seedText(s, "Third text");
    const c = (await request(s, { assetId: asset.id, textId: text3.id, recipeId: recipe.id })).json.data;
    const output = await prisma.mediaAsset.create({ data: { organizationId: s.orgId, originalName: "out.mp4", kind: "VIDEO", status: "READY", mimeType: "video/mp4", sizeBytes: BigInt(10), sha256: "d".repeat(64), origin: "RENDER", renderJobId: a.id, storageKey: "k/out.mp4" } });
    await prisma.mediaRenderJob.update({ where: { id: a.id }, data: { status: "SUCCEEDED", outputAssetId: output.id, outputKind: "VIDEO", finishedAt: new Date() } });
    await prisma.mediaRenderJob.update({ where: { id: b.id }, data: { status: "FAILED", activeKey: null, errorCode: "RENDER_FAILED", errorMessage: "FFmpeg could not render this", errorRemedy: "Try again", finishedAt: new Date() } });
    await prisma.mediaRenderJob.update({ where: { id: c.id }, data: { status: "RUNNING", startedAt: new Date() } });

    const all = await get<Paged<RenderDto> & { counts: Record<string, number> }>(s, "/api/renders");
    expect(all.json.data.total).toBe(3);
    expect(all.json.data.counts).toMatchObject({ QUEUED: 0, RUNNING: 1, SUCCEEDED: 1, FAILED: 1, CANCELLED: 0 });
    expect(all.json.data.items.map((i) => i.id)).toEqual([c.id, b.id, a.id]);
    const active = await get<Paged<RenderDto>>(s, "/api/renders?state=active");
    expect(active.json.data.items.map((i) => i.id)).toEqual([c.id]);
    const finished = await get<Paged<RenderDto>>(s, "/api/renders?state=finished");
    expect(finished.json.data.items.map((i) => i.status).sort()).toEqual(["FAILED", "SUCCEEDED"]);
    const done = finished.json.data.items.find((i) => i.id === a.id)!;
    expect(done.output).toMatchObject({ id: output.id, kind: "VIDEO" });
    expect(done.output?.contentUrl).toBe(`/api/media/assets/${output.id}/content`);
    const failed = finished.json.data.items.find((i) => i.id === b.id)!;
    expect(failed.error).toMatchObject({ code: "RENDER_FAILED", remedy: "Try again" });
    expect(failed.page?.id).toBe(net.page.id);
    expect((await get<Paged<RenderDto>>(s, "/api/renders?status=FAILED")).json.data.total).toBe(1);
    expect((await get<Paged<RenderDto>>(s, `/api/renders?pageId=${net.page.id}`)).json.data.total).toBe(1);
    expect((await get<Paged<RenderDto>>(s, `/api/renders?sourceAssetId=${asset.id}`)).json.data.total).toBe(3);
    expect((await get(s, "/api/renders?state=nonsense")).status).toBe(400);
    expect((await get(s, "/api/renders/nope")).status).toBe(404);
  });
});
