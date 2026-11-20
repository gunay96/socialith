import { prisma } from "@socialith/database";
import type { MediaAssetKind, MediaAssetStatus, MediaPackStatus, MediaRightsStatus, Prisma } from "@socialith/database";
import { enqueueMediaProcessing, QueueUnavailableError } from "../lib/queue.js";
import { createAuditLog } from "../repositories/audit-log.repository.js";
import type { SafeUser } from "../types/auth.js";
import { ApiHttpError } from "../middleware/error-handler.js";
import { ERROR_CODES } from "@socialith/types";
import { ASSET_INCLUDE, assetDto, conflict, emptyCounts, libraryStorage, normalizeTag, notFound, packDto, type PackCounts } from "./media-common.js";
import { createTask, taskDto } from "./operation-task.service.js";

// ------------------------------------------------------------------------------------------------ assets: list

export type AssetStatusFilter = MediaAssetStatus | "ACTIVE" | "ALL";

export interface ListAssetsQuery {
  q?: string;
  kind?: MediaAssetKind;
  status: AssetStatusFilter;
  packId?: string;
  tag?: string;
  campaignId?: string;
  pageGroupId?: string;
  orientation?: "portrait" | "landscape" | "square";
  aspect?: string;
  minDurationMs?: number;
  maxDurationMs?: number;
  minWidth?: number;
  hasAudio?: boolean;
  rights?: MediaRightsStatus;
  sort: "newest" | "oldest" | "name" | "size" | "duration";
  page: number;
  pageSize: number;
}

const ORDER: Record<ListAssetsQuery["sort"], Prisma.MediaAssetOrderByWithRelationInput[]> = {
  newest: [{ createdAt: "desc" }, { id: "desc" }],
  oldest: [{ createdAt: "asc" }, { id: "asc" }],
  name: [{ originalName: "asc" }, { id: "asc" }],
  size: [{ sizeBytes: "desc" }, { id: "asc" }],
  duration: [{ durationMs: { sort: "desc", nulls: "last" } }, { id: "asc" }],
};

export function assetWhere(organizationId: string, q: Omit<ListAssetsQuery, "sort" | "page" | "pageSize">): Prisma.MediaAssetWhereInput {
  const and: Prisma.MediaAssetWhereInput[] = [];
  // the default view: usable files, not the ones that were refused, are duplicates, or archived
  const status: Prisma.MediaAssetWhereInput = q.status === "ALL" ? {} : q.status === "ACTIVE" ? { status: { in: ["READY", "ANALYZING", "FAILED"] } } : { status: q.status };
  // assets of an archived pack stay out of sight unless that pack (or ALL) is asked for
  if (!q.packId && q.status !== "ALL" && q.status !== "ARCHIVED") and.push({ OR: [{ packId: null }, { pack: { status: { not: "ARCHIVED" } } }] });
  if (q.q) {
    const term = q.q.trim();
    and.push({ OR: [{ originalName: { contains: term } }, { folderPath: { contains: term } }, { tags: { some: { tag: { contains: term.toLowerCase() } } } }] });
  }
  if (q.tag) and.push({ tags: { some: { tag: normalizeTag(q.tag) } } });
  // assigned to the campaign / page group directly, or through the pack it belongs to
  if (q.campaignId) and.push({ OR: [{ campaigns: { some: { campaignId: q.campaignId } } }, { pack: { campaigns: { some: { campaignId: q.campaignId } } } }] });
  if (q.pageGroupId) and.push({ OR: [{ pageGroups: { some: { groupId: q.pageGroupId } } }, { pack: { pageGroups: { some: { groupId: q.pageGroupId } } } }] });
  if (q.orientation === "portrait") and.push({ aspectDecimal: { lt: 0.99 } });
  if (q.orientation === "landscape") and.push({ aspectDecimal: { gt: 1.01 } });
  if (q.orientation === "square") and.push({ aspectDecimal: { gte: 0.99, lte: 1.01 } });
  return {
    organizationId,
    ...status,
    ...(q.kind ? { kind: q.kind } : {}),
    ...(q.packId ? { packId: q.packId } : {}),
    ...(q.aspect ? { aspectRatio: q.aspect } : {}),
    ...(q.minDurationMs !== undefined || q.maxDurationMs !== undefined ? { durationMs: { ...(q.minDurationMs !== undefined ? { gte: q.minDurationMs } : {}), ...(q.maxDurationMs !== undefined ? { lte: q.maxDurationMs } : {}) } } : {}),
    ...(q.minWidth !== undefined ? { width: { gte: q.minWidth } } : {}),
    ...(q.hasAudio !== undefined ? { hasAudio: q.hasAudio } : {}),
    ...(q.rights ? { rightsStatus: q.rights } : {}),
    ...(and.length ? { AND: and } : {}),
  };
}

export async function listAssets(actor: SafeUser, q: ListAssetsQuery) {
  const where = assetWhere(actor.organizationId, q);
  const [rows, total] = await Promise.all([
    prisma.mediaAsset.findMany({ where, include: ASSET_INCLUDE, orderBy: ORDER[q.sort], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    prisma.mediaAsset.count({ where }),
  ]);
  return { items: rows.map(assetDto), total, page: q.page, pageSize: q.pageSize };
}

/** Counts that drive the filter chips: how many of each kind, and the most used tags. */
export async function getFacets(actor: SafeUser) {
  const base = assetWhere(actor.organizationId, { status: "ACTIVE" });
  const [kinds, tags, total] = await Promise.all([
    prisma.mediaAsset.groupBy({ by: ["kind"], where: base, _count: { _all: true } }),
    prisma.mediaAssetTag.groupBy({ by: ["tag"], where: { organizationId: actor.organizationId, asset: base }, _count: { _all: true }, orderBy: [{ _count: { tag: "desc" } }, { tag: "asc" }], take: 40 }),
    prisma.mediaAsset.count({ where: base }),
  ]);
  const aspects = await prisma.mediaAsset.groupBy({ by: ["aspectRatio"], where: { ...base, aspectRatio: { not: null } }, _count: { _all: true }, orderBy: { _count: { aspectRatio: "desc" } }, take: 12 });
  return {
    total,
    kinds: kinds.map((k) => ({ kind: k.kind, count: k._count._all })),
    tags: tags.map((t) => ({ tag: t.tag, count: t._count._all })),
    aspects: aspects.map((a) => ({ aspectRatio: a.aspectRatio, count: a._count._all })),
  };
}

// ------------------------------------------------------------------------------------------------ assets: one

async function loadAsset(actor: SafeUser, id: string) {
  const row = await prisma.mediaAsset.findFirst({ where: { id, organizationId: actor.organizationId }, include: ASSET_INCLUDE });
  if (!row) throw notFound("Asset");
  return row;
}

export async function getAsset(actor: SafeUser, id: string) {
  const a = await loadAsset(actor, id);
  const [campaigns, pageGroups, packCampaigns, packGroups, duplicates, task] = await Promise.all([
    prisma.mediaAssetCampaign.findMany({ where: { assetId: id }, include: { campaign: { select: { id: true, name: true } } } }),
    prisma.mediaAssetPageGroup.findMany({ where: { assetId: id }, include: { group: { select: { id: true, name: true } } } }),
    a.packId ? prisma.mediaPackCampaign.findMany({ where: { packId: a.packId }, include: { campaign: { select: { id: true, name: true } } } }) : Promise.resolve([]),
    a.packId ? prisma.mediaPackPageGroup.findMany({ where: { packId: a.packId }, include: { group: { select: { id: true, name: true } } } }) : Promise.resolve([]),
    prisma.mediaAsset.count({ where: { duplicateOfId: id } }),
    prisma.operationTask.findFirst({ where: { organizationId: actor.organizationId, subjectType: "MediaAsset", subjectId: id }, orderBy: { createdAt: "desc" } }),
  ]);
  return {
    ...assetDto(a),
    campaigns: campaigns.map((c) => c.campaign),
    pageGroups: pageGroups.map((g) => g.group),
    inheritedFromPack: { campaigns: packCampaigns.map((c) => c.campaign), pageGroups: packGroups.map((g) => g.group) },
    duplicateCount: duplicates,
    latestTask: task ? taskDto(task) : null,
  };
}

export async function setTags(actor: SafeUser, id: string, tags: string[]) {
  const a = await loadAsset(actor, id);
  const wanted = [...new Set(tags.map(normalizeTag).filter(Boolean))].slice(0, 30);
  const have = new Set(a.tags.map((t) => t.tag));
  const add = wanted.filter((t) => !have.has(t));
  const remove = [...have].filter((t) => !wanted.includes(t));
  await prisma.$transaction([
    ...(remove.length ? [prisma.mediaAssetTag.deleteMany({ where: { assetId: id, tag: { in: remove } } })] : []),
    ...(add.length ? [prisma.mediaAssetTag.createMany({ data: add.map((tag) => ({ organizationId: actor.organizationId, assetId: id, tag })), skipDuplicates: true })] : []),
  ]);
  if (add.length || remove.length) await createAuditLog({ organizationId: actor.organizationId, userId: actor.id, action: "MEDIA_ASSET_UPDATED", targetType: "MediaAsset", targetId: id, metadata: { added: add, removed: remove } });
  return getAsset(actor, id);
}

/** Add and/or remove tags on many assets at once (each must belong to the organization; nothing changes if one does not). */
export async function bulkTags(actor: SafeUser, assetIds: string[], add: string[], remove: string[]) {
  const ids = [...new Set(assetIds)];
  const found = await prisma.mediaAsset.count({ where: { id: { in: ids }, organizationId: actor.organizationId } });
  if (found !== ids.length) throw notFound("One of the assets");
  const addTags = [...new Set(add.map(normalizeTag).filter(Boolean))];
  const removeTags = [...new Set(remove.map(normalizeTag).filter(Boolean))];
  await prisma.$transaction([
    ...(removeTags.length ? [prisma.mediaAssetTag.deleteMany({ where: { assetId: { in: ids }, tag: { in: removeTags } } })] : []),
    ...(addTags.length ? [prisma.mediaAssetTag.createMany({ data: ids.flatMap((assetId) => addTags.map((tag) => ({ organizationId: actor.organizationId, assetId, tag }))), skipDuplicates: true })] : []),
  ]);
  await createAuditLog({ organizationId: actor.organizationId, userId: actor.id, action: "MEDIA_ASSET_UPDATED", targetType: "MediaAsset", metadata: { bulk: ids.length, added: addTags, removed: removeTags } });
  return { updated: ids.length };
}

export async function updateNotes(actor: SafeUser, id: string, notes: string | null) {
  await loadAsset(actor, id);
  await prisma.mediaAsset.update({ where: { id }, data: { notes } });
  await createAuditLog({ organizationId: actor.organizationId, userId: actor.id, action: "MEDIA_ASSET_UPDATED", targetType: "MediaAsset", targetId: id, metadata: { fields: ["notes"] } });
  return getAsset(actor, id);
}

export async function setAssetStatus(actor: SafeUser, id: string, archived: boolean) {
  const a = await loadAsset(actor, id);
  if (archived) {
    if (a.status === "ARCHIVED") return getAsset(actor, id);
    await prisma.mediaAsset.update({ where: { id }, data: { status: "ARCHIVED" } });
  } else {
    if (a.status !== "ARCHIVED") return getAsset(actor, id);
    // back to what it was: analysed files are READY, never-analysed ones go back to ANALYZING (Re-analyze finishes them)
    await prisma.mediaAsset.update({ where: { id }, data: { status: a.analyzedAt ? "READY" : "ANALYZING" } });
  }
  await createAuditLog({ organizationId: actor.organizationId, userId: actor.id, action: archived ? "MEDIA_ASSET_ARCHIVED" : "MEDIA_ASSET_RESTORED", targetType: "MediaAsset", targetId: id });
  return getAsset(actor, id);
}

export async function setRights(actor: SafeUser, id: string, status: MediaRightsStatus, notes: string | null) {
  const a = await loadAsset(actor, id);
  await prisma.mediaAsset.update({
    where: { id },
    data: { rightsStatus: status, rightsNotes: notes, rightsConfirmedById: status === "CONFIRMED" ? actor.id : null, rightsConfirmedAt: status === "CONFIRMED" ? new Date() : null },
  });
  await createAuditLog({ organizationId: actor.organizationId, userId: actor.id, action: "MEDIA_RIGHTS_CHANGED", targetType: "MediaAsset", targetId: id, metadata: { from: a.rightsStatus, to: status } });
  return getAsset(actor, id);
}

/** Probes and thumbnails the stored original again (e.g. after FFmpeg was installed). A new task; the original is untouched. */
export async function reanalyze(actor: SafeUser, id: string) {
  const a = await loadAsset(actor, id);
  if (!a.storageKey) throw conflict("This asset has no stored file to analyze.");
  if (a.status === "REJECTED" || a.status === "DUPLICATE" || a.status === "ARCHIVED") throw conflict(`A ${a.status.toLowerCase()} asset cannot be analyzed.`);
  const running = await prisma.operationTask.findFirst({ where: { organizationId: actor.organizationId, subjectType: "MediaAsset", subjectId: id, status: { in: ["QUEUED", "RUNNING"] } } });
  if (running) throw conflict("This asset is already being analyzed.", { taskId: running.id });
  const task = await createTask(prisma, { organizationId: actor.organizationId, type: "MEDIA_ANALYZE", subjectType: "MediaAsset", subjectId: id, queueName: "media-processing", createdById: actor.id });
  await prisma.mediaAsset.update({ where: { id }, data: { status: "ANALYZING" } });
  try {
    await enqueueMediaProcessing({ kind: "ANALYZE_ASSET", taskId: task.id, assetId: id });
  } catch (err) {
    await prisma.operationTask.update({ where: { id: task.id }, data: { status: "FAILED", finishedAt: new Date(), errorCode: "CONFIGURATION_ERROR", errorMessage: err instanceof Error ? err.message : "Could not queue the job.", errorRemedy: "Check that Redis and the worker are running, then try again." } });
    await prisma.mediaAsset.update({ where: { id }, data: { status: a.status } });
    if (err instanceof QueueUnavailableError) throw new ApiHttpError(503, ERROR_CODES.CONFIGURATION_ERROR, err.message);
    throw err;
  }
  await createAuditLog({ organizationId: actor.organizationId, userId: actor.id, action: "MEDIA_ASSET_REANALYZE_REQUESTED", targetType: "MediaAsset", targetId: id });
  return { task: taskDto(task) };
}

// ------------------------------------------------------------------------------------------------ assignment (campaign / page group)

type Scope = "asset" | "pack";

async function requireOwned(organizationId: string, scope: Scope, id: string) {
  const row = scope === "asset" ? await prisma.mediaAsset.findFirst({ where: { id, organizationId }, select: { id: true } }) : await prisma.mediaPack.findFirst({ where: { id, organizationId }, select: { id: true } });
  if (!row) throw notFound(scope === "asset" ? "Asset" : "Pack");
}

/** Replaces the set of campaigns the asset/pack is assigned to (idempotent; every id must belong to the organization). */
export async function setCampaigns(actor: SafeUser, scope: Scope, id: string, campaignIds: string[]) {
  await requireOwned(actor.organizationId, scope, id);
  const wanted = [...new Set(campaignIds)];
  if (wanted.length) {
    const ok = await prisma.campaign.count({ where: { id: { in: wanted }, organizationId: actor.organizationId } });
    if (ok !== wanted.length) throw notFound("One of the campaigns");
  }
  const current = scope === "asset" ? (await prisma.mediaAssetCampaign.findMany({ where: { assetId: id } })).map((r) => r.campaignId) : (await prisma.mediaPackCampaign.findMany({ where: { packId: id } })).map((r) => r.campaignId);
  const add = wanted.filter((c) => !current.includes(c));
  const remove = current.filter((c) => !wanted.includes(c));
  if (scope === "asset") {
    await prisma.$transaction([
      ...(remove.length ? [prisma.mediaAssetCampaign.deleteMany({ where: { assetId: id, campaignId: { in: remove } } })] : []),
      ...(add.length ? [prisma.mediaAssetCampaign.createMany({ data: add.map((campaignId) => ({ assetId: id, campaignId })), skipDuplicates: true })] : []),
    ]);
  } else {
    await prisma.$transaction([
      ...(remove.length ? [prisma.mediaPackCampaign.deleteMany({ where: { packId: id, campaignId: { in: remove } } })] : []),
      ...(add.length ? [prisma.mediaPackCampaign.createMany({ data: add.map((campaignId) => ({ packId: id, campaignId })), skipDuplicates: true })] : []),
    ]);
  }
  if (add.length || remove.length) await createAuditLog({ organizationId: actor.organizationId, userId: actor.id, action: "MEDIA_ASSIGNMENT_CHANGED", targetType: scope === "asset" ? "MediaAsset" : "MediaPack", targetId: id, metadata: { target: "campaigns", added: add, removed: remove } });
}

export async function setPageGroups(actor: SafeUser, scope: Scope, id: string, groupIds: string[]) {
  await requireOwned(actor.organizationId, scope, id);
  const wanted = [...new Set(groupIds)];
  if (wanted.length) {
    const ok = await prisma.pageGroup.count({ where: { id: { in: wanted }, organizationId: actor.organizationId, status: "ACTIVE" } });
    if (ok !== wanted.length) throw notFound("One of the page groups");
  }
  const current = scope === "asset" ? (await prisma.mediaAssetPageGroup.findMany({ where: { assetId: id } })).map((r) => r.groupId) : (await prisma.mediaPackPageGroup.findMany({ where: { packId: id } })).map((r) => r.groupId);
  const add = wanted.filter((g) => !current.includes(g));
  const remove = current.filter((g) => !wanted.includes(g));
  if (scope === "asset") {
    await prisma.$transaction([
      ...(remove.length ? [prisma.mediaAssetPageGroup.deleteMany({ where: { assetId: id, groupId: { in: remove } } })] : []),
      ...(add.length ? [prisma.mediaAssetPageGroup.createMany({ data: add.map((groupId) => ({ assetId: id, groupId })), skipDuplicates: true })] : []),
    ]);
  } else {
    await prisma.$transaction([
      ...(remove.length ? [prisma.mediaPackPageGroup.deleteMany({ where: { packId: id, groupId: { in: remove } } })] : []),
      ...(add.length ? [prisma.mediaPackPageGroup.createMany({ data: add.map((groupId) => ({ packId: id, groupId })), skipDuplicates: true })] : []),
    ]);
  }
  if (add.length || remove.length) await createAuditLog({ organizationId: actor.organizationId, userId: actor.id, action: "MEDIA_ASSIGNMENT_CHANGED", targetType: scope === "asset" ? "MediaAsset" : "MediaPack", targetId: id, metadata: { target: "pageGroups", added: add, removed: remove } });
}

// ------------------------------------------------------------------------------------------------ packs

async function countsFor(packIds: string[]): Promise<Map<string, PackCounts>> {
  const map = new Map<string, PackCounts>(packIds.map((id) => [id, emptyCounts()]));
  if (!packIds.length) return map;
  const rows = await prisma.mediaAsset.groupBy({ by: ["packId", "status"], where: { packId: { in: packIds } }, _count: { _all: true } });
  for (const r of rows) {
    const c = map.get(r.packId!)!;
    const n = r._count._all;
    c.total += n;
    if (r.status === "READY") c.ready += n;
    else if (r.status === "ANALYZING") c.analyzing += n;
    else if (r.status === "FAILED") c.failed += n;
    else if (r.status === "REJECTED") c.rejected += n;
    else if (r.status === "DUPLICATE") c.duplicate += n;
    else if (r.status === "ARCHIVED") c.archived += n;
  }
  return map;
}

export async function listPacks(actor: SafeUser, q: { status: MediaPackStatus | "ACTIVE" | "ALL"; page: number; pageSize: number; search?: string }) {
  const where: Prisma.MediaPackWhereInput = {
    organizationId: actor.organizationId,
    ...(q.status === "ALL" ? {} : q.status === "ACTIVE" ? { status: { not: "ARCHIVED" } } : { status: q.status }),
    ...(q.search ? { name: { contains: q.search } } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.mediaPack.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    prisma.mediaPack.count({ where }),
  ]);
  const counts = await countsFor(rows.map((r) => r.id));
  return { items: rows.map((r) => packDto(r, counts.get(r.id)!)), total, page: q.page, pageSize: q.pageSize };
}

export async function getPack(actor: SafeUser, id: string) {
  const p = await prisma.mediaPack.findFirst({ where: { id, organizationId: actor.organizationId } });
  if (!p) throw notFound("Pack");
  const [counts, campaigns, groups, task, refused] = await Promise.all([
    countsFor([id]),
    prisma.mediaPackCampaign.findMany({ where: { packId: id }, include: { campaign: { select: { id: true, name: true } } } }),
    prisma.mediaPackPageGroup.findMany({ where: { packId: id }, include: { group: { select: { id: true, name: true } } } }),
    prisma.operationTask.findFirst({ where: { organizationId: actor.organizationId, subjectType: "MediaPack", subjectId: id }, orderBy: { createdAt: "desc" } }),
    prisma.mediaAsset.findMany({ where: { packId: id, status: { in: ["REJECTED", "FAILED"] } }, select: { id: true, originalName: true, entryPath: true, status: true, rejectionCode: true, rejectionReason: true }, orderBy: { entryPath: "asc" }, take: 200 }),
  ]);
  return {
    ...packDto(p, counts.get(id)!, { campaigns: campaigns.map((c) => c.campaign), pageGroups: groups.map((g) => g.group), task: task ? taskDto(task) : null }),
    refused: refused.map((r) => ({ id: r.id, name: r.originalName, path: r.entryPath, status: r.status, code: r.rejectionCode, reason: r.rejectionReason })),
  };
}

export async function updatePack(actor: SafeUser, id: string, input: { name?: string; description?: string | null }) {
  const p = await prisma.mediaPack.findFirst({ where: { id, organizationId: actor.organizationId } });
  if (!p) throw notFound("Pack");
  await prisma.mediaPack.update({ where: { id }, data: { ...(input.name !== undefined ? { name: input.name } : {}), ...(input.description !== undefined ? { description: input.description } : {}) } });
  await createAuditLog({ organizationId: actor.organizationId, userId: actor.id, action: "MEDIA_PACK_UPDATED", targetType: "MediaPack", targetId: id, metadata: { fields: Object.keys(input) } });
  return getPack(actor, id);
}

export async function setPackArchived(actor: SafeUser, id: string, archived: boolean) {
  const p = await prisma.mediaPack.findFirst({ where: { id, organizationId: actor.organizationId } });
  if (!p) throw notFound("Pack");
  if (archived && p.status === "PROCESSING") throw conflict("The pack is still being processed. Wait for it to finish.");
  if (archived && p.status !== "ARCHIVED") {
    await prisma.mediaPack.update({ where: { id }, data: { status: "ARCHIVED" } });
    await createAuditLog({ organizationId: actor.organizationId, userId: actor.id, action: "MEDIA_PACK_ARCHIVED", targetType: "MediaPack", targetId: id });
  }
  if (!archived && p.status === "ARCHIVED") {
    const bad = await prisma.mediaAsset.count({ where: { packId: id, status: { in: ["REJECTED", "FAILED"] } } });
    await prisma.mediaPack.update({ where: { id }, data: { status: bad > 0 ? "PARTIAL" : "READY" } });
    await createAuditLog({ organizationId: actor.organizationId, userId: actor.id, action: "MEDIA_PACK_RESTORED", targetType: "MediaPack", targetId: id });
  }
  return getPack(actor, id);
}

// ------------------------------------------------------------------------------------------------ streaming a stored file

export interface StreamTarget {
  key: string;
  contentType: string;
  fileName: string;
  /** Text and spreadsheets are always downloads; media may play inline. */
  inline: boolean;
}

/** Resolves which stored object serves an asset's original or one of its derivatives, after the organization check. */
export async function resolveStreamTarget(actor: SafeUser, assetId: string, which: "content" | "thumbnail"): Promise<StreamTarget> {
  const a = await prisma.mediaAsset.findFirst({ where: { id: assetId, organizationId: actor.organizationId }, include: { derivatives: true } });
  if (!a) throw notFound("Asset");
  if (which === "thumbnail") {
    const d = a.derivatives.find((x) => x.kind === "THUMBNAIL");
    if (!d) throw notFound("Thumbnail");
    return { key: d.storageKey, contentType: d.contentType, fileName: `thumbnail-${a.id}.jpg`, inline: true };
  }
  if (!a.storageKey) throw notFound("Stored file");
  return { key: a.storageKey, contentType: a.mimeType, fileName: a.originalName, inline: a.kind === "VIDEO" || a.kind === "IMAGE" || a.kind === "AUDIO" };
}

export { libraryStorage };
