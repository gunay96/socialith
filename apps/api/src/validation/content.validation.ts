import { z } from "zod";
import { platformSchema } from "./social-account.validation.js";

export const contentStatusSchema = z.enum([
  "DRAFT",
  "GENERATED",
  "READY",
  "SCHEDULED",
  "PUBLISHING",
  "PUBLISHED",
  "FAILED",
]);

export const assetTypeSchema = z.enum(["IMAGE", "VIDEO", "AUDIO", "THUMBNAIL"]);

export const listContentQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  status: contentStatusSchema.optional(),
  campaignId: z.string().trim().min(1).optional(),
  soundId: z.string().trim().min(1).optional(),
  platform: platformSchema.optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(25),
});
export type ListContentQuery = z.infer<typeof listContentQuerySchema>;

export const createContentSchema = z.object({
  caption: z.string().trim().max(5000).optional(),
  campaignId: z.string().trim().min(1).optional(),
  soundId: z.string().trim().min(1).optional(),
});
export type CreateContentInput = z.infer<typeof createContentSchema>;

export const updateContentSchema = z.object({
  caption: z.string().trim().max(5000).nullable().optional(),
  campaignId: z.string().trim().min(1).nullable().optional(),
  soundId: z.string().trim().min(1).nullable().optional(),
  status: contentStatusSchema.optional(),
});
export type UpdateContentInput = z.infer<typeof updateContentSchema>;

export const upsertContentVariationSchema = z.object({
  title: z.string().trim().max(200).nullable().optional(),
  caption: z.string().trim().max(5000).nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type UpsertContentVariationInput = z.infer<typeof upsertContentVariationSchema>;

export const createContentAssetSchema = z.object({
  type: assetTypeSchema,
  platform: platformSchema.optional(),
  url: z.string().trim().url().max(2000),
  metadata: z.record(z.unknown()).optional(),
});
export type CreateContentAssetInput = z.infer<typeof createContentAssetSchema>;

/**
 * Capped at 1000 — matches the product's own "1000+ accounts" scale
 * exactly: one request can target the realistic maximum in a single
 * organization, never 1000 separate requests (see
 * repositories/content-target.repository.ts's assignContentTargets).
 */
const socialAccountIdsSchema = z.array(z.string().trim().min(1)).min(1).max(1000);

export const assignContentTargetsSchema = z.object({
  socialAccountIds: socialAccountIdsSchema,
});
export type AssignContentTargetsInput = z.infer<typeof assignContentTargetsSchema>;

export const removeContentTargetsSchema = z.object({
  socialAccountIds: socialAccountIdsSchema,
});
export type RemoveContentTargetsInput = z.infer<typeof removeContentTargetsSchema>;

export const scheduleContentSchema = z.object({
  scheduledAt: z.coerce.date().refine((d) => d.getTime() > Date.now(), "scheduledAt must be in the future"),
});
export type ScheduleContentInput = z.infer<typeof scheduleContentSchema>;

export const listContentTargetsQuerySchema = z.object({
  status: z.enum(["PENDING", "SCHEDULED", "PUBLISHING", "PUBLISHED", "FAILED"]).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(200).default(50),
});
export type ListContentTargetsQuery = z.infer<typeof listContentTargetsQuerySchema>;

// ── Phase 07: content generation + video render ───────────────────────
export const requestGenerationSchema = z.object({
  platform: platformSchema.nullable().optional(),
});
export type RequestGenerationInput = z.infer<typeof requestGenerationSchema>;

export const videoRenderOperationSchema = z.enum(["THUMBNAIL"]);

export const requestRenderSchema = z.object({
  sourceAssetId: z.string().trim().min(1),
  operation: videoRenderOperationSchema,
});
export type RequestRenderInput = z.infer<typeof requestRenderSchema>;
