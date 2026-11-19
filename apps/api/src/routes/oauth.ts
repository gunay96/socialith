import { Router } from "express";
import type { RateLimitRequestHandler } from "express-rate-limit";
import { startOAuth, handleOAuthCallback } from "../controllers/oauth.controller.js";
import { requireAuth } from "../middleware/auth.js";
import { requireMinimumRole } from "../middleware/rbac.js";

/**
 * Mounted at "/api" in app.ts. Both routes require an existing app
 * session — the connecting user must already be logged into Socialith
 * (this is "attach a platform account to my organization", not a public
 * login) — the platform's own consent screen is the separate auth step
 * in between. `start` is EDITOR+ (same RBAC level as disconnect);
 * `callback` only re-checks requireAuth since role was already verified
 * before the redirect to the platform began, and re-deriving it here
 * from a potentially stale/replayed request adds no real protection
 * beyond what the state check already provides.
 */
export function createOAuthRouter(oauthRateLimiter: RateLimitRequestHandler): Router {
  const router = Router();

  router.get("/oauth/:platform/start", requireAuth, requireMinimumRole("EDITOR"), oauthRateLimiter, startOAuth);
  router.get("/oauth/:platform/callback", requireAuth, oauthRateLimiter, handleOAuthCallback);

  return router;
}
