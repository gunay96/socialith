import type { NextFunction, Request, Response } from "express";
import type { ApiResponse } from "@socialith/types";
import * as analyticsService from "../services/analytics.service.js";
import type { MetricsRollup } from "../repositories/analytics.repository.js";

function respondWithRollup(getter: (req: Request) => Promise<MetricsRollup>) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const rollup = await getter(req);
      const body: ApiResponse<MetricsRollup> = { success: true, data: rollup };
      res.status(200).json(body);
    } catch (err) {
      next(err);
    }
  };
}

/** GET /api/analytics/content/:id */
export const getContentMetrics = respondWithRollup((req) => analyticsService.getContentMetrics(req.user!, req.params.id!));

/** GET /api/analytics/campaigns/:id */
export const getCampaignMetrics = respondWithRollup((req) => analyticsService.getCampaignMetrics(req.user!, req.params.id!));

/** GET /api/analytics/sounds/:id */
export const getSoundMetrics = respondWithRollup((req) => analyticsService.getSoundMetrics(req.user!, req.params.id!));

/** GET /api/analytics/accounts/:id */
export const getAccountMetrics = respondWithRollup((req) => analyticsService.getAccountMetrics(req.user!, req.params.id!));
