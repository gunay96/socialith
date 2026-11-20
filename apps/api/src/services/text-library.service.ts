import { prisma } from "@socialith/database";
import type { LibraryStatus, MediaRightsStatus, Prisma, TextApprovalStatus } from "@socialith/database";
import { hasMinimumRole } from "@socialith/auth";
import { STARTER_TEXT_CATEGORIES, checkText, cleanText, describeTextProblem, normalizeForSearch, textLength } from "@socialith/studio";
import { ERROR_CODES } from "@socialith/types";
import { ApiHttpError } from "../middleware/error-handler.js";
import { createAuditLog } from "../repositories/audit-log.repository.js";
import type { SafeUser } from "../types/auth.js";
import { conflict, notFound } from "./media-common.js";
import { TEXT_INCLUDE, categoryDto, collectionDto, duplicateHash, searchForm, slugify, textDto } from "./text-common.js";

// ------------------------------------------------------------------------------------------------ shared helpers

const bad = (message: string, details?: unknown) => new ApiHttpError(400, ERROR_CODES.INVALID_REQUEST, message, details);
const forbidden = (message: string) => new ApiHttpError(403, ERROR_CODES.FORBIDDEN, message);
const isAdmin = (actor: SafeUser) => hasMinimumRole(actor.role, "ADMIN");
export function requireAdmin(actor: SafeUser, what: string): void {
  if (!isAdmin(actor)) throw forbidden(`${what} needs the administrator role.`);
}
const audit = (actor: SafeUser, action: Parameters<typeof createAuditLog>[0]["action"], targetType: string, targetId?: string, metadata?: Record<string, unknown>) =>
  createAuditLog({ organizationId: actor.organizationId, userId: actor.id, action, targetType, ...(targetId ? { targetId } : {}), ...(metadata ? { metadata } : {}) });

export type LinkKind = "categories" | "campaigns" | "pageCategories" | "pages" | "pageGroups";
const LINK_LABEL: Record<LinkKind, string> = { categories: "text categories", campaigns: "campaigns", pageCategories: "page categories", pages: "pages", pageGroups: "page groups" };

/** Every id must exist in the organization (and be usable): nothing is linked across organizations. */
export async function assertOwned(kind: LinkKind, organizationId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const where = { id: { in: ids }, organizationId };
  const found =
    kind === "categories"
      ? await prisma.textCategory.count({ where: { ...where, status: "ACTIVE" } })
      : kind === "campaigns"
        ? await prisma.campaign.count({ where })
        : kind === "pageCategories"
          ? await prisma.pageCategory.count({ where: { ...where, status: "ACTIVE" } })
          : kind === "pageGroups"
            ? await prisma.pageGroup.count({ where: { ...where, status: "ACTIVE" } })
            : await prisma.managedPage.count({ where: { ...where, status: "ACTIVE" } });
  if (found !== new Set(ids).size) throw notFound(`One of the ${LINK_LABEL[kind]}`);
}

async function currentLinks(kind: LinkKind, textIds: string[]): Promise<{ textId: string; targetId: string }[]> {
  const where = { textId: { in: textIds } };
  switch (kind) {
    case "categories":
      return (await prisma.textEntryCategory.findMany({ where })).map((r) => ({ textId: r.textId, targetId: r.categoryId }));
    case "campaigns":
      return (await prisma.textEntryCampaign.findMany({ where })).map((r) => ({ textId: r.textId, targetId: r.campaignId }));
    case "pageCategories":
      return (await prisma.textEntryPageCategory.findMany({ where })).map((r) => ({ textId: r.textId, targetId: r.categoryId }));
    case "pages":
      return (await prisma.textEntryPage.findMany({ where })).map((r) => ({ textId: r.textId, targetId: r.pageId }));
    case "pageGroups":
      return (await prisma.textEntryPageGroup.findMany({ where })).map((r) => ({ textId: r.textId, targetId: r.groupId }));
  }
}

function removeLinks(kind: LinkKind, textIds: string[], targetIds: string[]): Prisma.PrismaPromise<unknown> {
  const where = { textId: { in: textIds } };
  switch (kind) {
    case "categories":
      return prisma.textEntryCategory.deleteMany({ where: { ...where, categoryId: { in: targetIds } } });
    case "campaigns":
      return prisma.textEntryCampaign.deleteMany({ where: { ...where, campaignId: { in: targetIds } } });
    case "pageCategories":
      return prisma.textEntryPageCategory.deleteMany({ where: { ...where, categoryId: { in: targetIds } } });
    case "pages":
      return prisma.textEntryPage.deleteMany({ where: { ...where, pageId: { in: targetIds } } });
    case "pageGroups":
      return prisma.textEntryPageGroup.deleteMany({ where: { ...where, groupId: { in: targetIds } } });
  }
}

function addLinks(kind: LinkKind, pairs: { textId: string; targetId: string }[]): Prisma.PrismaPromise<unknown> {
  switch (kind) {
    case "categories":
      return prisma.textEntryCategory.createMany({ data: pairs.map((p) => ({ textId: p.textId, categoryId: p.targetId })), skipDuplicates: true });
    case "campaigns":
      return prisma.textEntryCampaign.createMany({ data: pairs.map((p) => ({ textId: p.textId, campaignId: p.targetId })), skipDuplicates: true });
    case "pageCategories":
      return prisma.textEntryPageCategory.createMany({ data: pairs.map((p) => ({ textId: p.textId, categoryId: p.targetId })), skipDuplicates: true });
    case "pages":
      return prisma.textEntryPage.createMany({ data: pairs.map((p) => ({ textId: p.textId, pageId: p.targetId })), skipDuplicates: true });
    case "pageGroups":
      return prisma.textEntryPageGroup.createMany({ data: pairs.map((p) => ({ textId: p.textId, groupId: p.targetId })), skipDuplicates: true });
  }
}

/** add / remove / set the links of one kind on several texts (all of them must belong to the organization; the targets too). */
export async function applyLinks(actor: SafeUser, textIds: string[], kind: LinkKind, mode: "add" | "remove" | "set", targetIds: string[]): Promise<{ added: number; removed: number }> {
  const ids = [...new Set(textIds)];
  const targets = [...new Set(targetIds)];
  const owned = await prisma.textEntry.count({ where: { id: { in: ids }, organizationId: actor.organizationId } });
  if (owned !== ids.length) throw notFound("One of the texts");
  if (mode !== "remove") await assertOwned(kind, actor.organizationId, targets);
  const current = await currentLinks(kind, ids);
  const have = new Set(current.map((c) => `${c.textId}:${c.targetId}`));
  const toAdd = mode === "remove" ? [] : ids.flatMap((textId) => targets.filter((t) => !have.has(`${textId}:${t}`)).map((targetId) => ({ textId, targetId })));
  const toRemove = mode === "add" ? [] : mode === "remove" ? current.filter((c) => targets.includes(c.targetId)) : current.filter((c) => !targets.includes(c.targetId));
  const ops: Prisma.PrismaPromise<unknown>[] = [];
  for (const textId of new Set(toRemove.map((r) => r.textId))) {
    ops.push(removeLinks(kind, [textId], toRemove.filter((r) => r.textId === textId).map((r) => r.targetId)));
  }
  if (toAdd.length) ops.push(addLinks(kind, toAdd));
  if (ops.length) await prisma.$transaction(ops);
  return { added: toAdd.length, removed: toRemove.length };
}

// ------------------------------------------------------------------------------------------------ text categories

export async function listCategories(actor: SafeUser, status: "ACTIVE" | "ARCHIVED" | "ALL") {
  const rows = await prisma.textCategory.findMany({ where: { organizationId: actor.organizationId, ...(status === "ALL" ? {} : { status }) }, orderBy: { name: "asc" } });
  const counts = await prisma.textEntryCategory.groupBy({ by: ["categoryId"], where: { categoryId: { in: rows.map((r) => r.id) }, text: { approvalStatus: { not: "ARCHIVED" } } }, _count: { _all: true } });
  const byId = new Map(counts.map((c) => [c.categoryId, c._count._all]));
  return { items: rows.map((r) => categoryDto(r, byId.get(r.id) ?? 0)) };
}

async function uniqueCategorySlug(organizationId: string, name: string): Promise<string> {
  const base = slugify(name);
  for (let n = 0; n < 50; n++) {
    const slug = n === 0 ? base : `${base}-${n + 1}`;
    if (!(await prisma.textCategory.findUnique({ where: { organizationId_slug: { organizationId, slug } }, select: { id: true } }))) return slug;
  }
  throw conflict("Could not find a free short name for this category.");
}

export async function createCategory(actor: SafeUser, input: { name: string; description: string | null }) {
  requireAdmin(actor, "Creating a text category");
  if (await prisma.textCategory.findUnique({ where: { organizationId_name: { organizationId: actor.organizationId, name: input.name } }, select: { id: true } })) {
    throw conflict(`A text category named "${input.name}" already exists.`);
  }
  const row = await prisma.textCategory.create({ data: { organizationId: actor.organizationId, name: input.name, slug: await uniqueCategorySlug(actor.organizationId, input.name), description: input.description, createdById: actor.id } });
  await audit(actor, "TEXT_CATEGORY_CREATED", "TextCategory", row.id, { name: row.name });
  return categoryDto(row, 0);
}

export async function updateCategory(actor: SafeUser, id: string, input: { name?: string; description?: string | null }) {
  requireAdmin(actor, "Editing a text category");
  const row = await prisma.textCategory.findFirst({ where: { id, organizationId: actor.organizationId } });
  if (!row) throw notFound("Text category");
  if (input.name && input.name !== row.name && (await prisma.textCategory.findUnique({ where: { organizationId_name: { organizationId: actor.organizationId, name: input.name } }, select: { id: true } }))) {
    throw conflict(`A text category named "${input.name}" already exists.`);
  }
  const updated = await prisma.textCategory.update({ where: { id }, data: { ...(input.name ? { name: input.name } : {}), ...(input.description !== undefined ? { description: input.description } : {}) } });
  await audit(actor, "TEXT_CATEGORY_UPDATED", "TextCategory", id, { fields: Object.keys(input) });
  const count = await prisma.textEntryCategory.count({ where: { categoryId: id } });
  return categoryDto(updated, count);
}

export async function setCategoryArchived(actor: SafeUser, id: string, archived: boolean) {
  requireAdmin(actor, archived ? "Archiving a text category" : "Restoring a text category");
  const row = await prisma.textCategory.findFirst({ where: { id, organizationId: actor.organizationId } });
  if (!row) throw notFound("Text category");
  const status: LibraryStatus = archived ? "ARCHIVED" : "ACTIVE";
  const updated = row.status === status ? row : await prisma.textCategory.update({ where: { id }, data: { status } });
  if (row.status !== status) await audit(actor, archived ? "TEXT_CATEGORY_ARCHIVED" : "TEXT_CATEGORY_RESTORED", "TextCategory", id);
  return categoryDto(updated, await prisma.textEntryCategory.count({ where: { categoryId: id } }));
}

/** Adds the starter categories that do not exist yet (by name). Idempotent. */
export async function addStarterCategories(actor: SafeUser) {
  requireAdmin(actor, "Adding the starter text categories");
  const existing = await prisma.textCategory.findMany({ where: { organizationId: actor.organizationId }, select: { name: true, slug: true } });
  const names = new Set(existing.map((e) => e.name.toLowerCase()));
  const slugs = new Set(existing.map((e) => e.slug));
  const toCreate = STARTER_TEXT_CATEGORIES.filter((s) => !names.has(s.name.toLowerCase()) && !slugs.has(s.slug));
  if (toCreate.length) await prisma.textCategory.createMany({ data: toCreate.map((s) => ({ organizationId: actor.organizationId, name: s.name, slug: s.slug, description: s.description, createdById: actor.id })) });
  await audit(actor, "TEXT_CATEGORY_STARTERS_ADDED", "TextCategory", undefined, { created: toCreate.map((s) => s.name) });
  return { created: toCreate.map((s) => s.name), ...(await listCategories(actor, "ACTIVE")) };
}

// ------------------------------------------------------------------------------------------------ texts: list and read

export interface ListTextsQuery {
  q?: string;
  status: "ACTIVE" | TextApprovalStatus | "ALL";
  categoryId?: string;
  uncategorized?: boolean;
  language?: string;
  source?: "MANUAL" | "TXT" | "CSV" | "XLSX";
  campaignId?: string;
  pageCategoryId?: string;
  pageId?: string;
  pageGroupId?: string;
  forPageId?: string;
  collectionId?: string;
  batchId?: string;
  rights?: MediaRightsStatus;
  used?: boolean;
  sort: "newest" | "oldest" | "text" | "mostUsed";
  page: number;
  pageSize: number;
}

async function textWhere(organizationId: string, q: Omit<ListTextsQuery, "sort" | "page" | "pageSize">): Promise<Prisma.TextEntryWhereInput> {
  const and: Prisma.TextEntryWhereInput[] = [];
  if (q.q) {
    const folded = normalizeForSearch(q.q);
    and.push({ OR: [{ searchText: { contains: folded } }, { author: { contains: q.q } }, { sourceNote: { contains: q.q } }] });
  }
  if (q.categoryId) and.push({ categories: { some: { categoryId: q.categoryId } } });
  if (q.uncategorized) and.push({ categories: { none: {} } });
  if (q.campaignId) and.push({ campaigns: { some: { campaignId: q.campaignId } } });
  if (q.pageCategoryId) and.push({ pageCategories: { some: { categoryId: q.pageCategoryId } } });
  if (q.pageId) and.push({ pages: { some: { pageId: q.pageId } } });
  if (q.pageGroupId) and.push({ pageGroups: { some: { groupId: q.pageGroupId } } });
  if (q.collectionId) and.push({ collections: { some: { collectionId: q.collectionId } } });
  if (q.forPageId) {
    const page = await prisma.managedPage.findFirst({ where: { id: q.forPageId, organizationId }, select: { id: true, categoryId: true, groupMemberships: { select: { groupId: true } } } });
    if (!page) throw notFound("Page");
    and.push({
      OR: [
        { pageCategories: { none: {} }, pages: { none: {} }, pageGroups: { none: {} } },
        { pages: { some: { pageId: page.id } } },
        { pageGroups: { some: { groupId: { in: page.groupMemberships.map((g) => g.groupId) } } } },
        ...(page.categoryId ? [{ pageCategories: { some: { categoryId: page.categoryId } } }] : []),
      ],
    });
  }
  if (q.used === true) and.push({ usages: { some: {} } });
  if (q.used === false) and.push({ usages: { none: {} } });
  return {
    organizationId,
    ...(q.status === "ACTIVE" ? { approvalStatus: { not: "ARCHIVED" as const } } : q.status === "ALL" ? {} : { approvalStatus: q.status }),
    ...(q.language ? { language: q.language } : {}),
    ...(q.source ? { source: q.source } : {}),
    ...(q.batchId ? { importBatchId: q.batchId } : {}),
    ...(q.rights ? { rightsStatus: q.rights } : {}),
    ...(and.length ? { AND: and } : {}),
  };
}

const ORDER: Record<ListTextsQuery["sort"], Prisma.TextEntryOrderByWithRelationInput[]> = {
  newest: [{ createdAt: "desc" }, { id: "desc" }],
  oldest: [{ createdAt: "asc" }, { id: "asc" }],
  text: [{ searchText: "asc" }, { id: "asc" }],
  mostUsed: [{ usages: { _count: "desc" } }, { createdAt: "desc" }],
};

export async function listTexts(actor: SafeUser, q: ListTextsQuery) {
  const { sort, page, pageSize, ...filters } = q;
  const where = await textWhere(actor.organizationId, filters);
  const [rows, total] = await Promise.all([prisma.textEntry.findMany({ where, include: TEXT_INCLUDE, orderBy: ORDER[sort], skip: (page - 1) * pageSize, take: pageSize }), prisma.textEntry.count({ where })]);
  return { items: rows.map(textDto), total, page, pageSize };
}

/** Counts for the filter bar and the review queue. */
export async function getSummary(actor: SafeUser) {
  const org = actor.organizationId;
  const [byStatus, byLanguage, uncategorized, unused] = await Promise.all([
    prisma.textEntry.groupBy({ by: ["approvalStatus"], where: { organizationId: org }, _count: { _all: true } }),
    prisma.textEntry.groupBy({ by: ["language"], where: { organizationId: org, approvalStatus: { not: "ARCHIVED" } }, _count: { _all: true } }),
    prisma.textEntry.count({ where: { organizationId: org, approvalStatus: { not: "ARCHIVED" }, categories: { none: {} } } }),
    prisma.textEntry.count({ where: { organizationId: org, approvalStatus: "APPROVED", usages: { none: {} } } }),
  ]);
  const status: Record<string, number> = { PENDING: 0, APPROVED: 0, REJECTED: 0, ARCHIVED: 0 };
  for (const s of byStatus) status[s.approvalStatus] = s._count._all;
  return { status, active: status.PENDING! + status.APPROVED! + status.REJECTED!, languages: byLanguage.map((l) => ({ language: l.language, count: l._count._all })), uncategorized, approvedUnused: unused };
}

async function loadText(actor: SafeUser, id: string) {
  const row = await prisma.textEntry.findFirst({ where: { id, organizationId: actor.organizationId }, include: TEXT_INCLUDE });
  if (!row) throw notFound("Text");
  return row;
}

export async function getText(actor: SafeUser, id: string) {
  const row = await loadText(actor, id);
  const [usages, importBatch] = await Promise.all([
    listUsagesRaw(actor.organizationId, id, 1, 20),
    row.importBatchId ? prisma.textImportBatch.findUnique({ where: { id: row.importBatchId }, select: { id: true, fileName: true, createdAt: true } }) : Promise.resolve(null),
  ]);
  return { ...textDto(row), importBatch, recentUsages: usages.items, lastUsedAt: usages.items[0]?.usedAt ?? null };
}

// ------------------------------------------------------------------------------------------------ texts: create and edit

function cleanedOrThrow(raw: string): string {
  const body = cleanText(raw);
  const problem = checkText(body);
  if (problem) throw bad(describeTextProblem(problem), { code: problem });
  return body;
}

async function duplicateOf(organizationId: string, hash: string, exceptId?: string) {
  const found = await prisma.textEntry.findUnique({ where: { organizationId_normalizedHash: { organizationId, normalizedHash: hash } }, select: { id: true, approvalStatus: true, body: true } });
  return found && found.id !== exceptId ? found : null;
}

const duplicateError = (d: { id: string; approvalStatus: TextApprovalStatus }) =>
  conflict(d.approvalStatus === "ARCHIVED" ? "This text is already in the library, archived. Restore it instead of adding it again." : "This text is already in the library.", { code: "DUPLICATE_TEXT", existingId: d.id, existingStatus: d.approvalStatus });

export interface CreateTextInput {
  text: string;
  language: string | null;
  author: string | null;
  sourceNote: string | null;
  notes: string | null;
  categoryIds: string[];
  campaignIds: string[];
  pageCategoryIds: string[];
  pageGroupIds: string[];
  pageIds: string[];
  approveNow: boolean;
}

export async function createText(actor: SafeUser, input: CreateTextInput) {
  const body = cleanedOrThrow(input.text);
  if (input.approveNow) requireAdmin(actor, "Approving a text");
  const hash = duplicateHash(body);
  const dup = await duplicateOf(actor.organizationId, hash);
  if (dup) throw duplicateError(dup);
  await Promise.all([
    assertOwned("categories", actor.organizationId, input.categoryIds),
    assertOwned("campaigns", actor.organizationId, input.campaignIds),
    assertOwned("pageCategories", actor.organizationId, input.pageCategoryIds),
    assertOwned("pageGroups", actor.organizationId, input.pageGroupIds),
    assertOwned("pages", actor.organizationId, input.pageIds),
  ]);
  try {
    const row = await prisma.textEntry.create({
      data: {
        organizationId: actor.organizationId,
        body,
        normalizedHash: hash,
        searchText: searchForm(body),
        charCount: textLength(body),
        language: input.language,
        source: "MANUAL",
        sourceNote: input.sourceNote,
        author: input.author,
        notes: input.notes,
        approvalStatus: input.approveNow ? "APPROVED" : "PENDING",
        ...(input.approveNow ? { approvedById: actor.id, approvedAt: new Date() } : {}),
        createdById: actor.id,
        categories: { create: [...new Set(input.categoryIds)].map((categoryId) => ({ categoryId })) },
        campaigns: { create: [...new Set(input.campaignIds)].map((campaignId) => ({ campaignId })) },
        pageCategories: { create: [...new Set(input.pageCategoryIds)].map((categoryId) => ({ categoryId })) },
        pageGroups: { create: [...new Set(input.pageGroupIds)].map((groupId) => ({ groupId })) },
        pages: { create: [...new Set(input.pageIds)].map((pageId) => ({ pageId })) },
      },
      include: TEXT_INCLUDE,
    });
    await audit(actor, "TEXT_CREATED", "TextEntry", row.id, { source: "MANUAL", approved: input.approveNow });
    return textDto(row);
  } catch (err) {
    // two people adding the same text at the same moment: the unique index decides, the loser gets the duplicate answer
    if (typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002") {
      const again = await duplicateOf(actor.organizationId, hash);
      if (again) throw duplicateError(again);
    }
    throw err;
  }
}

export async function updateText(actor: SafeUser, id: string, input: { text?: string; language?: string | null; author?: string | null; sourceNote?: string | null; notes?: string | null }) {
  const row = await loadText(actor, id);
  if (row.approvalStatus === "ARCHIVED") throw conflict("An archived text cannot be edited. Restore it first.");
  const data: Prisma.TextEntryUpdateInput = {};
  const changed: string[] = [];
  let approvalReset = false;
  if (input.text !== undefined) {
    const body = cleanedOrThrow(input.text);
    if (body !== row.body) {
      const hash = duplicateHash(body);
      const dup = await duplicateOf(actor.organizationId, hash, id);
      if (dup) throw duplicateError(dup);
      Object.assign(data, { body, normalizedHash: hash, searchText: searchForm(body), charCount: textLength(body) });
      changed.push("text");
      // an approval belongs to the exact words that were approved
      if (row.approvalStatus === "APPROVED" || row.approvalStatus === "REJECTED") {
        Object.assign(data, { approvalStatus: "PENDING", approvedById: null, approvedAt: null, reviewNote: null });
        approvalReset = row.approvalStatus === "APPROVED";
      }
    }
  }
  for (const key of ["language", "author", "sourceNote", "notes"] as const) {
    if (input[key] !== undefined && input[key] !== row[key]) {
      Object.assign(data, { [key]: input[key] });
      changed.push(key);
    }
  }
  if (changed.length === 0) return getText(actor, id);
  try {
    await prisma.textEntry.update({ where: { id }, data });
  } catch (err) {
    if (typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002") throw conflict("Another text with the same words already exists.", { code: "DUPLICATE_TEXT" });
    throw err;
  }
  await audit(actor, "TEXT_UPDATED", "TextEntry", id, { fields: changed, approvalReset });
  return getText(actor, id);
}

export async function setLinks(actor: SafeUser, id: string, kind: LinkKind, ids: string[]) {
  await loadText(actor, id);
  const result = await applyLinks(actor, [id], kind, "set", ids);
  if (result.added || result.removed) await audit(actor, "TEXT_ASSIGNMENT_CHANGED", "TextEntry", id, { target: kind, added: result.added, removed: result.removed });
  return getText(actor, id);
}

// ------------------------------------------------------------------------------------------------ texts: review (approval), archive, rights

export async function approveText(actor: SafeUser, id: string, note: string | null) {
  requireAdmin(actor, "Approving a text");
  const row = await loadText(actor, id);
  const problem = reviewBlocker(row.approvalStatus, row.rightsStatus);
  if (problem) throw conflict(problem);
  if (row.approvalStatus === "APPROVED") return getText(actor, id);
  await prisma.textEntry.update({ where: { id }, data: { approvalStatus: "APPROVED", approvedById: actor.id, approvedAt: new Date(), reviewNote: note } });
  await audit(actor, "TEXT_APPROVED", "TextEntry", id);
  return getText(actor, id);
}

export async function rejectText(actor: SafeUser, id: string, note: string) {
  requireAdmin(actor, "Rejecting a text");
  const row = await loadText(actor, id);
  if (row.approvalStatus === "ARCHIVED") throw conflict("An archived text cannot be reviewed. Restore it first.");
  await prisma.textEntry.update({ where: { id }, data: { approvalStatus: "REJECTED", approvedById: null, approvedAt: null, reviewNote: note } });
  await audit(actor, "TEXT_REJECTED", "TextEntry", id);
  return getText(actor, id);
}

/** Why a text cannot be approved right now, or null. */
function reviewBlocker(status: TextApprovalStatus, rights: MediaRightsStatus): string | null {
  if (status === "ARCHIVED") return "An archived text cannot be approved. Restore it first.";
  if (rights === "RESTRICTED") return "This text is marked 'do not use', so it cannot be approved. Change its usage rights first.";
  return null;
}

export async function setTextArchived(actor: SafeUser, id: string, archived: boolean) {
  requireAdmin(actor, archived ? "Archiving a text" : "Restoring a text");
  const row = await loadText(actor, id);
  if (archived) {
    if (row.approvalStatus === "ARCHIVED") return getText(actor, id);
    await prisma.textEntry.update({ where: { id }, data: { approvalStatus: "ARCHIVED" } });
  } else {
    if (row.approvalStatus !== "ARCHIVED") return getText(actor, id);
    // an approved text stays approved when restored (its words cannot change while archived); anything else goes back to review
    await prisma.textEntry.update({ where: { id }, data: { approvalStatus: row.approvedAt ? "APPROVED" : "PENDING" } });
  }
  await audit(actor, archived ? "TEXT_ARCHIVED" : "TEXT_RESTORED", "TextEntry", id);
  return getText(actor, id);
}

export async function setTextRights(actor: SafeUser, id: string, status: MediaRightsStatus, notes: string | null) {
  requireAdmin(actor, "Changing usage rights");
  const row = await loadText(actor, id);
  // a text that may not be used must not stay approved
  const demote = status === "RESTRICTED" && row.approvalStatus === "APPROVED";
  await prisma.textEntry.update({ where: { id }, data: { rightsStatus: status, rightsNotes: notes, ...(demote ? { approvalStatus: "PENDING", approvedById: null, approvedAt: null, reviewNote: "Usage rights were set to 'do not use'." } : {}) } });
  await audit(actor, "TEXT_RIGHTS_CHANGED", "TextEntry", id, { from: row.rightsStatus, to: status, approvalReset: demote });
  return getText(actor, id);
}

// ------------------------------------------------------------------------------------------------ texts: bulk

export type BulkInput =
  | { action: "categories"; ids: string[]; mode: "add" | "remove" | "set"; categoryIds: string[] }
  | { action: "campaigns"; ids: string[]; mode: "add" | "remove" | "set"; campaignIds: string[] }
  | { action: "pageCategories"; ids: string[]; mode: "add" | "remove" | "set"; pageCategoryIds: string[] }
  | { action: "pageGroups"; ids: string[]; mode: "add" | "remove" | "set"; pageGroupIds: string[] }
  | { action: "pages"; ids: string[]; mode: "add" | "remove" | "set"; pageIds: string[] }
  | { action: "language"; ids: string[]; language: string | null }
  | { action: "approve"; ids: string[]; note: string | null }
  | { action: "reject"; ids: string[]; note: string }
  | { action: "archive"; ids: string[] }
  | { action: "restore"; ids: string[] }
  | { action: "rights"; ids: string[]; status: MediaRightsStatus; notes: string | null }
  | { action: "collection"; ids: string[]; mode: "add" | "remove"; collectionId: string };

export interface BulkResult {
  updated: number;
  skipped: { id: string; reason: string }[];
}

/** One request, many texts. Every id must belong to the organization (otherwise nothing changes); texts that cannot take the action are skipped with a reason. */
export async function bulkUpdate(actor: SafeUser, input: BulkInput): Promise<BulkResult> {
  const ids = [...new Set(input.ids)];
  if (ids.length > 500) throw bad("At most 500 texts can be changed at once.");
  const rows = await prisma.textEntry.findMany({ where: { id: { in: ids }, organizationId: actor.organizationId }, select: { id: true, approvalStatus: true, rightsStatus: true, approvedAt: true } });
  if (rows.length !== ids.length) throw notFound("One of the texts");
  const skipped: { id: string; reason: string }[] = [];
  let updated = 0;

  switch (input.action) {
    case "categories":
    case "campaigns":
    case "pageCategories":
    case "pageGroups":
    case "pages": {
      const targets = input.action === "categories" ? input.categoryIds : input.action === "campaigns" ? input.campaignIds : input.action === "pageCategories" ? input.pageCategoryIds : input.action === "pageGroups" ? input.pageGroupIds : input.pageIds;
      await applyLinks(actor, ids, input.action, input.mode, targets);
      updated = ids.length;
      break;
    }
    case "language": {
      const open = rows.filter((r) => r.approvalStatus !== "ARCHIVED");
      for (const r of rows) if (r.approvalStatus === "ARCHIVED") skipped.push({ id: r.id, reason: "archived" });
      await prisma.textEntry.updateMany({ where: { id: { in: open.map((r) => r.id) } }, data: { language: input.language } });
      updated = open.length;
      break;
    }
    case "approve": {
      requireAdmin(actor, "Approving texts");
      const ok: string[] = [];
      for (const r of rows) {
        const why = reviewBlocker(r.approvalStatus, r.rightsStatus);
        if (why) skipped.push({ id: r.id, reason: r.approvalStatus === "ARCHIVED" ? "archived" : "usage rights say do not use" });
        else ok.push(r.id);
      }
      await prisma.textEntry.updateMany({ where: { id: { in: ok } }, data: { approvalStatus: "APPROVED", approvedById: actor.id, approvedAt: new Date(), reviewNote: input.note } });
      updated = ok.length;
      break;
    }
    case "reject": {
      requireAdmin(actor, "Rejecting texts");
      const ok = rows.filter((r) => r.approvalStatus !== "ARCHIVED").map((r) => r.id);
      for (const r of rows) if (r.approvalStatus === "ARCHIVED") skipped.push({ id: r.id, reason: "archived" });
      await prisma.textEntry.updateMany({ where: { id: { in: ok } }, data: { approvalStatus: "REJECTED", approvedById: null, approvedAt: null, reviewNote: input.note } });
      updated = ok.length;
      break;
    }
    case "archive": {
      requireAdmin(actor, "Archiving texts");
      const ok = rows.filter((r) => r.approvalStatus !== "ARCHIVED").map((r) => r.id);
      await prisma.textEntry.updateMany({ where: { id: { in: ok } }, data: { approvalStatus: "ARCHIVED" } });
      updated = ok.length;
      break;
    }
    case "restore": {
      requireAdmin(actor, "Restoring texts");
      const archived = rows.filter((r) => r.approvalStatus === "ARCHIVED");
      await prisma.textEntry.updateMany({ where: { id: { in: archived.filter((r) => r.approvedAt).map((r) => r.id) } }, data: { approvalStatus: "APPROVED" } });
      await prisma.textEntry.updateMany({ where: { id: { in: archived.filter((r) => !r.approvedAt).map((r) => r.id) } }, data: { approvalStatus: "PENDING" } });
      updated = archived.length;
      break;
    }
    case "rights": {
      requireAdmin(actor, "Changing usage rights");
      await prisma.textEntry.updateMany({ where: { id: { in: ids } }, data: { rightsStatus: input.status, rightsNotes: input.notes } });
      if (input.status === "RESTRICTED") {
        await prisma.textEntry.updateMany({ where: { id: { in: ids }, approvalStatus: "APPROVED" }, data: { approvalStatus: "PENDING", approvedById: null, approvedAt: null, reviewNote: "Usage rights were set to 'do not use'." } });
      }
      updated = ids.length;
      break;
    }
    case "collection": {
      requireAdmin(actor, "Organizing collections");
      const collection = await prisma.textCollection.findFirst({ where: { id: input.collectionId, organizationId: actor.organizationId }, select: { id: true, status: true } });
      if (!collection) throw notFound("Collection");
      if (input.mode === "add") {
        if (collection.status === "ARCHIVED") throw conflict("That collection is archived.");
        await prisma.textCollectionItem.createMany({ data: ids.map((textId) => ({ collectionId: collection.id, textId })), skipDuplicates: true });
      } else {
        await prisma.textCollectionItem.deleteMany({ where: { collectionId: collection.id, textId: { in: ids } } });
      }
      updated = ids.length;
      break;
    }
  }
  await audit(actor, "TEXT_BULK_UPDATED", "TextEntry", undefined, { action: input.action, requested: ids.length, updated, skipped: skipped.length });
  return { updated, skipped };
}

// ------------------------------------------------------------------------------------------------ collections

export async function listCollections(actor: SafeUser, status: "ACTIVE" | "ARCHIVED" | "ALL") {
  const rows = await prisma.textCollection.findMany({ where: { organizationId: actor.organizationId, ...(status === "ALL" ? {} : { status }) }, orderBy: { name: "asc" } });
  const counts = await prisma.textCollectionItem.groupBy({ by: ["collectionId"], where: { collectionId: { in: rows.map((r) => r.id) } }, _count: { _all: true } });
  const byId = new Map(counts.map((c) => [c.collectionId, c._count._all]));
  return { items: rows.map((r) => collectionDto(r, byId.get(r.id) ?? 0)) };
}

export async function createCollection(actor: SafeUser, input: { name: string; description: string | null }) {
  requireAdmin(actor, "Creating a collection");
  if (await prisma.textCollection.findUnique({ where: { organizationId_name: { organizationId: actor.organizationId, name: input.name } }, select: { id: true } })) throw conflict(`A collection named "${input.name}" already exists.`);
  const row = await prisma.textCollection.create({ data: { organizationId: actor.organizationId, name: input.name, description: input.description, createdById: actor.id } });
  await audit(actor, "TEXT_COLLECTION_CREATED", "TextCollection", row.id, { name: row.name });
  return collectionDto(row, 0);
}

async function loadCollection(actor: SafeUser, id: string) {
  const row = await prisma.textCollection.findFirst({ where: { id, organizationId: actor.organizationId } });
  if (!row) throw notFound("Collection");
  return row;
}

export async function updateCollection(actor: SafeUser, id: string, input: { name?: string; description?: string | null }) {
  requireAdmin(actor, "Editing a collection");
  const row = await loadCollection(actor, id);
  if (input.name && input.name !== row.name && (await prisma.textCollection.findUnique({ where: { organizationId_name: { organizationId: actor.organizationId, name: input.name } }, select: { id: true } }))) throw conflict(`A collection named "${input.name}" already exists.`);
  const updated = await prisma.textCollection.update({ where: { id }, data: { ...(input.name ? { name: input.name } : {}), ...(input.description !== undefined ? { description: input.description } : {}) } });
  await audit(actor, "TEXT_COLLECTION_UPDATED", "TextCollection", id, { fields: Object.keys(input) });
  return collectionDto(updated, await prisma.textCollectionItem.count({ where: { collectionId: id } }));
}

export async function setCollectionArchived(actor: SafeUser, id: string, archived: boolean) {
  requireAdmin(actor, archived ? "Archiving a collection" : "Restoring a collection");
  const row = await loadCollection(actor, id);
  const status: LibraryStatus = archived ? "ARCHIVED" : "ACTIVE";
  const updated = row.status === status ? row : await prisma.textCollection.update({ where: { id }, data: { status } });
  if (row.status !== status) await audit(actor, archived ? "TEXT_COLLECTION_ARCHIVED" : "TEXT_COLLECTION_RESTORED", "TextCollection", id);
  return collectionDto(updated, await prisma.textCollectionItem.count({ where: { collectionId: id } }));
}

export async function changeCollectionItems(actor: SafeUser, id: string, textIds: string[], mode: "add" | "remove") {
  const result = await bulkUpdate(actor, { action: "collection", ids: textIds, mode, collectionId: id });
  await audit(actor, "TEXT_COLLECTION_ITEMS_CHANGED", "TextCollection", id, { mode, count: result.updated });
  const row = await loadCollection(actor, id);
  return collectionDto(row, await prisma.textCollectionItem.count({ where: { collectionId: id } }));
}

// ------------------------------------------------------------------------------------------------ usage history

async function listUsagesRaw(organizationId: string, textId: string, page: number, pageSize: number) {
  const where = { organizationId, textId };
  const [rows, total] = await Promise.all([prisma.textUsage.findMany({ where, orderBy: [{ usedAt: "desc" }, { id: "desc" }], skip: (page - 1) * pageSize, take: pageSize }), prisma.textUsage.count({ where })]);
  // the references are plain ids (the history outlives what it points at): a target that no longer exists shows as null
  const ids = (pick: (u: (typeof rows)[number]) => string | null) => [...new Set(rows.map(pick).filter((v): v is string => Boolean(v)))];
  const [pages, campaigns, recipes, assets] = await Promise.all([
    prisma.managedPage.findMany({ where: { organizationId, id: { in: ids((u) => u.pageId) } }, select: { id: true, name: true } }),
    prisma.campaign.findMany({ where: { organizationId, id: { in: ids((u) => u.campaignId) } }, select: { id: true, name: true } }),
    prisma.contentRecipe.findMany({ where: { organizationId, id: { in: ids((u) => u.recipeId) } }, select: { id: true, name: true } }),
    prisma.mediaAsset.findMany({ where: { organizationId, id: { in: ids((u) => u.mediaAssetId) } }, select: { id: true, originalName: true } }),
  ]);
  const byId = <T extends { id: string }>(list: T[]) => new Map(list.map((x) => [x.id, x]));
  const [pageMap, campaignMap, recipeMap, assetMap] = [byId(pages), byId(campaigns), byId(recipes), byId(assets)];
  return {
    total,
    page,
    pageSize,
    items: rows.map((u) => {
      const asset = u.mediaAssetId ? assetMap.get(u.mediaAssetId) : undefined;
      return {
        id: u.id,
        kind: u.kind,
        usedAt: u.usedAt,
        note: u.note,
        page: u.pageId ? (pageMap.get(u.pageId) ?? null) : null,
        campaign: u.campaignId ? (campaignMap.get(u.campaignId) ?? null) : null,
        recipe: u.recipeId ? (recipeMap.get(u.recipeId) ?? null) : null,
        mediaAsset: asset ? { id: asset.id, name: asset.originalName } : null,
        contentId: u.contentId,
        recordedById: u.recordedById,
      };
    }),
  };
}

export async function listUsages(actor: SafeUser, id: string, page: number, pageSize: number) {
  await loadText(actor, id);
  return listUsagesRaw(actor.organizationId, id, page, pageSize);
}

export interface UsageInput {
  kind: "MANUAL" | "PUBLICATION";
  note: string | null;
  pageId?: string | undefined;
  campaignId?: string | undefined;
  recipeId?: string | undefined;
  mediaAssetId?: string | undefined;
  contentId?: string | undefined;
  usedAt?: Date | undefined;
}

/**
 * Records that a text was used (never written by a preview). Only an approved text can have a use recorded, and every
 * reference (page, campaign, recipe, source file, content) must belong to the organization: the history is the trace
 * from a published piece back to its text, recipe and source media.
 */
export async function recordUsage(actor: SafeUser, id: string, input: UsageInput) {
  const row = await loadText(actor, id);
  if (row.approvalStatus !== "APPROVED") throw conflict("Only an approved text can be recorded as used.");
  const org = actor.organizationId;
  const [page, campaign, recipe, asset, content] = await Promise.all([
    input.pageId ? prisma.managedPage.findFirst({ where: { id: input.pageId, organizationId: org }, select: { id: true } }) : null,
    input.campaignId ? prisma.campaign.findFirst({ where: { id: input.campaignId, organizationId: org }, select: { id: true } }) : null,
    input.recipeId ? prisma.contentRecipe.findFirst({ where: { id: input.recipeId, organizationId: org }, select: { id: true } }) : null,
    input.mediaAssetId ? prisma.mediaAsset.findFirst({ where: { id: input.mediaAssetId, organizationId: org }, select: { id: true } }) : null,
    input.contentId ? prisma.content.findFirst({ where: { id: input.contentId, organizationId: org }, select: { id: true } }) : null,
  ]);
  if (input.pageId && !page) throw notFound("Page");
  if (input.campaignId && !campaign) throw notFound("Campaign");
  if (input.recipeId && !recipe) throw notFound("Recipe");
  if (input.mediaAssetId && !asset) throw notFound("Source file");
  if (input.contentId && !content) throw notFound("Content");
  const usage = await prisma.textUsage.create({
    data: {
      organizationId: org,
      textId: id,
      kind: input.kind,
      note: input.note,
      pageId: input.pageId ?? null,
      campaignId: input.campaignId ?? null,
      recipeId: input.recipeId ?? null,
      mediaAssetId: input.mediaAssetId ?? null,
      contentId: input.contentId ?? null,
      usedAt: input.usedAt ?? new Date(),
      recordedById: actor.id,
    },
  });
  await audit(actor, "TEXT_USAGE_RECORDED", "TextEntry", id, { kind: input.kind, pageId: input.pageId, recipeId: input.recipeId, contentId: input.contentId });
  return { id: usage.id, usageCount: await prisma.textUsage.count({ where: { textId: id } }) };
}
