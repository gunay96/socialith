import { Router } from "express";
import type { ApiResponse } from "@socialith/types";
import { requireAuth } from "../middleware/auth.js";
import { getDashboard } from "../services/dashboard.service.js";

/** GET /api/dashboard — every authenticated role can view (read-only, same as every other overview/list endpoint). */
export function createDashboardRouter(): Router {
  const router = Router();
  router.get("/dashboard", requireAuth, async (req, res, next) => {
    try {
      const data = await getDashboard(req.user!);
      const body: ApiResponse<typeof data> = { success: true, data };
      res.status(200).json(body);
    } catch (err) {
      next(err);
    }
  });
  return router;
}
