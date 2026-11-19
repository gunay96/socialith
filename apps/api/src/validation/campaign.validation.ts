import { z } from "zod";

export const campaignStatusSchema = z.enum(["DRAFT", "ACTIVE", "COMPLETED"]);

export const listCampaignsQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  status: campaignStatusSchema.optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(25),
});
export type ListCampaignsQuery = z.infer<typeof listCampaignsQuerySchema>;

export const createCampaignSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(200),
  description: z.string().trim().max(2000).optional(),
  status: campaignStatusSchema.optional(),
  startAt: z.coerce.date().optional(),
  endAt: z.coerce.date().optional(),
});
export type CreateCampaignInput = z.infer<typeof createCampaignSchema>;

export const updateCampaignSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  status: campaignStatusSchema.optional(),
  startAt: z.coerce.date().nullable().optional(),
  endAt: z.coerce.date().nullable().optional(),
});
export type UpdateCampaignInput = z.infer<typeof updateCampaignSchema>;
