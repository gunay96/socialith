import express from "express";
import cors from "cors";
import helmet from "helmet";
import pinoHttp from "pino-http";
import RedisStore from "connect-redis";
import type { Redis } from "ioredis";
import { loadEnv, resolveAppOrigin, resolveLocalStorageDir } from "@socialith/config";
import { logger } from "./logger.js";
import { healthRouter } from "./routes/health.js";
import { createAuthRouter } from "./routes/auth.js";
import { createTeamRouter } from "./routes/team.js";
import { createSocialAccountRouter } from "./routes/social-account.js";
import { createCampaignRouter } from "./routes/campaign.js";
import { createContentRouter } from "./routes/content.js";
import { createSoundRouter } from "./routes/sound.js";
import { createAnalyticsRouter } from "./routes/analytics.js";
import { createOAuthRouter } from "./routes/oauth.js";
import { createPlatformCapabilitiesRouter } from "./routes/platform-capabilities.js";
import { createDashboardRouter } from "./routes/dashboard.js";
import { createSessionMiddleware } from "./lib/session.js";
import {
  createLoginRateLimiter,
  createForgotPasswordRateLimiter,
  createResetPasswordRateLimiter,
  createGeneralApiRateLimiter,
  createOAuthRateLimiter,
} from "./middleware/rate-limit.js";
import { errorHandler, notFoundHandler } from "./middleware/error-handler.js";

/**
 * `redis` is optional — the shared-hosting/demo-lite tier (cPanel Setup
 * Node.js App, no persistent worker, no Redis) boots without one. `null`
 * falls back to express-session's in-memory MemoryStore (see
 * lib/session.ts) and express-rate-limit's in-memory store (see
 * middleware/rate-limit.ts) instead of crashing at boot.
 */
export function createApp(redis: Redis | null): express.Express {
  const app = express();
  const env = loadEnv();
  // Resolved once at boot: required + validated non-localhost in
  // production (see @socialith/config), falls back to the local web dev
  // server only outside production. There is no wildcard and no blind
  // reflection of the request's Origin header.
  const allowedOrigin = resolveAppOrigin(env);

  // Required for `cookie.secure` and req.ip to be correct behind a
  // reverse proxy/load balancer in production (per spec §66: API is
  // deployed to a VPS, typically behind nginx/traefik terminating TLS).
  // Assumes exactly one trusted proxy hop — revisit this number if the
  // real production topology adds more hops in front of the API.
  if (env.NODE_ENV === "production") {
    app.set("trust proxy", 1);
  }

  app.use(helmet());
  app.use(
    cors({
      credentials: true,
      origin(origin, callback) {
        // Requests with no Origin header (health checks, curl, server-to-
        // server calls) aren't subject to the browser same-origin policy
        // this check exists for — let them through.
        if (!origin) {
          callback(null, true);
          return;
        }
        if (origin === allowedOrigin) {
          callback(null, true);
          return;
        }
        logger.warn({ origin, allowedOrigin }, "Blocked CORS request from disallowed origin");
        callback(null, false);
      },
    }),
  );
  app.use(express.json({ limit: "2mb" }));
  app.use(pinoHttp({ logger }));

  // Phase 07: serves apps/worker's rendered assets and apps/api's own
  // uploaded source assets (see packages/video-engine's LocalStorageConfig
  // and content-asset-upload.service.ts) — the real, credential-free
  // storage backend this phase ships. Deliberately unauthenticated, same
  // as any static CDN URL would be: ContentAsset.url values are meant to
  // be directly loadable by a <video>/<img> tag. Keys are unguessable
  // (organizationId + a random UUID segment, never sequential), which is
  // the same "obscure, not enumerable" posture most real object-storage
  // public URLs have — a real production deployment would eventually
  // move to signed R2 URLs instead; tracked as a known limitation, not
  // silently treated as equivalent security.
  app.use("/media", express.static(resolveLocalStorageDir(env)));

  // Sessions are stored in the app's existing Redis connection when one
  // is configured — no new datastore — so session state survives API
  // restarts and is shared across API instances. Without Redis (shared-
  // hosting/demo-lite tier), falls back to express-session's in-memory
  // MemoryStore: sessions then live only in this process and reset on
  // restart, which is the correct tradeoff for a single-process
  // deployment with no horizontal scaling. See lib/session.ts.
  const sessionStore = redis ? new RedisStore({ client: redis, prefix: "socialith:sess:" }) : undefined;
  app.use(createSessionMiddleware(env, sessionStore));

  // Mounted under /api (not at the root, unlike earlier phases) so a
  // cPanel "Setup Node.js App" deployment — where this whole app is
  // proxied at the socialith.co/api subpath — can actually reach it;
  // apps/web owns the domain root there, so nothing outside /api is ever
  // routed to this process in that topology. See docs/deployment-*.
  app.use("/api", healthRouter(redis));
  // Phase 10 §15: a blanket per-IP cap on every /api request, ahead of
  // the tighter per-endpoint limiters below — see createGeneralApiRateLimiter.
  app.use("/api", createGeneralApiRateLimiter(redis));
  app.use(
    "/api",
    createAuthRouter({
      loginRateLimiter: createLoginRateLimiter(redis),
      forgotPasswordRateLimiter: createForgotPasswordRateLimiter(redis),
      resetPasswordRateLimiter: createResetPasswordRateLimiter(redis),
    }),
  );
  app.use("/api", createTeamRouter());
  app.use("/api", createSocialAccountRouter());
  app.use("/api", createCampaignRouter());
  app.use("/api", createContentRouter());
  app.use("/api", createSoundRouter());
  app.use("/api", createAnalyticsRouter());
  app.use("/api", createOAuthRouter(createOAuthRateLimiter(redis)));
  app.use("/api", createPlatformCapabilitiesRouter());
  app.use("/api", createDashboardRouter());

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
