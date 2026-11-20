import { z } from "zod";
import { ASPECT_RATIOS, EDITORIAL_FORMAT_IDS, RULE_ENFORCEMENTS, TEXT_POSITIONS } from "@socialith/publishing";

const id = z.string().trim().min(1).max(64);
const page = z.coerce.number().int().min(1).default(1);
const pageSize = z.coerce.number().int().min(1).max(100).default(25);

/** "" means "nothing" - stored as null so a cleared field never becomes an empty string. */
const nullableText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v === "" ? null : v));

const slug = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(60)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "slug may only contain lowercase letters, digits and single hyphens");

const name = z.string().trim().min(1).max(120);
const language = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/, "language must be a language code such as tr or en");

const list = (maxItems: number, maxLength: number) => z.array(z.string().trim().min(1).max(maxLength)).max(maxItems);
const hexColor = z.string().trim().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "colors must be hex values such as #ff6a00");

/** Only http(s): a stored `javascript:` URL must never become a link in the dashboard. */
const httpUrl = z
  .string()
  .trim()
  .max(2000)
  .url()
  .refine((v) => /^https?:\/\//i.test(v), "the URL must start with http:// or https://");

/** The structured part of an editorial profile (category defaults, group preferences, page overrides). */
export const editorialProfileSchema = z
  .object({
    contentPreferences: z
      .object({
        formats: z.array(z.string().refine((v) => EDITORIAL_FORMAT_IDS.includes(v), "unknown editorial format")).max(20).optional(),
        topics: list(30, 80).optional(),
        avoidTopics: list(30, 80).optional(),
        avoidTerms: list(50, 60).optional(),
        maxTextLength: z.number().int().min(1).max(10_000).nullable().optional(),
        requiresVerifiedFacts: z.boolean().optional(),
      })
      .strict()
      .optional(),
    visual: z
      .object({
        style: nullableText(300),
        fonts: list(10, 60).optional(),
        colors: z.array(hexColor).max(12).optional(),
        textPosition: z.enum(TEXT_POSITIONS).nullable().optional(),
        aspectRatio: z.enum(ASPECT_RATIOS).nullable().optional(),
      })
      .strict()
      .optional(),
    guidelines: nullableText(4000),
    originality: z
      .object({
        similarityThresholdPct: z.number().int().min(1).max(100).nullable().optional(),
        lookbackPosts: z.number().int().min(0).max(200).nullable().optional(),
      })
      .strict()
      .optional(),
    ruleEnforcement: z.enum(RULE_ENFORCEMENTS).nullable().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------------------------- categories

export const listCategoriesQuerySchema = z.object({ status: z.enum(["ACTIVE", "ARCHIVED", "ALL"]).default("ACTIVE") });

export const categoryCreateSchema = z.object({
  name,
  slug: slug.optional(),
  description: nullableText(2000),
  language: language.optional(),
  defaultEditorialStyle: nullableText(2000),
  contentPreferences: editorialProfileSchema.nullable().optional(),
});
export const categoryUpdateSchema = z.object({
  name: name.optional(),
  description: nullableText(2000),
  language: language.optional(),
  defaultEditorialStyle: nullableText(2000),
  contentPreferences: editorialProfileSchema.nullable().optional(),
});
export const starterCategoriesSchema = z.object({ language: language.optional() });

// ---------------------------------------------------------------------------------------------- pages

export const listPagesQuerySchema = z.object({
  page,
  pageSize,
  search: z.string().trim().max(100).optional(),
  status: z.enum(["ACTIVE", "ARCHIVED", "ALL"]).default("ACTIVE"),
  platform: z.enum(["TIKTOK", "INSTAGRAM", "YOUTUBE"]).optional(),
  categoryId: id.optional(),
  /** "none" = pages without a category */
  category: z.literal("none").optional(),
  groupId: id.optional(),
  campaignId: id.optional(),
  /** LINKED = has a destination, UNLINKED = has none, PROBLEM = has one that cannot publish right now */
  mapping: z.enum(["LINKED", "UNLINKED", "PROBLEM"]).optional(),
});

export const pageCreateSchema = z.object({
  name,
  slug: slug.optional(),
  platform: z.enum(["TIKTOK", "INSTAGRAM", "YOUTUBE"]),
  username: z.string().trim().min(1).max(100),
  profileUrl: httpUrl.nullable().optional(),
  categoryId: id.nullable().optional(),
  description: nullableText(2000),
  targetAudience: nullableText(1000),
  language: language.nullable().optional(),
  editorialIdentity: nullableText(2000),
  profile: editorialProfileSchema.nullable().optional(),
  internalNotes: nullableText(4000),
  /** Link an existing Publishing Destination straight away (optional; can also be done later). */
  socialAccountId: id.nullable().optional(),
});
export const pageUpdateSchema = z.object({
  name: name.optional(),
  platform: z.enum(["TIKTOK", "INSTAGRAM", "YOUTUBE"]).optional(),
  username: z.string().trim().min(1).max(100).optional(),
  profileUrl: httpUrl.nullable().optional(),
  categoryId: id.nullable().optional(),
  description: nullableText(2000),
  targetAudience: nullableText(1000),
  language: language.nullable().optional(),
  internalNotes: nullableText(4000),
});
/** Replaces the page's own editorial overrides; anything left out (or null) inherits from the category. */
export const identityUpdateSchema = z.object({
  editorialIdentity: nullableText(2000),
  profile: editorialProfileSchema.nullable().optional(),
});
export const identityQuerySchema = z.object({ groupId: id.optional() });
export const destinationLinkSchema = z.object({ socialAccountId: id.nullable() });
export const checkTextSchema = z.object({ text: z.string().max(20_000), groupId: id.optional() });

// ---------------------------------------------------------------------------------------------- groups

export const listGroupsQuerySchema = z.object({
  status: z.enum(["ACTIVE", "ARCHIVED", "ALL"]).default("ACTIVE"),
  categoryId: id.optional(),
  platform: z.enum(["TIKTOK", "INSTAGRAM", "YOUTUBE"]).optional(),
});
export const groupCreateSchema = z.object({
  name,
  slug: slug.optional(),
  description: nullableText(2000),
  contentPreferences: editorialProfileSchema.nullable().optional(),
  pageIds: z.array(id).max(500).optional(),
});
export const groupUpdateSchema = z.object({
  name: name.optional(),
  description: nullableText(2000),
  contentPreferences: editorialProfileSchema.nullable().optional(),
});
export const groupMembersSchema = z.object({ pageIds: z.array(id).min(1).max(500) });

// ---------------------------------------------------------------------------------------------- campaigns

export const campaignAssignSchema = z
  .object({ pageIds: z.array(id).max(500).optional(), groupIds: z.array(id).max(100).optional() })
  .refine((v) => (v.pageIds?.length ?? 0) + (v.groupIds?.length ?? 0) > 0, "provide at least one page or group");
export const campaignContentQuerySchema = z.object({ page, pageSize, categoryId: id.optional(), pageId: id.optional() });

// ---------------------------------------------------------------------------------------------- mapping

export const mappingQuerySchema = z.object({
  state: z.enum(["NO_DESTINATION", "READY", "REAUTH_REQUIRED", "DISCONNECTED", "UNAVAILABLE"]).optional(),
  platform: z.enum(["TIKTOK", "INSTAGRAM", "YOUTUBE"]).optional(),
  status: z.enum(["ACTIVE", "ARCHIVED", "ALL"]).default("ACTIVE"),
});
