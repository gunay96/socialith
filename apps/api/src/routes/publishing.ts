import { Router } from "express";
import * as c from "../controllers/publishing.controller.js";
import { requireAuth } from "../middleware/auth.js";
import { requireMinimumRole } from "../middleware/rbac.js";

/**
 * Publishing Center. Mounted at "/api". Reading is open to every authenticated role (like /content);
 * preparing, scheduling and operating publications needs EDITOR; approving or rejecting a publication and changing the
 * publishing settings need ADMIN. There is deliberately NO bulk-approve endpoint: every destination is approved on
 * its own, one request each.
 */
export function createPublishingRouter(): Router {
  const r = Router();
  const read = [requireAuth];
  const editor = [requireAuth, requireMinimumRole("EDITOR")];
  const admin = [requireAuth, requireMinimumRole("ADMIN")];

  r.get("/publishing/overview", ...read, c.getOverview);
  r.get("/publishing/calendar", ...read, c.getCalendar);
  r.get("/publishing/destinations", ...read, c.listDestinations);
  r.get("/publishing/settings", ...read, c.getSettings);
  r.put("/publishing/settings", ...admin, c.updateSettings);

  r.get("/publishing/publications", ...read, c.listPublications);
  r.post("/publishing/publications", ...editor, c.createPublications);
  r.get("/publishing/publications/:id", ...read, c.getPublication);
  r.patch("/publishing/publications/:id", ...editor, c.updatePublication);

  r.post("/publishing/publications/:id/validate", ...editor, c.validatePublication);
  r.post("/publishing/publications/:id/submit", ...editor, c.submitPublication);
  r.post("/publishing/publications/:id/withdraw", ...editor, c.withdrawPublication);
  r.post("/publishing/publications/:id/approve", ...admin, c.approvePublication);
  r.post("/publishing/publications/:id/reject", ...admin, c.rejectPublication);
  r.post("/publishing/publications/:id/schedule", ...editor, c.schedulePublication);
  r.post("/publishing/publications/:id/unschedule", ...editor, c.unschedulePublication);
  r.post("/publishing/publications/:id/hold", ...editor, c.holdPublication);
  r.post("/publishing/publications/:id/release", ...editor, c.releasePublication);
  r.post("/publishing/publications/:id/cancel", ...editor, c.cancelPublication);
  r.post("/publishing/publications/:id/reopen", ...editor, c.reopenPublication);
  r.post("/publishing/publications/:id/retry", ...editor, c.retryPublication);

  return r;
}
