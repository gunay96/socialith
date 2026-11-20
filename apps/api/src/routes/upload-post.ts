import { Router } from "express";
import * as c from "../controllers/upload-post.controller.js";
import { requireAuth } from "../middleware/auth.js";
import { requireMinimumRole } from "../middleware/rbac.js";

/**
 * Mounted at "/api" in app.ts. Read access for every authenticated role (same openness as /accounts); every
 * change needs ADMIN. TikTok music lookups need EDITOR (they cost provider calls but change nothing); rights
 * confirmation needs ADMIN (it is a person's attestation about copyright/promotional use).
 */
export function createUploadPostRouter(): Router {
  const r = Router();
  const read = [requireAuth];
  const admin = [requireAuth, requireMinimumRole("ADMIN")];
  const editor = [requireAuth, requireMinimumRole("EDITOR")];

  r.get("/upload-post/overview", ...read, c.getOverview);
  r.get("/upload-post/health", ...read, c.getHealth);
  r.get("/upload-post/plan", ...read, c.getPlan);
  r.get("/upload-post/capabilities", ...read, c.getCapabilities);
  r.post("/upload-post/sync", ...admin, c.requestSync);

  r.get("/upload-post/profiles", ...read, c.listProfiles);
  r.patch("/upload-post/profiles/:id/mapping", ...admin, c.setProfileMapping);
  r.get("/upload-post/accounts", ...read, c.listAccounts);
  r.patch("/upload-post/accounts/:id/mapping", ...admin, c.setAccountMapping);
  r.post("/upload-post/accounts/:id/destination", ...admin, c.enableDestination);
  r.delete("/upload-post/accounts/:id/destination", ...admin, c.disableDestination);

  r.get("/upload-post/publications", ...read, c.listPublications);
  r.get("/upload-post/scheduled", ...read, c.listScheduled);

  r.get("/managed-pages", ...read, c.listManagedPages);
  r.post("/managed-pages", ...admin, c.createManagedPage);
  r.patch("/managed-pages/:id", ...admin, c.updateManagedPage);
  r.get("/creators", ...read, c.listCreators);
  r.post("/creators", ...admin, c.createCreator);
  r.patch("/creators/:id", ...admin, c.updateCreator);

  r.get("/upload-post/tiktok/music", ...editor, c.searchMusic);
  r.get("/sounds/:id/music-mappings", ...read, c.listMusicMappings);
  r.post("/sounds/:id/music-mappings", ...admin, c.createMusicMapping);
  r.post("/music-mappings/:id/verify", ...editor, c.verifyMusicMapping);
  r.post("/music-mappings/:id/rights", ...admin, c.setMusicRights);
  r.delete("/music-mappings/:id", ...admin, c.deleteMusicMapping);

  return r;
}

/** Unauthenticated by design: authenticated by the HMAC signature over the raw body (see the controller). */
export function createUploadPostWebhookRouter(): Router {
  const r = Router();
  r.post("/webhooks/upload-post", c.receiveWebhook);
  return r;
}
