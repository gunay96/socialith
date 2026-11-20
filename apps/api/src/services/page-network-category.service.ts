import { prisma } from "@socialith/database";
import { STARTER_CATEGORIES, type EditorialProfile } from "@socialith/publishing";
import { createAuditLog } from "../repositories/audit-log.repository.js";
import type { SafeUser } from "../types/auth.js";
import { asProfile, badRequest, conflict, conflictOrRethrow, notFound, profileToStore, slugify } from "./page-network-common.js";

type CategoryRow = Awaited<ReturnType<typeof prisma.pageCategory.findFirstOrThrow>>;

export function toCategoryDto(c: CategoryRow, pageCount?: number) {
  return {
    id: c.id,
    name: c.name,
    slug: c.slug,
    description: c.description,
    language: c.language,
    defaultEditorialStyle: c.defaultEditorialStyle,
    contentPreferences: asProfile(c.contentPreferences),
    status: c.status,
    ...(pageCount === undefined ? {} : { pageCount }),
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

async function load(actor: SafeUser, id: string) {
  const row = await prisma.pageCategory.findFirst({ where: { id, organizationId: actor.organizationId } });
  if (!row) throw notFound("Category");
  return row;
}

export async function listCategories(actor: SafeUser, status: "ACTIVE" | "ARCHIVED" | "ALL") {
  const rows = await prisma.pageCategory.findMany({
    where: { organizationId: actor.organizationId, ...(status === "ALL" ? {} : { status }) },
    orderBy: [{ name: "asc" }],
  });
  const counts = await prisma.managedPage.groupBy({
    by: ["categoryId"],
    where: { organizationId: actor.organizationId, status: "ACTIVE", categoryId: { in: rows.map((r) => r.id) } },
    _count: { _all: true },
  });
  const byId = new Map(counts.map((c) => [c.categoryId, c._count._all]));
  return { items: rows.map((r) => toCategoryDto(r, byId.get(r.id) ?? 0)) };
}

export async function getCategory(actor: SafeUser, id: string) {
  const row = await load(actor, id);
  const pageCount = await prisma.managedPage.count({ where: { organizationId: actor.organizationId, categoryId: id, status: "ACTIVE" } });
  return toCategoryDto(row, pageCount);
}

export interface CategoryInput {
  name: string;
  slug?: string;
  description?: string | null;
  language?: string;
  defaultEditorialStyle?: string | null;
  contentPreferences?: EditorialProfile | null;
}

async function organizationLanguage(organizationId: string): Promise<string> {
  const org = await prisma.organization.findUnique({ where: { id: organizationId }, select: { language: true } });
  return org?.language ?? "tr";
}

export async function createCategory(actor: SafeUser, input: CategoryInput) {
  const slug = input.slug ?? slugify(input.name);
  if (slug.length < 2) throw badRequest("Could not derive a slug from the name; provide one.");
  try {
    const row = await prisma.pageCategory.create({
      data: {
        organizationId: actor.organizationId,
        name: input.name,
        slug,
        description: input.description ?? null,
        language: input.language ?? (await organizationLanguage(actor.organizationId)),
        defaultEditorialStyle: input.defaultEditorialStyle ?? null,
        contentPreferences: profileToStore(input.contentPreferences),
      },
    });
    await createAuditLog({ organizationId: actor.organizationId, userId: actor.id, action: "PAGE_CATEGORY_CREATED", targetType: "PageCategory", targetId: row.id, metadata: { name: row.name } });
    return toCategoryDto(row, 0);
  } catch (err) {
    return conflictOrRethrow(err, "A category with that name or slug already exists.");
  }
}

export async function updateCategory(actor: SafeUser, id: string, input: Partial<CategoryInput>) {
  const before = await load(actor, id);
  const data = {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.language !== undefined ? { language: input.language } : {}),
    ...(input.defaultEditorialStyle !== undefined ? { defaultEditorialStyle: input.defaultEditorialStyle } : {}),
    ...(input.contentPreferences !== undefined ? { contentPreferences: profileToStore(input.contentPreferences) } : {}),
  };
  try {
    const row = await prisma.pageCategory.update({ where: { id }, data });
    await createAuditLog({ organizationId: actor.organizationId, userId: actor.id, action: "PAGE_CATEGORY_UPDATED", targetType: "PageCategory", targetId: id, metadata: { fields: Object.keys(data), previousName: before.name } });
    return getCategory(actor, row.id);
  } catch (err) {
    return conflictOrRethrow(err, "A category with that name already exists.");
  }
}

/** Archived, never deleted: pages keep their category (shown as archived); only new assignments are refused. */
export async function archiveCategory(actor: SafeUser, id: string) {
  const row = await load(actor, id);
  if (row.status === "ARCHIVED") return getCategory(actor, id);
  await prisma.pageCategory.update({ where: { id }, data: { status: "ARCHIVED" } });
  const pages = await prisma.managedPage.count({ where: { organizationId: actor.organizationId, categoryId: id, status: "ACTIVE" } });
  await createAuditLog({ organizationId: actor.organizationId, userId: actor.id, action: "PAGE_CATEGORY_ARCHIVED", targetType: "PageCategory", targetId: id, metadata: { name: row.name, activePages: pages } });
  return getCategory(actor, id);
}

export async function restoreCategory(actor: SafeUser, id: string) {
  const row = await load(actor, id);
  if (row.status === "ACTIVE") return getCategory(actor, id);
  await prisma.pageCategory.update({ where: { id }, data: { status: "ACTIVE" } });
  await createAuditLog({ organizationId: actor.organizationId, userId: actor.id, action: "PAGE_CATEGORY_RESTORED", targetType: "PageCategory", targetId: id, metadata: { name: row.name } });
  return getCategory(actor, id);
}

/**
 * Adds the starter categories that do not exist yet (matched by slug OR name, so a category the administrator already
 * created or renamed is never duplicated or overwritten). Idempotent: running it again adds nothing.
 */
export async function addStarterCategories(actor: SafeUser, language?: string) {
  const lang = language ?? (await organizationLanguage(actor.organizationId));
  const existing = await prisma.pageCategory.findMany({ where: { organizationId: actor.organizationId }, select: { slug: true, name: true } });
  const slugs = new Set(existing.map((e) => e.slug));
  const names = new Set(existing.map((e) => e.name.toLowerCase()));
  const created: string[] = [];
  for (const s of STARTER_CATEGORIES) {
    if (slugs.has(s.slug) || names.has(s.name.toLowerCase())) continue;
    try {
      await prisma.pageCategory.create({
        data: { organizationId: actor.organizationId, name: s.name, slug: s.slug, description: s.description, language: lang, defaultEditorialStyle: s.defaultEditorialStyle, contentPreferences: profileToStore(s.profile) },
      });
      created.push(s.name);
    } catch (err) {
      if ((err as { code?: string }).code !== "P2002") throw err; // created concurrently: fine
    }
  }
  if (created.length > 0) {
    await createAuditLog({ organizationId: actor.organizationId, userId: actor.id, action: "PAGE_CATEGORY_STARTERS_ADDED", targetType: "PageCategory", metadata: { created } });
  }
  return { created, skipped: STARTER_CATEGORIES.map((s) => s.name).filter((n) => !created.includes(n)), ...(await listCategories(actor, "ALL")) };
}

/** Used by page writes: the category must belong to the organization and, for a new assignment, be active. */
export async function requireAssignableCategory(organizationId: string, categoryId: string, currentCategoryId?: string | null) {
  const c = await prisma.pageCategory.findFirst({ where: { id: categoryId, organizationId } });
  if (!c) throw notFound("Category");
  if (c.status === "ARCHIVED" && c.id !== currentCategoryId) throw conflict(`The category "${c.name}" is archived. Restore it or choose another one.`);
  return c;
}
