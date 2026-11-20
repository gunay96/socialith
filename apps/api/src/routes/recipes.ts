import { Router } from "express";
import * as c from "../controllers/recipe.controller.js";
import { requireAuth } from "../middleware/auth.js";
import { requireMinimumRole } from "../middleware/rbac.js";

/**
 * Content recipes. Mounted at "/api". Every role can read recipes and run the preview calculation (it stores
 * nothing); creating, editing, duplicating, assigning and archiving recipes needs ADMIN.
 */
export function createRecipesRouter(): Router {
  const r = Router();
  const read = [requireAuth];
  const admin = [requireAuth, requireMinimumRole("ADMIN")];

  r.get("/recipes", ...read, c.list);
  r.get("/recipes/presets", ...read, c.presets);
  r.post("/recipes/presets/install", ...admin, c.installPresets);
  r.post("/recipes/from-preset", ...admin, c.fromPreset);
  r.post("/recipes/evaluate", ...read, c.evaluate);
  r.post("/recipes", ...admin, c.create);
  r.get("/recipes/:id", ...read, c.get);
  r.patch("/recipes/:id", ...admin, c.update);
  r.post("/recipes/:id/duplicate", ...admin, c.duplicate);
  r.post("/recipes/:id/archive", ...admin, c.archive);
  r.post("/recipes/:id/restore", ...admin, c.restore);
  r.put("/recipes/:id/assignments", ...admin, c.assignments);
  r.put("/recipes/:id/preview-config", ...admin, c.previewConfig);

  return r;
}
