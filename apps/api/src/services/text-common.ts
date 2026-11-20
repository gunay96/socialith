import { createHash } from "node:crypto";
import type { Prisma, TextCategory, TextCollection, TextEntry } from "@socialith/database";
import { normalizeForDuplicate, normalizeForSearch } from "@socialith/studio";

/** The hash that makes two spellings of the same text the same text (see normalizeForDuplicate). */
export const duplicateHash = (body: string): string => createHash("sha256").update(normalizeForDuplicate(body)).digest("hex");
export const searchForm = normalizeForSearch;

export function slugify(name: string): string {
  const slug = normalizeForSearch(name).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return slug || "category";
}

export const TEXT_INCLUDE = {
  categories: { include: { category: { select: { id: true, name: true } } }, orderBy: { assignedAt: "asc" } },
  campaigns: { include: { campaign: { select: { id: true, name: true } } } },
  pageCategories: { include: { category: { select: { id: true, name: true } } } },
  pages: { include: { page: { select: { id: true, name: true, platform: true, username: true } } } },
  pageGroups: { include: { group: { select: { id: true, name: true } } } },
  collections: { include: { collection: { select: { id: true, name: true } } } },
  _count: { select: { usages: true } },
} satisfies Prisma.TextEntryInclude;

export type TextWithRelations = Prisma.TextEntryGetPayload<{ include: typeof TEXT_INCLUDE }>;

export function textDto(t: TextWithRelations) {
  return {
    id: t.id,
    text: t.body,
    charCount: t.charCount,
    language: t.language,
    source: t.source,
    sourceNote: t.sourceNote,
    sourceRow: t.sourceRow,
    importBatchId: t.importBatchId,
    author: t.author,
    rights: { status: t.rightsStatus, notes: t.rightsNotes },
    approval: { status: t.approvalStatus, approvedAt: t.approvedAt, approvedById: t.approvedById, reviewNote: t.reviewNote },
    notes: t.notes,
    categories: t.categories.map((c) => c.category),
    campaigns: t.campaigns.map((c) => c.campaign),
    pageCategories: t.pageCategories.map((c) => c.category),
    pages: t.pages.map((p) => p.page),
    pageGroups: t.pageGroups.map((g) => g.group),
    collections: t.collections.map((c) => c.collection),
    /** Empty applicability means "suits any page". */
    appliesToAllPages: t.pageCategories.length + t.pages.length + t.pageGroups.length === 0,
    usageCount: t._count.usages,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}
export type TextDto = ReturnType<typeof textDto>;

export function categoryDto(c: TextCategory, textCount: number) {
  return { id: c.id, name: c.name, slug: c.slug, description: c.description, status: c.status, textCount, createdAt: c.createdAt };
}

export function collectionDto(c: TextCollection, itemCount: number) {
  return { id: c.id, name: c.name, description: c.description, status: c.status, itemCount, createdAt: c.createdAt };
}

export type TextRow = TextEntry;
