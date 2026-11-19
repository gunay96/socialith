import { Router } from "express";
import { listAccounts, getAccount, disconnectAccount } from "../controllers/social-account.controller.js";
import { requireAuth } from "../middleware/auth.js";
import { requireMinimumRole } from "../middleware/rbac.js";

/**
 * Mounted at "/api" in app.ts. Every route requires an authenticated
 * session (there is no public endpoint here, unlike invitations/password
 * reset — connected accounts are never accessed pre-authentication).
 */
export function createSocialAccountRouter(): Router {
  const router = Router();

  router.get("/accounts", requireAuth, listAccounts);
  router.get("/accounts/:id", requireAuth, getAccount);
  router.post("/accounts/:id/disconnect", requireAuth, requireMinimumRole("ADMIN"), disconnectAccount);

  return router;
}
