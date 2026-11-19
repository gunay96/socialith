import { Router } from "express";
import {
  listContent,
  createContent,
  getContent,
  updateContent,
  deleteContent,
  upsertVariation,
  createAsset,
  uploadAsset,
  listTargets,
  assignTargets,
  removeTargets,
  scheduleContent,
  requestGeneration,
  listGenerationJobs,
  requestRender,
  listRenderJobs,
  publishNow,
  retryTarget,
  listPublishAttempts,
  syncAnalytics,
  getMetricsHistory,
} from "../controllers/content.controller.js";
import { assetUpload } from "../services/content-asset-upload.service.js";
import { requireAuth } from "../middleware/auth.js";
import { requireMinimumRole } from "../middleware/rbac.js";

/**
 * Mounted at "/api" in app.ts. Same read-open/write-gated split as
 * routes/campaign.ts — reads: any authenticated role; writes (create,
 * update, delete, variations, assets, targeting, scheduling): EDITOR+.
 */
export function createContentRouter(): Router {
  const router = Router();

  router.get("/content", requireAuth, listContent);
  router.post("/content", requireAuth, requireMinimumRole("EDITOR"), createContent);
  router.get("/content/:id", requireAuth, getContent);
  router.patch("/content/:id", requireAuth, requireMinimumRole("EDITOR"), updateContent);
  router.delete("/content/:id", requireAuth, requireMinimumRole("EDITOR"), deleteContent);

  router.put("/content/:id/variations/:platform", requireAuth, requireMinimumRole("EDITOR"), upsertVariation);
  router.post("/content/:id/assets", requireAuth, requireMinimumRole("EDITOR"), createAsset);
  router.post("/content/:id/assets/upload", requireAuth, requireMinimumRole("EDITOR"), assetUpload, uploadAsset);

  router.get("/content/:id/targets", requireAuth, listTargets);
  router.post("/content/:id/targets", requireAuth, requireMinimumRole("EDITOR"), assignTargets);
  router.delete("/content/:id/targets", requireAuth, requireMinimumRole("EDITOR"), removeTargets);

  router.post("/content/:id/schedule", requireAuth, requireMinimumRole("EDITOR"), scheduleContent);

  // Phase 07: AI content generation + FFmpeg video render. Both POSTs
  // return 202 immediately (job row created + enqueued) — the actual
  // work runs in apps/worker, never on this request path.
  router.post("/content/:id/generation", requireAuth, requireMinimumRole("EDITOR"), requestGeneration);
  router.get("/content/:id/generation", requireAuth, listGenerationJobs);
  router.post("/content/:id/render", requireAuth, requireMinimumRole("EDITOR"), requestRender);
  router.get("/content/:id/render", requireAuth, listRenderJobs);

  // Phase 08: publishing. "publish now" reuses the schedule pipeline at
  // an effectively-immediate timestamp; retry re-enqueues one FAILED
  // target; attempts is the real per-attempt audit trail (PublishAttempt).
  router.post("/content/:id/publish-now", requireAuth, requireMinimumRole("EDITOR"), publishNow);
  router.post("/content/:id/targets/:socialAccountId/retry", requireAuth, requireMinimumRole("EDITOR"), retryTarget);
  router.get("/content/:id/targets/:socialAccountId/attempts", requireAuth, listPublishAttempts);

  // Phase 09: analytics sync trigger (EDITOR+, real side effect — enqueues
  // a real metrics fetch) + the real per-sync history read (any role).
  router.post(
    "/content/:id/targets/:socialAccountId/sync-analytics",
    requireAuth,
    requireMinimumRole("EDITOR"),
    syncAnalytics,
  );
  router.get("/content/:id/targets/:socialAccountId/metrics", requireAuth, getMetricsHistory);

  return router;
}
