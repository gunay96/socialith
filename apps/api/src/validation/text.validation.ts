import { z } from "zod";
import { LANGUAGE_PATTERN, TEXT_MAX_LENGTH } from "@socialith/studio";

const id = z.string().trim().min(1).max(64);
const ids = (max = 200) => z.array(id).max(max);
const page = z.coerce.number().int().min(1).default(1);
const bool = z.enum(["true", "false"]).transform((v) => v === "true");
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v === "" || v === undefined ? null : v));
const language = z
  .string()
  .trim()
  .toLowerCase()
  .regex(LANGUAGE_PATTERN, "use a language code such as tr or en")
  .max(16);
const nullableLanguage = z
  .union([language, z.literal(""), z.null()])
  .optional()
  .transform((v) => (v === "" || v === undefined ? null : v));

const rights = z.enum(["UNVERIFIED", "CONFIRMED", "RESTRICTED"]);

// ---------------------------------------------------------------------------------------------------- categories
export const categoryCreateSchema = z.object({ name: z.string().trim().min(1).max(80), description: optionalText(500) });
export const categoryUpdateSchema = z.object({ name: z.string().trim().min(1).max(80).optional(), description: optionalText(500) });
export const listCategoriesQuerySchema = z.object({ status: z.enum(["ACTIVE", "ARCHIVED", "ALL"]).default("ACTIVE") });

// ---------------------------------------------------------------------------------------------------- texts
export const listTextsQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  status: z.enum(["ACTIVE", "PENDING", "APPROVED", "REJECTED", "ARCHIVED", "ALL"]).default("ACTIVE"),
  categoryId: id.optional(),
  uncategorized: bool.optional(),
  language: z.string().trim().max(16).optional(),
  source: z.enum(["MANUAL", "TXT", "CSV", "XLSX"]).optional(),
  campaignId: id.optional(),
  pageCategoryId: id.optional(),
  pageId: id.optional(),
  pageGroupId: id.optional(),
  /** Texts that may be used for this page: those limited to it (or its groups or its category) and those limited to nothing. */
  forPageId: id.optional(),
  collectionId: id.optional(),
  batchId: id.optional(),
  rights: rights.optional(),
  used: bool.optional(),
  sort: z.enum(["newest", "oldest", "text", "mostUsed"]).default("newest"),
  page,
  pageSize: z.coerce.number().int().min(1).max(100).default(30),
});

export const textCreateSchema = z.object({
  text: z.string().max(TEXT_MAX_LENGTH * 4),
  language: nullableLanguage,
  author: optionalText(255),
  sourceNote: optionalText(255),
  notes: optionalText(4000),
  categoryIds: ids(20).default([]),
  campaignIds: ids(50).default([]),
  pageCategoryIds: ids(50).default([]),
  pageGroupIds: ids(50).default([]),
  pageIds: ids(100).default([]),
  /** Administrators only: approve the text as it is created. */
  approveNow: z.boolean().default(false),
});

export const textUpdateSchema = z
  .object({
    text: z.string().max(TEXT_MAX_LENGTH * 4).optional(),
    language: nullableLanguage,
    author: optionalText(255),
    sourceNote: optionalText(255),
    notes: optionalText(4000),
  })
  .refine((v) => Object.keys(v).length > 0, "nothing to change");

export const categoryIdsSchema = z.object({ categoryIds: ids(20) });
export const campaignIdsSchema = z.object({ campaignIds: ids(50) });
export const pageCategoryIdsSchema = z.object({ pageCategoryIds: ids(50) });
export const pageGroupIdsSchema = z.object({ pageGroupIds: ids(50) });
export const pageIdsSchema = z.object({ pageIds: ids(100) });
export const reviewSchema = z.object({ note: optionalText(1000) });
export const rejectSchema = z.object({ note: z.string().trim().min(1, "say why the text was rejected").max(1000) });
export const rightsSchema = z.object({ status: rights, notes: optionalText(2000) });

const mode = z.enum(["add", "remove", "set"]);
export const bulkSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("categories"), ids: ids().min(1), mode, categoryIds: ids(20) }),
  z.object({ action: z.literal("campaigns"), ids: ids().min(1), mode, campaignIds: ids(50) }),
  z.object({ action: z.literal("pageCategories"), ids: ids().min(1), mode, pageCategoryIds: ids(50) }),
  z.object({ action: z.literal("pageGroups"), ids: ids().min(1), mode, pageGroupIds: ids(50) }),
  z.object({ action: z.literal("pages"), ids: ids().min(1), mode, pageIds: ids(100) }),
  z.object({ action: z.literal("language"), ids: ids().min(1), language: nullableLanguage }),
  z.object({ action: z.literal("approve"), ids: ids().min(1), note: optionalText(1000) }),
  z.object({ action: z.literal("reject"), ids: ids().min(1), note: z.string().trim().min(1).max(1000) }),
  z.object({ action: z.literal("archive"), ids: ids().min(1) }),
  z.object({ action: z.literal("restore"), ids: ids().min(1) }),
  z.object({ action: z.literal("rights"), ids: ids().min(1), status: rights, notes: optionalText(2000) }),
  z.object({ action: z.literal("collection"), ids: ids().min(1), mode: z.enum(["add", "remove"]), collectionId: id }),
]);

export const usageSchema = z
  .object({
    kind: z.enum(["MANUAL", "PUBLICATION"]).default("MANUAL"),
    note: optionalText(500),
    pageId: id.optional(),
    campaignId: id.optional(),
    recipeId: id.optional(),
    mediaAssetId: id.optional(),
    contentId: id.optional(),
    usedAt: z.coerce.date().optional(),
  })
  .refine((v) => v.kind !== "PUBLICATION" || Boolean(v.contentId), "a publication usage needs the content it belongs to");
export const listUsagesQuerySchema = z.object({ page, pageSize: z.coerce.number().int().min(1).max(100).default(30) });

// ---------------------------------------------------------------------------------------------------- collections
export const collectionCreateSchema = z.object({ name: z.string().trim().min(1).max(120), description: optionalText(1000) });
export const collectionUpdateSchema = z.object({ name: z.string().trim().min(1).max(120).optional(), description: optionalText(1000) });
export const listCollectionsQuerySchema = z.object({ status: z.enum(["ACTIVE", "ARCHIVED", "ALL"]).default("ACTIVE") });
export const collectionTextsSchema = z.object({ textIds: ids().min(1) });

// ---------------------------------------------------------------------------------------------------- import
export const importOptionsSchema = z.object({
  /** Check the file and report what would happen, change nothing. */
  dryRun: z.boolean().default(true),
  language: nullableLanguage,
  sourceNote: optionalText(255),
  /** Applied to every row that has no category of its own in the file. */
  categoryIds: ids(20).default([]),
  campaignIds: ids(50).default([]),
  pageCategoryIds: ids(50).default([]),
  pageGroupIds: ids(50).default([]),
  pageIds: ids(100).default([]),
  /** Administrators only: create the categories named in the file that do not exist yet. */
  createMissingCategories: z.boolean().default(false),
  split: z.enum(["auto", "LINE", "BLANK_LINE"]).default("auto"),
  textColumn: z.union([z.string().trim().min(1).max(80), z.number().int().min(0).max(255)]).optional(),
  hasHeader: z.union([z.boolean(), z.literal("auto")]).default("auto"),
  delimiter: z.enum([",", ";", "\t", "|"]).optional(),
  sheet: z.string().trim().min(1).max(80).optional(),
});
export type ImportOptions = z.infer<typeof importOptionsSchema>;
