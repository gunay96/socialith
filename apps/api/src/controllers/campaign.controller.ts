import type { NextFunction, Request, Response } from "express";
import { ERROR_CODES, type ApiResponse } from "@socialith/types";
import { ApiHttpError } from "../middleware/error-handler.js";
import { listCampaignsQuerySchema, createCampaignSchema, updateCampaignSchema } from "../validation/campaign.validation.js";
import * as campaignService from "../services/campaign.service.js";
import type { Campaign, ListCampaignsResult } from "../repositories/campaign.repository.js";

/** GET /api/campaigns — every authenticated role can view. */
export async function listCampaigns(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = listCampaignsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ApiHttpError(400, ERROR_CODES.INVALID_REQUEST, "Invalid search/filter/pagination parameters.");
    }
    const result = await campaignService.getCampaigns(req.user!, parsed.data);
    const body: ApiResponse<ListCampaignsResult & { page: number; pageSize: number }> = {
      success: true,
      data: { ...result, page: parsed.data.page, pageSize: parsed.data.pageSize },
    };
    res.status(200).json(body);
  } catch (err) {
    next(err);
  }
}

/** POST /api/campaigns — requireMinimumRole("EDITOR") already ran (routes/campaign.ts). */
export async function createCampaign(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = createCampaignSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiHttpError(400, ERROR_CODES.INVALID_REQUEST, parsed.error.issues[0]?.message ?? "Invalid campaign.");
    }
    const campaign = await campaignService.createCampaign(req.user!, parsed.data);
    const body: ApiResponse<Campaign> = { success: true, data: campaign };
    res.status(201).json(body);
  } catch (err) {
    next(err);
  }
}

/** GET /api/campaigns/:id — org-scoped; a cross-organization id resolves as 404. */
export async function getCampaign(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const campaign = await campaignService.getCampaignDetail(req.user!, req.params.id!);
    const body: ApiResponse<Campaign> = { success: true, data: campaign };
    res.status(200).json(body);
  } catch (err) {
    next(err);
  }
}

/** PATCH /api/campaigns/:id — requireMinimumRole("EDITOR") already ran. */
export async function updateCampaign(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = updateCampaignSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiHttpError(400, ERROR_CODES.INVALID_REQUEST, "Invalid campaign update.");
    }
    const campaign = await campaignService.updateCampaign(req.user!, req.params.id!, parsed.data);
    const body: ApiResponse<Campaign> = { success: true, data: campaign };
    res.status(200).json(body);
  } catch (err) {
    next(err);
  }
}
