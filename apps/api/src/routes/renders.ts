import { Router } from "express";
import * as c from "../controllers/render.controller.js";
import { requireAuth } from "../middleware/auth.js";
import { requireMinimumRole } from "../middleware/rbac.js";

/**
 * Rendering. Mounted at "/api". Every role can see renders and run the pre-render check (it queues nothing); starting,
 * cancelling and retrying a render needs EDITOR. A render only ever produces a new file in the media library: it never
 * publishes, schedules or approves anything.
 */
export function createRendersRouter(): Router {
  const r = Router();
  const read = [requireAuth];
  const editor = [requireAuth, requireMinimumRole("EDITOR")];

  r.get("/renders", ...read, c.list);
  r.post("/renders/resolve", ...read, c.resolve);
  r.post("/renders", ...editor, c.create);
  r.get("/renders/:id", ...read, c.get);
  r.post("/renders/:id/cancel", ...editor, c.cancel);
  r.post("/renders/:id/retry", ...editor, c.retry);

  return r;
}
