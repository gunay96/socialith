import { Router } from "express";
import { PLATFORM_CAPABILITIES, type ApiResponse } from "@socialith/types";
import { requireAuth } from "../middleware/auth.js";

/** GET /api/platform-capabilities — static, research-derived matrix (packages/types/src/platform-capabilities.ts); every authenticated role can view. */
export function createPlatformCapabilitiesRouter(): Router {
  const router = Router();
  router.get("/platform-capabilities", requireAuth, (_req, res) => {
    const body: ApiResponse<typeof PLATFORM_CAPABILITIES> = { success: true, data: PLATFORM_CAPABILITIES };
    res.status(200).json(body);
  });
  return router;
}
