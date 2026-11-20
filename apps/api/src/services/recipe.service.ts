import { prisma } from "@socialith/database";
import type { LibraryStatus, Prisma } from "@socialith/database";
import { EDITORIAL_FORMATS, resolveEditorialIdentity, type ResolvedIdentity } from "@socialith/publishing";
import {
  RECIPE_PRESETS,
  checkRecipeCompatibility,
  buildTimeline,
  computeLayout,
  decideOutput,
  planSubtitles,
  planText,
  textRenderProblem,
  emptyRecipeConfig,
  hasBlockingIssue,
  parseRecipeConfig,
  presetByKey,
  resolveEffectiveRecipe,
  selectRecipesForPage,
  recipeAdjustmentSchema,
  type CompatAsset,
  type CompatTarget,
  type CompatText,
  type RecipeAdjustment,
  type RecipeConfig,
  type RecipeScope,
} from "@socialith/studio";
import { ERROR_CODES } from "@socialith/types";
import { ApiHttpError } from "../middleware/error-handler.js";
import { createAuditLog } from "../repositories/audit-log.repository.js";
import { logger } from "../logger.js";
import type { SafeUser } from "../types/auth.js";
import { assetDto, ASSET_INCLUDE, conflict, notFound } from "./media-common.js";
import { PAGE_INCLUDE, groupLayer, resolveForPage } from "./page-network-common.js";
import { requireAdmin } from "./text-library.service.js";
import { TEXT_INCLUDE } from "./text-common.js";

/** Shown in the preview when no text is chosen. */
export const PLACEHOLDER_TEXT = "Your text appears here";

const bad = (message: string, details?: unknown) => new ApiHttpError(400, ERROR_CODES.INVALID_REQUEST, message, details);
const audit = (actor: SafeUser, action: Parameters<typeof createAuditLog>[0]["action"], targetId: string | undefined, metadata?: Record<string, unknown>) =>
  createAuditLog({ organizationId: actor.organizationId, userId: actor.id, action, targetType: "ContentRecipe", ...(targetId ? { targetId } : {}), ...(metadata ? { metadata } : {}) });

const RECIPE_INCLUDE = {
  pageCategories: { include: { category: { select: { id: true, name: true } } } },
  pageGroups: { include: { group: { select: { id: true, name: true } } } },
  pages: { include: { page: { select: { id: true, name: true } } } },
} satisfies Prisma.ContentRecipeInclude;
type RecipeRow = Prisma.ContentRecipeGetPayload<{ include: typeof RECIPE_INCLUDE }>;

function configOf(row: Pick<RecipeRow, "config" | "id">): { config: RecipeConfig; problem: string | null } {
  const parsed = parseRecipeConfig(row.config);
  if (parsed.ok) return { config: parsed.config, problem: null };
  logger.warn({ recipeId: row.id, problem: parsed.message }, "Stored recipe configuration is invalid");
  return { config: emptyRecipeConfig(), problem: parsed.message };
}

function scopeOf(row: RecipeRow): RecipeScope & { config: RecipeConfig } {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    pageIds: row.pages.map((p) => p.pageId),
    pageGroupIds: row.pageGroups.map((g) => g.groupId),
    pageCategoryIds: row.pageCategories.map((c) => c.categoryId),
    compatibleMedia: configOf(row).config.compatibleMedia,
    config: configOf(row).config,
  };
}

/** Names for the plain id references of a recipe (its text category and the recipe it was copied from); a removed target is simply absent. */
interface Refs {
  categories: Map<string, { id: string; name: string }>;
  recipes: Map<string, { id: string; name: string }>;
}

async function loadRefs(rows: RecipeRow[]): Promise<Refs> {
  const categoryIds = [...new Set(rows.map((r) => r.requiredTextCategoryId).filter((v): v is string => Boolean(v)))];
  const recipeIds = [...new Set(rows.map((r) => r.duplicatedFromId).filter((v): v is string => Boolean(v)))];
  const [categories, recipes] = await Promise.all([
    categoryIds.length ? prisma.textCategory.findMany({ where: { id: { in: categoryIds } }, select: { id: true, name: true } }) : [],
    recipeIds.length ? prisma.contentRecipe.findMany({ where: { id: { in: recipeIds } }, select: { id: true, name: true } }) : [],
  ]);
  return { categories: new Map(categories.map((c) => [c.id, c])), recipes: new Map(recipes.map((r) => [r.id, r])) };
}

async function dtoOf(row: RecipeRow) {
  return recipeDto(row, await loadRefs([row]));
}

export function recipeDto(row: RecipeRow, refs: Refs) {
  const { config, problem } = configOf(row);
  const format = row.formatId ? EDITORIAL_FORMATS.find((f) => f.id === row.formatId) : undefined;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    formatId: row.formatId,
    format: format ? { id: format.id, label: format.label, needsVerifiedFacts: format.needsVerifiedFacts } : null,
    presetKey: row.presetKey,
    config,
    configProblem: problem,
    previewConfig: row.previewConfig,
    requiredTextCategory: row.requiredTextCategoryId ? (refs.categories.get(row.requiredTextCategoryId) ?? null) : null,
    duplicatedFrom: row.duplicatedFromId ? (refs.recipes.get(row.duplicatedFromId) ?? null) : null,
    assignments: {
      pageCategories: row.pageCategories.map((c) => c.category),
      pageGroups: row.pageGroups.map((g) => g.group),
      pages: row.pages.map((p) => p.page),
      /** No assignments = the recipe suits every page. */
      appliesToAllPages: row.pageCategories.length + row.pageGroups.length + row.pages.length === 0,
    },
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
export type RecipeDto = ReturnType<typeof recipeDto>;

async function loadRecipe(actor: SafeUser, id: string): Promise<RecipeRow> {
  const row = await prisma.contentRecipe.findFirst({ where: { id, organizationId: actor.organizationId }, include: RECIPE_INCLUDE });
  if (!row) throw notFound("Recipe");
  return row;
}

function validConfig(input: unknown): RecipeConfig {
  const parsed = parseRecipeConfig(input);
  if (!parsed.ok) throw bad(`Invalid recipe settings: ${parsed.message}`, { issues: parsed.issues });
  return parsed.config;
}

async function requireTextCategory(organizationId: string, id: string | null): Promise<void> {
  if (!id) return;
  if (!(await prisma.textCategory.findFirst({ where: { id, organizationId, status: "ACTIVE" }, select: { id: true } }))) throw notFound("Text category");
}

async function assertScope(organizationId: string, scope: { pageCategoryIds?: string[] | undefined; pageGroupIds?: string[] | undefined; pageIds?: string[] | undefined }): Promise<void> {
  const check = async (label: string, ids: string[] | undefined, count: (where: { id: { in: string[] }; organizationId: string; status: "ACTIVE" }) => Promise<number>) => {
    const unique = [...new Set(ids ?? [])];
    if (unique.length && (await count({ id: { in: unique }, organizationId, status: "ACTIVE" })) !== unique.length) throw notFound(`One of the ${label}`);
  };
  await check("page categories", scope.pageCategoryIds, (where) => prisma.pageCategory.count({ where }));
  await check("page groups", scope.pageGroupIds, (where) => prisma.pageGroup.count({ where }));
  await check("pages", scope.pageIds, (where) => prisma.managedPage.count({ where }));
}

async function uniqueName(organizationId: string, base: string, suffix: (n: number) => string): Promise<string> {
  const taken = new Set((await prisma.contentRecipe.findMany({ where: { organizationId, name: { startsWith: base.slice(0, 100) } }, select: { name: true } })).map((r) => r.name));
  if (!taken.has(base)) return base;
  for (let n = 2; n < 200; n++) {
    const candidate = suffix(n).slice(0, 120);
    if (!taken.has(candidate)) return candidate;
  }
  throw conflict("Could not find a free name for this recipe.");
}

const isUniqueViolation = (err: unknown) => typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002";

// ------------------------------------------------------------------------------------------------ read

export interface ListRecipesQuery {
  status: "ACTIVE" | "ARCHIVED" | "ALL";
  q?: string;
  mediaKind?: "IMAGE" | "VIDEO";
  pageCategoryId?: string;
  pageGroupId?: string;
  pageId?: string;
  textCategoryId?: string;
  forPageId?: string;
  forMedia?: "IMAGE" | "VIDEO";
  presetKey?: string;
  installed?: boolean;
}

export async function listRecipes(actor: SafeUser, q: ListRecipesQuery) {
  const org = actor.organizationId;
  const where: Prisma.ContentRecipeWhereInput = {
    organizationId: org,
    ...(q.status === "ALL" ? {} : { status: q.status }),
    ...(q.q ? { OR: [{ name: { contains: q.q } }, { description: { contains: q.q } }] } : {}),
    ...(q.textCategoryId ? { requiredTextCategoryId: q.textCategoryId } : {}),
    ...(q.pageCategoryId ? { pageCategories: { some: { categoryId: q.pageCategoryId } } } : {}),
    ...(q.pageGroupId ? { pageGroups: { some: { groupId: q.pageGroupId } } } : {}),
    ...(q.pageId ? { pages: { some: { pageId: q.pageId } } } : {}),
    ...(q.presetKey ? { presetKey: q.presetKey } : {}),
  };
  const rows = await prisma.contentRecipe.findMany({ where, include: RECIPE_INCLUDE, orderBy: [{ name: "asc" }], take: 300 });

  if (q.forPageId) {
    const page = await prisma.managedPage.findFirst({ where: { id: q.forPageId, organizationId: org }, select: { id: true, categoryId: true, groupMemberships: { select: { groupId: true } } } });
    if (!page) throw notFound("Page");
    const byId = new Map(rows.map((r) => [r.id, r]));
    const matches = selectRecipesForPage(rows.map(scopeOf), { id: page.id, categoryId: page.categoryId, groupIds: page.groupMemberships.map((g) => g.groupId) }, q.forMedia ? { mediaKind: q.forMedia } : {});
    const refs = await loadRefs(rows);
    return { items: matches.map((m) => ({ ...recipeDto(byId.get(m.recipe.id)!, refs), matchedBy: m.matchedBy })), total: matches.length };
  }
  const filtered = q.mediaKind ? rows.filter((r) => configOf(r).config.compatibleMedia.includes(q.mediaKind!)) : rows;
  const refs = await loadRefs(filtered);
  return { items: filtered.map((r) => ({ ...recipeDto(r, refs), matchedBy: null })), total: filtered.length };
}

export async function getRecipe(actor: SafeUser, id: string) {
  return dtoOf(await loadRecipe(actor, id));
}

/** The built-in presets, with the recipe that was created from each one (if any). */
export async function listPresets(actor: SafeUser) {
  const installed = await prisma.contentRecipe.findMany({ where: { organizationId: actor.organizationId, presetKey: { not: null } }, select: { id: true, name: true, presetKey: true, status: true }, orderBy: { createdAt: "asc" } });
  return {
    items: RECIPE_PRESETS.map((p) => ({
      key: p.key,
      name: p.name,
      description: p.description,
      formatId: p.formatId,
      textCategorySlug: p.textCategorySlug,
      config: p.config,
      recipes: installed.filter((i) => i.presetKey === p.key).map((i) => ({ id: i.id, name: i.name, status: i.status })),
    })),
  };
}

// ------------------------------------------------------------------------------------------------ write

export interface CreateRecipeInput {
  name: string;
  description: string | null;
  formatId: string | null;
  /** Omitted = a blank recipe (everything inherits). */
  config?: unknown;
  requiredTextCategoryId: string | null;
  pageCategoryIds: string[];
  pageGroupIds: string[];
  pageIds: string[];
  presetKey?: string | null;
  duplicatedFromId?: string | null;
}

export async function createRecipe(actor: SafeUser, input: CreateRecipeInput) {
  requireAdmin(actor, "Creating a recipe");
  const org = actor.organizationId;
  const config = validConfig(input.config);
  await requireTextCategory(org, input.requiredTextCategoryId);
  await assertScope(org, input);
  try {
    const row = await prisma.contentRecipe.create({
      data: {
        organizationId: org,
        name: input.name,
        description: input.description,
        formatId: input.formatId,
        presetKey: input.presetKey ?? null,
        config: config as unknown as Prisma.InputJsonValue,
        requiredTextCategoryId: input.requiredTextCategoryId,
        duplicatedFromId: input.duplicatedFromId ?? null,
        createdById: actor.id,
        updatedById: actor.id,
        pageCategories: { create: [...new Set(input.pageCategoryIds)].map((categoryId) => ({ categoryId })) },
        pageGroups: { create: [...new Set(input.pageGroupIds)].map((groupId) => ({ groupId })) },
        pages: { create: [...new Set(input.pageIds)].map((pageId) => ({ pageId })) },
      },
      include: RECIPE_INCLUDE,
    });
    await audit(actor, input.duplicatedFromId ? "RECIPE_DUPLICATED" : "RECIPE_CREATED", row.id, { name: row.name, presetKey: row.presetKey, duplicatedFrom: input.duplicatedFromId ?? undefined });
    return dtoOf(row);
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict(`A recipe named "${input.name}" already exists.`);
    throw err;
  }
}

/** Creates a recipe from a built-in preset. The text category is linked when the organization has the matching one. */
export async function createFromPreset(actor: SafeUser, presetKey: string, name?: string) {
  requireAdmin(actor, "Creating a recipe");
  const preset = presetByKey(presetKey);
  if (!preset) throw notFound("Preset");
  const category = preset.textCategorySlug ? await prisma.textCategory.findFirst({ where: { organizationId: actor.organizationId, slug: preset.textCategorySlug, status: "ACTIVE" }, select: { id: true } }) : null;
  const finalName = name ?? (await uniqueName(actor.organizationId, preset.name, (n) => `${preset.name} (${n})`));
  return createRecipe(actor, { name: finalName, description: preset.description, formatId: preset.formatId, config: preset.config, requiredTextCategoryId: category?.id ?? null, pageCategoryIds: [], pageGroupIds: [], pageIds: [], presetKey: preset.key });
}

/** Adds every preset that has no recipe yet. Idempotent: a preset the organization already has is not added again. */
export async function installPresets(actor: SafeUser) {
  requireAdmin(actor, "Installing the preset recipes");
  const have = new Set((await prisma.contentRecipe.findMany({ where: { organizationId: actor.organizationId, presetKey: { not: null } }, select: { presetKey: true } })).map((r) => r.presetKey));
  const created: string[] = [];
  for (const preset of RECIPE_PRESETS) {
    if (have.has(preset.key)) continue;
    created.push((await createFromPreset(actor, preset.key)).name);
  }
  await audit(actor, "RECIPE_PRESETS_INSTALLED", undefined, { created });
  return { created, ...(await listPresets(actor)) };
}

export async function updateRecipe(actor: SafeUser, id: string, input: { name?: string; description?: string | null; formatId?: string | null; config?: unknown; requiredTextCategoryId?: string | null }) {
  requireAdmin(actor, "Editing a recipe");
  const row = await loadRecipe(actor, id);
  if (row.status === "ARCHIVED") throw conflict("An archived recipe cannot be edited. Restore it first.");
  const data: Prisma.ContentRecipeUncheckedUpdateInput = { updatedById: actor.id, version: { increment: 1 } };
  const changed: string[] = [];
  if (input.name !== undefined && input.name !== row.name) {
    data.name = input.name;
    changed.push("name");
  }
  if (input.description !== undefined && input.description !== row.description) {
    data.description = input.description;
    changed.push("description");
  }
  if (input.formatId !== undefined && input.formatId !== row.formatId) {
    data.formatId = input.formatId;
    changed.push("format");
  }
  if (input.requiredTextCategoryId !== undefined && input.requiredTextCategoryId !== row.requiredTextCategoryId) {
    await requireTextCategory(actor.organizationId, input.requiredTextCategoryId);
    data.requiredTextCategoryId = input.requiredTextCategoryId;
    changed.push("textCategory");
  }
  if (input.config !== undefined) {
    const config = validConfig(input.config);
    if (JSON.stringify(config) !== JSON.stringify(configOf(row).config)) {
      data.config = config as unknown as Prisma.InputJsonValue;
      changed.push("settings");
    }
  }
  if (changed.length === 0) return dtoOf(row);
  try {
    await prisma.contentRecipe.update({ where: { id }, data });
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict(`A recipe named "${input.name}" already exists.`);
    throw err;
  }
  await audit(actor, "RECIPE_UPDATED", id, { fields: changed });
  return getRecipe(actor, id);
}

/** A copy: same settings, same assignments, same text category; a new name; traceable to the original. */
export async function duplicateRecipe(actor: SafeUser, id: string, name?: string) {
  requireAdmin(actor, "Duplicating a recipe");
  const row = await loadRecipe(actor, id);
  const finalName = name ?? (await uniqueName(actor.organizationId, `${row.name} (copy)`, (n) => `${row.name} (copy ${n})`));
  return createRecipe(actor, {
    name: finalName,
    description: row.description,
    formatId: row.formatId,
    config: configOf(row).config,
    requiredTextCategoryId: row.requiredTextCategoryId,
    pageCategoryIds: row.pageCategories.map((c) => c.categoryId),
    pageGroupIds: row.pageGroups.map((g) => g.groupId),
    pageIds: row.pages.map((p) => p.pageId),
    presetKey: row.presetKey,
    duplicatedFromId: row.id,
  });
}

export async function setRecipeArchived(actor: SafeUser, id: string, archived: boolean) {
  requireAdmin(actor, archived ? "Archiving a recipe" : "Restoring a recipe");
  const row = await loadRecipe(actor, id);
  const status: LibraryStatus = archived ? "ARCHIVED" : "ACTIVE";
  if (row.status !== status) {
    await prisma.contentRecipe.update({ where: { id }, data: { status, updatedById: actor.id } });
    await audit(actor, archived ? "RECIPE_ARCHIVED" : "RECIPE_RESTORED", id);
  }
  return getRecipe(actor, id);
}

/** Replaces the page categories / page groups / pages this recipe is limited to (only the lists that are sent). */
export async function setAssignments(actor: SafeUser, id: string, input: { pageCategoryIds?: string[] | undefined; pageGroupIds?: string[] | undefined; pageIds?: string[] | undefined }) {
  requireAdmin(actor, "Assigning a recipe");
  const row = await loadRecipe(actor, id);
  if (row.status === "ARCHIVED") throw conflict("An archived recipe cannot be changed. Restore it first.");
  await assertScope(actor.organizationId, input);
  const ops: Prisma.PrismaPromise<unknown>[] = [];
  const changed: string[] = [];
  const replace = (key: "pageCategories" | "pageGroups" | "pages", wanted: string[] | undefined, current: string[]) => {
    if (wanted === undefined) return;
    const next = [...new Set(wanted)];
    if (next.length === current.length && next.every((n) => current.includes(n))) return;
    changed.push(key);
    if (key === "pageCategories") ops.push(prisma.contentRecipePageCategory.deleteMany({ where: { recipeId: id } }), prisma.contentRecipePageCategory.createMany({ data: next.map((categoryId) => ({ recipeId: id, categoryId })) }));
    if (key === "pageGroups") ops.push(prisma.contentRecipePageGroup.deleteMany({ where: { recipeId: id } }), prisma.contentRecipePageGroup.createMany({ data: next.map((groupId) => ({ recipeId: id, groupId })) }));
    if (key === "pages") ops.push(prisma.contentRecipePage.deleteMany({ where: { recipeId: id } }), prisma.contentRecipePage.createMany({ data: next.map((pageId) => ({ recipeId: id, pageId })) }));
  };
  replace("pageCategories", input.pageCategoryIds, row.pageCategories.map((c) => c.categoryId));
  replace("pageGroups", input.pageGroupIds, row.pageGroups.map((g) => g.groupId));
  replace("pages", input.pageIds, row.pages.map((p) => p.pageId));
  if (ops.length) {
    ops.push(prisma.contentRecipe.update({ where: { id }, data: { updatedById: actor.id, version: { increment: 1 } } }));
    await prisma.$transaction(ops);
    await audit(actor, "RECIPE_ASSIGNMENT_CHANGED", id, { lists: changed });
  }
  return getRecipe(actor, id);
}

export interface PreviewConfigInput {
  assetId: string | null;
  textId: string | null;
  pageId: string | null;
  groupId: string | null;
  adjustment?: RecipeAdjustment | undefined;
}

/** Remembers what was last chosen in the preview (media, text, page or group, unsaved adjustments) so the recipe reopens as it was left. */
export async function savePreviewConfig(actor: SafeUser, id: string, input: PreviewConfigInput) {
  requireAdmin(actor, "Saving a preview");
  await loadRecipe(actor, id);
  const org = actor.organizationId;
  const [asset, text, page, group] = await Promise.all([
    input.assetId ? prisma.mediaAsset.findFirst({ where: { id: input.assetId, organizationId: org }, select: { id: true } }) : null,
    input.textId ? prisma.textEntry.findFirst({ where: { id: input.textId, organizationId: org }, select: { id: true } }) : null,
    input.pageId ? prisma.managedPage.findFirst({ where: { id: input.pageId, organizationId: org }, select: { id: true } }) : null,
    input.groupId ? prisma.pageGroup.findFirst({ where: { id: input.groupId, organizationId: org }, select: { id: true } }) : null,
  ]);
  if (input.assetId && !asset) throw notFound("Media file");
  if (input.textId && !text) throw notFound("Text");
  if (input.pageId && !page) throw notFound("Page");
  if (input.groupId && !group) throw notFound("Page group");
  const adjustment = input.adjustment ? recipeAdjustmentSchema.parse(input.adjustment) : null;
  await prisma.contentRecipe.update({ where: { id }, data: { previewConfig: { assetId: input.assetId, textId: input.textId, pageId: input.pageId, groupId: input.groupId, adjustment } as Prisma.InputJsonValue } });
  await audit(actor, "RECIPE_PREVIEW_SAVED", id);
  return getRecipe(actor, id);
}

// ------------------------------------------------------------------------------------------------ effective settings + compatibility

export interface EffectiveInput {
  recipeId?: string | undefined;
  config?: unknown;
  requiredTextCategoryId?: string | null | undefined;
  formatId?: string | null | undefined;
  pageCategoryIds?: string[] | undefined;
  pageGroupIds?: string[] | undefined;
  pageIds?: string[] | undefined;
  pageId?: string | null | undefined;
  groupId?: string | null | undefined;
  assetId?: string | null | undefined;
  textId?: string | null | undefined;
  adjustment?: RecipeAdjustment | undefined;
  purpose: "PREVIEW" | "RENDER";
}

/**
 * The single answer the preview shows: the effective setting for every field and where each came from (a preview
 * adjustment, the recipe, the page, the page group, the page category, or the built-in default), the text layout,
 * and the compatibility checks for the chosen media, text and page or group. It reads and computes only: nothing is
 * stored, no text is recorded as used, and nothing is rendered.
 */
export async function evaluate(actor: SafeUser, input: EffectiveInput) {
  const org = actor.organizationId;
  let config: RecipeConfig;
  let scope: { pageIds: string[]; pageGroupIds: string[]; pageCategoryIds: string[] };
  let requiredTextCategoryId: string | null;
  let formatId: string | null;
  let recipeInfo: { id: string; name: string } | null = null;
  if (input.recipeId) {
    const row = await loadRecipe(actor, input.recipeId);
    config = input.config !== undefined ? validConfig(input.config) : configOf(row).config; // an unsaved edit of a stored recipe
    scope = { pageIds: input.pageIds ?? row.pages.map((p) => p.pageId), pageGroupIds: input.pageGroupIds ?? row.pageGroups.map((g) => g.groupId), pageCategoryIds: input.pageCategoryIds ?? row.pageCategories.map((c) => c.categoryId) };
    requiredTextCategoryId = input.requiredTextCategoryId !== undefined ? input.requiredTextCategoryId : row.requiredTextCategoryId;
    formatId = input.formatId !== undefined ? input.formatId : row.formatId;
    recipeInfo = { id: row.id, name: row.name };
  } else {
    config = validConfig(input.config);
    scope = { pageIds: input.pageIds ?? [], pageGroupIds: input.pageGroupIds ?? [], pageCategoryIds: input.pageCategoryIds ?? [] };
    requiredTextCategoryId = input.requiredTextCategoryId ?? null;
    formatId = input.formatId ?? null;
  }

  // the page / group whose editorial identity layers decide the inherited settings
  let identity: ResolvedIdentity | null = null;
  let target: CompatTarget | null = null;
  let targetInfo: { kind: "page" | "group"; id: string; name: string; groupName: string | null } | null = null;
  if (input.pageId) {
    const page = await prisma.managedPage.findFirst({ where: { id: input.pageId, organizationId: org }, include: PAGE_INCLUDE });
    if (!page) throw notFound("Page");
    let resolved: ReturnType<typeof resolveForPage>;
    try {
      resolved = resolveForPage(page, input.groupId ?? null);
    } catch (err) {
      throw err instanceof ApiHttpError ? err : bad("That page is not a member of the chosen group.");
    }
    identity = resolved.identity;
    target = { kind: "page", id: page.id, categoryId: page.categoryId, groupIds: page.groupMemberships.map((m) => m.group.id), language: identity.language, identity };
    targetInfo = { kind: "page", id: page.id, name: page.name, groupName: resolved.group?.name ?? null };
  } else if (input.groupId) {
    const group = await prisma.pageGroup.findFirst({ where: { id: input.groupId, organizationId: org }, include: { members: { include: { page: { select: { id: true, categoryId: true } } } } } });
    if (!group) throw notFound("Page group");
    identity = resolveEditorialIdentity({ group: groupLayer(group) });
    target = { kind: "group", id: group.id, memberPageIds: group.members.map((m) => m.page.id), memberCategoryIds: [...new Set(group.members.map((m) => m.page.categoryId).filter((c): c is string => Boolean(c)))], identity };
    targetInfo = { kind: "group", id: group.id, name: group.name, groupName: null };
  }

  const effective = resolveEffectiveRecipe({ config, adjustment: input.adjustment ?? null, identity });

  let assetOut: ReturnType<typeof assetDto> | null = null;
  let compatAsset: CompatAsset | null = null;
  if (input.assetId) {
    const asset = await prisma.mediaAsset.findFirst({ where: { id: input.assetId, organizationId: org }, include: ASSET_INCLUDE });
    if (!asset) throw notFound("Media file");
    assetOut = assetDto(asset);
    compatAsset = { kind: asset.kind, status: asset.status, rightsStatus: asset.rightsStatus, width: asset.width, height: asset.height, durationMs: asset.durationMs };
  }
  let textOut: { id: string; text: string; approvalStatus: string; language: string | null } | null = null;
  let compatText: CompatText | null = null;
  if (input.textId) {
    const text = await prisma.textEntry.findFirst({ where: { id: input.textId, organizationId: org }, include: TEXT_INCLUDE });
    if (!text) throw notFound("Text");
    textOut = { id: text.id, text: text.body, approvalStatus: text.approvalStatus, language: text.language };
    compatText = { body: text.body, language: text.language, approvalStatus: text.approvalStatus, rightsStatus: text.rightsStatus, categoryIds: text.categories.map((c) => c.categoryId), pageIds: text.pages.map((p) => p.pageId), pageGroupIds: text.pageGroups.map((g) => g.groupId), pageCategoryIds: text.pageCategories.map((c) => c.categoryId) };
  }

  const issues = checkRecipeCompatibility({ recipe: { ...scope, config, formatId, requiredTextCategoryId }, effective, asset: compatAsset, text: compatText, target, purpose: input.purpose });

  // the plan the renderer will follow, computed here from the same shared functions, so the preview and the render cannot differ
  const values = effective.values;
  const placeholder = !compatText;
  const planLanguage = compatText?.language ?? target?.identity?.language ?? null;
  const plan = planText({ text: compatText?.body ?? PLACEHOLDER_TEXT, language: planLanguage, values });
  if (compatText) {
    const problem = textRenderProblem(plan);
    if (problem) issues.push({ code: `RENDER_${problem.code}`, severity: "ERROR", field: "caption", message: `${problem.message} ${problem.remedy}` });
  }
  let output: { kind: "VIDEO" | "IMAGE"; durationMs: number } | null = null;
  if (compatAsset && (compatAsset.kind === "IMAGE" || compatAsset.kind === "VIDEO")) {
    const decision = decideOutput(values, { kind: compatAsset.kind, durationMs: compatAsset.durationMs });
    if (decision.ok) output = { kind: decision.outputKind, durationMs: decision.durationMs };
    else issues.push({ code: "RENDER_SOURCE_UNUSABLE", severity: "ERROR", field: "media", message: `${decision.message} ${decision.remedy}` });
  }
  const timelineMs = output?.durationMs ?? Math.round(values.durationSeconds * 1000);
  const timeline = buildTimeline(values, plan, timelineMs, { still: output?.kind === "IMAGE" });
  const subtitles = output?.kind === "IMAGE" ? { enabled: false, fontSizePx: 0, stepPx: 0, cues: [] } : planSubtitles({ text: compatText?.body ?? PLACEHOLDER_TEXT, language: planLanguage, values, plan, durationMs: timelineMs });
  return {
    recipe: recipeInfo,
    target: targetInfo,
    effective: { values: effective.values, sources: effective.sources, warnings: effective.warnings },
    layout: computeLayout(effective.values),
    plan,
    timeline,
    subtitles,
    output,
    placeholder,
    issues,
    blocking: hasBlockingIssue(issues),
    asset: assetOut,
    text: textOut,
    /** This is a preview of a composition, not a rendered file. */
    preview: true as const,
  };
}
