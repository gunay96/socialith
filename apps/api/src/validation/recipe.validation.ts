import { z } from "zod";
import { EDITORIAL_FORMAT_IDS } from "@socialith/publishing";
import { RECIPE_NAME_MAX, recipeAdjustmentSchema } from "@socialith/studio";

const id = z.string().trim().min(1).max(64);
const ids = (max = 100) => z.array(id).max(max);
const bool = z.enum(["true", "false"]).transform((v) => v === "true");
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v === "" || v === undefined ? null : v));
const name = z.string().trim().min(1).max(RECIPE_NAME_MAX);
const formatId = z
  .string()
  .nullable()
  .refine((v) => v === null || EDITORIAL_FORMAT_IDS.includes(v), "unknown format");

/** The recipe configuration is validated by the shared schema in @socialith/studio (the same one the preview uses). */
const config = z.unknown();

export const listRecipesQuerySchema = z.object({
  status: z.enum(["ACTIVE", "ARCHIVED", "ALL"]).default("ACTIVE"),
  q: z.string().trim().max(120).optional(),
  mediaKind: z.enum(["IMAGE", "VIDEO"]).optional(),
  pageCategoryId: id.optional(),
  pageGroupId: id.optional(),
  pageId: id.optional(),
  textCategoryId: id.optional(),
  /** The recipes that suit this page, most specific first (page, then group, then category, then everyone). */
  forPageId: id.optional(),
  /** Narrows `forPageId` to recipes that accept this kind of media. */
  forMedia: z.enum(["IMAGE", "VIDEO"]).optional(),
  presetKey: z.string().trim().max(64).optional(),
  installed: bool.optional(),
});

export const recipeCreateSchema = z.object({
  name,
  description: optionalText(2000),
  formatId: formatId.default(null),
  config,
  requiredTextCategoryId: id.nullable().default(null),
  pageCategoryIds: ids().default([]),
  pageGroupIds: ids().default([]),
  pageIds: ids().default([]),
});

export const recipeUpdateSchema = z
  .object({
    name: name.optional(),
    description: optionalText(2000),
    formatId: formatId.optional(),
    config: config.optional(),
    requiredTextCategoryId: id.nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "nothing to change");

export const fromPresetSchema = z.object({ presetKey: z.string().trim().min(1).max(64), name: name.optional() });
export const duplicateSchema = z.object({ name: name.optional() });
export const assignmentsSchema = z
  .object({ pageCategoryIds: ids().optional(), pageGroupIds: ids().optional(), pageIds: ids().optional() })
  .refine((v) => v.pageCategoryIds !== undefined || v.pageGroupIds !== undefined || v.pageIds !== undefined, "provide at least one list");

export const previewConfigSchema = z.object({
  assetId: id.nullable().default(null),
  textId: id.nullable().default(null),
  pageId: id.nullable().default(null),
  groupId: id.nullable().default(null),
  adjustment: recipeAdjustmentSchema.optional(),
});

/** Resolve the effective settings (and check compatibility) for a stored recipe or an unsaved configuration. */
export const effectiveSchema = z
  .object({
    recipeId: id.optional(),
    config: config.optional(),
    requiredTextCategoryId: id.nullable().optional(),
    formatId: formatId.optional(),
    pageCategoryIds: ids().optional(),
    pageGroupIds: ids().optional(),
    pageIds: ids().optional(),
    pageId: id.nullable().optional(),
    groupId: id.nullable().optional(),
    assetId: id.nullable().optional(),
    textId: id.nullable().optional(),
    adjustment: recipeAdjustmentSchema.optional(),
    purpose: z.enum(["PREVIEW", "RENDER"]).default("PREVIEW"),
  })
  .refine((v) => Boolean(v.recipeId) || v.config !== undefined, "send a recipeId or a config");
