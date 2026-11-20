import { z } from "zod";
import { recipeAdjustmentSchema } from "@socialith/studio";

const id = z.string().trim().min(1).max(64);

/** What to render: a source file, an approved text, and where it is for (a page or a page group); the recipe is chosen for that page unless named. */
export const renderRequestSchema = z.object({
  assetId: id,
  textId: id,
  recipeId: id.optional(),
  pageId: id.optional(),
  groupId: id.optional(),
  campaignId: id.optional(),
  adjustment: recipeAdjustmentSchema.optional(),
  /** Render again on purpose although the same render already exists and succeeded. */
  force: z.boolean().optional(),
});

export const renderResolveSchema = renderRequestSchema.omit({ force: true, campaignId: true });

export const listRendersQuerySchema = z.object({
  state: z.enum(["active", "finished", "all"]).default("all"),
  status: z.enum(["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"]).optional(),
  pageId: id.optional(),
  sourceAssetId: id.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(30),
});
