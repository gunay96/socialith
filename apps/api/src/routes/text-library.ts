import { Router } from "express";
import * as c from "../controllers/text.controller.js";
import { requireAuth } from "../middleware/auth.js";
import { requireMinimumRole } from "../middleware/rbac.js";
import { textImportUpload } from "../services/text-import.service.js";

/**
 * The Text Library. Mounted at "/api". Every role can read. EDITOR can add, edit, import and assign texts and record
 * their use; ADMIN approves, rejects, archives, sets usage rights and organizes categories and collections.
 * (The service layer repeats the administrator checks, including for bulk actions.)
 */
export function createTextLibraryRouter(): Router {
  const r = Router();
  const read = [requireAuth];
  const editor = [requireAuth, requireMinimumRole("EDITOR")];
  const admin = [requireAuth, requireMinimumRole("ADMIN")];

  r.get("/text-library/summary", ...read, c.summary);

  r.get("/text-library/categories", ...read, c.listCategories);
  r.post("/text-library/categories", ...admin, c.createCategory);
  r.post("/text-library/categories/starters", ...admin, c.addStarterCategories);
  r.patch("/text-library/categories/:id", ...admin, c.updateCategory);
  r.post("/text-library/categories/:id/archive", ...admin, c.archiveCategory);
  r.post("/text-library/categories/:id/restore", ...admin, c.restoreCategory);

  r.get("/text-library/collections", ...read, c.listCollections);
  r.post("/text-library/collections", ...admin, c.createCollection);
  r.patch("/text-library/collections/:id", ...admin, c.updateCollection);
  r.post("/text-library/collections/:id/archive", ...admin, c.archiveCollection);
  r.post("/text-library/collections/:id/restore", ...admin, c.restoreCollection);
  r.post("/text-library/collections/:id/texts", ...admin, c.addCollectionTexts);
  r.delete("/text-library/collections/:id/texts", ...admin, c.removeCollectionTexts);

  r.post("/text-library/imports", ...editor, textImportUpload, c.importTexts);

  r.get("/text-library/texts", ...read, c.listTexts);
  r.post("/text-library/texts", ...editor, c.createText);
  r.post("/text-library/texts/bulk", ...editor, c.bulk);
  r.get("/text-library/texts/:id", ...read, c.getText);
  r.patch("/text-library/texts/:id", ...editor, c.updateText);
  r.put("/text-library/texts/:id/categories", ...editor, c.setCategories);
  r.put("/text-library/texts/:id/campaigns", ...editor, c.setCampaigns);
  r.put("/text-library/texts/:id/page-categories", ...editor, c.setPageCategories);
  r.put("/text-library/texts/:id/page-groups", ...editor, c.setPageGroups);
  r.put("/text-library/texts/:id/pages", ...editor, c.setPages);
  r.post("/text-library/texts/:id/approve", ...admin, c.approve);
  r.post("/text-library/texts/:id/reject", ...admin, c.reject);
  r.post("/text-library/texts/:id/archive", ...admin, c.archive);
  r.post("/text-library/texts/:id/restore", ...admin, c.restore);
  r.put("/text-library/texts/:id/rights", ...admin, c.setRights);
  r.get("/text-library/texts/:id/usages", ...read, c.listUsages);
  r.post("/text-library/texts/:id/usages", ...editor, c.recordUsage);

  return r;
}
