import { Router, type RequestHandler } from "express";
import { login, logout, me, forgotPassword, resetPassword } from "../controllers/auth.controller.js";
import { requireAuth } from "../middleware/auth.js";

export interface AuthRouterDependencies {
  /**
   * Each injected rather than built here so tests can pass permissive
   * no-op middleware instead of standing up a real Redis-backed
   * limiter — see middleware/rate-limit.ts for the real implementations
   * used in apps/api/src/app.ts.
   */
  loginRateLimiter: RequestHandler;
  forgotPasswordRateLimiter: RequestHandler;
  resetPasswordRateLimiter: RequestHandler;
}

/**
 * Mounted at "/api" in app.ts, so these resolve to exactly the paths
 * the spec calls for: POST /api/auth/login, POST /api/auth/logout,
 * GET /api/auth/me, POST /api/auth/forgot-password,
 * POST /api/auth/reset-password.
 *
 * forgot-password and reset-password are deliberately NOT behind
 * requireAuth — the whole point is to help someone who can't currently
 * log in.
 */
export function createAuthRouter({
  loginRateLimiter,
  forgotPasswordRateLimiter,
  resetPasswordRateLimiter,
}: AuthRouterDependencies): Router {
  const router = Router();

  router.post("/auth/login", loginRateLimiter, login);
  router.post("/auth/logout", requireAuth, logout);
  router.get("/auth/me", requireAuth, me);
  router.post("/auth/forgot-password", forgotPasswordRateLimiter, forgotPassword);
  router.post("/auth/reset-password", resetPasswordRateLimiter, resetPassword);

  return router;
}
