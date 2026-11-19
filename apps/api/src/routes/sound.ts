import { Router } from "express";
import { listSounds, createSound, getSound, updateSound, archiveSound } from "../controllers/sound.controller.js";
import { requireAuth } from "../middleware/auth.js";
import { requireMinimumRole } from "../middleware/rbac.js";

/**
 * Mounted at "/api" in app.ts. Same read-open/write-gated split as
 * routes/campaign.ts — reads: any authenticated role; writes: EDITOR+.
 * No hard DELETE — see sound.service.ts's archiveSound for why.
 */
export function createSoundRouter(): Router {
  const router = Router();

  router.get("/sounds", requireAuth, listSounds);
  router.post("/sounds", requireAuth, requireMinimumRole("EDITOR"), createSound);
  router.get("/sounds/:id", requireAuth, getSound);
  router.patch("/sounds/:id", requireAuth, requireMinimumRole("EDITOR"), updateSound);
  router.post("/sounds/:id/archive", requireAuth, requireMinimumRole("EDITOR"), archiveSound);

  return router;
}
