import { Router } from "express";
import { listCampaigns, createCampaign, getCampaign, updateCampaign } from "../controllers/campaign.controller.js";
import { requireAuth } from "../middleware/auth.js";
import { requireMinimumRole } from "../middleware/rbac.js";

/**
 * Mounted at "/api" in app.ts. Reads are open to every authenticated
 * role (VIEWER included, same as GET /api/team and GET /api/accounts);
 * writes require EDITOR+ — VIEWER can never create/modify a campaign,
 * matching the spec's explicit RBAC requirement for this phase.
 */
export function createCampaignRouter(): Router {
  const router = Router();

  router.get("/campaigns", requireAuth, listCampaigns);
  router.post("/campaigns", requireAuth, requireMinimumRole("EDITOR"), createCampaign);
  router.get("/campaigns/:id", requireAuth, getCampaign);
  router.patch("/campaigns/:id", requireAuth, requireMinimumRole("EDITOR"), updateCampaign);

  return router;
}
