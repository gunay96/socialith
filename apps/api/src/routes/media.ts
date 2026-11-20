import { Router } from "express";
import * as c from "../controllers/media.controller.js";
import { requireAuth } from "../middleware/auth.js";
import { requireMinimumRole } from "../middleware/rbac.js";
import { mediaUpload } from "../services/media-upload.service.js";

/**
 * Media library and the progress ledger. Mounted at "/api". Every role can read (and stream) what the organization holds;
 * uploading, tagging, assigning, archiving and re-analyzing need EDITOR; confirming the rights to use a file needs ADMIN.
 * The library is PRIVATE: its files are served only by these authenticated routes, never by a public static path.
 */
export function createMediaRouter(): Router {
  const r = Router();
  const read = [requireAuth];
  const editor = [requireAuth, requireMinimumRole("EDITOR")];
  const admin = [requireAuth, requireMinimumRole("ADMIN")];

  r.post("/media/uploads", ...editor, mediaUpload, c.upload);

  r.get("/media/assets", ...read, c.listAssets);
  r.get("/media/facets", ...read, c.facets);
  r.post("/media/assets/bulk/tags", ...editor, c.bulkTags);
  r.get("/media/assets/:id", ...read, c.getAsset);
  r.get("/media/assets/:id/content", ...read, c.stream("content"));
  r.get("/media/assets/:id/thumbnail", ...read, c.stream("thumbnail"));
  r.put("/media/assets/:id/tags", ...editor, c.setTags);
  r.put("/media/assets/:id/notes", ...editor, c.setNotes);
  r.put("/media/assets/:id/campaigns", ...editor, c.setAssetCampaigns);
  r.put("/media/assets/:id/page-groups", ...editor, c.setAssetPageGroups);
  r.put("/media/assets/:id/rights", ...admin, c.setRights);
  r.post("/media/assets/:id/archive", ...editor, c.archiveAsset);
  r.post("/media/assets/:id/restore", ...editor, c.restoreAsset);
  r.post("/media/assets/:id/reanalyze", ...editor, c.reanalyze);

  r.get("/media/packs", ...read, c.listPacks);
  r.get("/media/packs/:id", ...read, c.getPack);
  r.patch("/media/packs/:id", ...editor, c.updatePack);
  r.put("/media/packs/:id/campaigns", ...editor, c.setPackCampaigns);
  r.put("/media/packs/:id/page-groups", ...editor, c.setPackPageGroups);
  r.post("/media/packs/:id/archive", ...editor, c.archivePack);
  r.post("/media/packs/:id/restore", ...editor, c.restorePack);

  r.get("/operations/tasks", ...read, c.listTasks);
  r.get("/operations/tasks/:id", ...read, c.getTask);

  return r;
}
