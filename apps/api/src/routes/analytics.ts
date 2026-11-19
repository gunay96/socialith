import { Router } from "express";
import {
  getContentMetrics,
  getCampaignMetrics,
  getSoundMetrics,
  getAccountMetrics,
} from "../controllers/analytics.controller.js";
import { requireAuth } from "../middleware/auth.js";

/**
 * Mounted at "/api" in app.ts. Read-only rollups — every authenticated
 * role can view (same as GET /api/campaigns, GET /api/content, ...); the
 * actual metrics-fetching side effect (enqueuing a real sync job) lives
 * on the content/target routes instead (POST
 * /api/content/:id/targets/:socialAccountId/sync-analytics — EDITOR+),
 * not here, since this router never mutates anything.
 */
export function createAnalyticsRouter(): Router {
  const router = Router();

  router.get("/analytics/content/:id", requireAuth, getContentMetrics);
  router.get("/analytics/campaigns/:id", requireAuth, getCampaignMetrics);
  router.get("/analytics/sounds/:id", requireAuth, getSoundMetrics);
  router.get("/analytics/accounts/:id", requireAuth, getAccountMetrics);

  return router;
}
