import { Router } from "express";
import {
  listTeam,
  inviteMember,
  changeRole,
  disableMember,
  enableMember,
  removeMember,
  previewInvitation,
  acceptInvitation,
} from "../controllers/team.controller.js";
import { requireAuth } from "../middleware/auth.js";
import { requireMinimumRole } from "../middleware/rbac.js";

/**
 * Mounted at "/api" in app.ts, so these resolve to exactly the paths
 * the spec calls for (GET /api/team, POST /api/team/invitations, etc).
 *
 * GET/POST /api/team/invitations/:token are deliberately NOT behind
 * requireAuth — the invitee doesn't have a session yet. The token
 * itself, delivered only via the invitation email, is the credential;
 * see services/invitation.service.ts for how it's validated.
 */
export function createTeamRouter(): Router {
  const router = Router();

  router.get("/team", requireAuth, listTeam);
  router.post("/team/invitations", requireAuth, requireMinimumRole("ADMIN"), inviteMember);
  router.get("/team/invitations/:token", previewInvitation);
  router.post("/team/invitations/:token", acceptInvitation);
  router.patch("/team/:userId/role", requireAuth, requireMinimumRole("ADMIN"), changeRole);
  router.post("/team/:userId/disable", requireAuth, requireMinimumRole("ADMIN"), disableMember);
  router.post("/team/:userId/enable", requireAuth, requireMinimumRole("ADMIN"), enableMember);
  router.delete("/team/:userId", requireAuth, requireMinimumRole("ADMIN"), removeMember);

  return router;
}
