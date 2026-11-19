import rateLimit, { type RateLimitRequestHandler } from "express-rate-limit";
import { RedisStore, type RedisReply } from "rate-limit-redis";
import type { Redis } from "ioredis";
import type { Request } from "express";
import { ERROR_CODES, type ApiResponse } from "@socialith/types";

interface RateLimiterOptions {
  /**
   * Optional — the shared-hosting/demo-lite tier boots without Redis (see
   * @socialith/config's REDIS_URL). `null` falls back to
   * express-rate-limit's own built-in in-memory store: rate-limit state
   * then lives in this single process's memory and resets on restart,
   * instead of surviving restarts / being shared across instances. For a
   * single-Passenger-process deployment with no horizontal scaling, that's
   * the same real protection, just non-durable — never silently disabled.
   */
  redis: Redis | null;
  windowMs: number;
  max: number;
  /** Redis key prefix — also used to namespace different limiters sharing one Redis instance. */
  prefix: string;
  keyGenerator?: (req: Request) => string;
}

/**
 * Backed by Redis (the app's existing connection — no new datastore) when
 * available, so rate-limit state survives restarts and is shared across
 * API instances; falls back to an in-memory store when it isn't (see
 * `redis: Redis | null` above). Kept as a factory rather than one
 * hardcoded limiter so a later Phase 02 stage can add e.g. a
 * forgot-password or invitation-creation limiter by calling this again
 * with a different `prefix`/window, without touching this file.
 */
export function createRedisRateLimiter(options: RateLimiterOptions): RateLimitRequestHandler {
  const { redis, windowMs, max, prefix, keyGenerator } = options;

  return rateLimit({
    windowMs,
    limit: max,
    standardHeaders: true,
    legacyHeaders: false,
    // Omitting `store` falls back to express-rate-limit's built-in
    // MemoryStore — exactly what a single-process deployment without
    // Redis needs and nothing more.
    store: redis
      ? new RedisStore({
          // rate-limit-redis's ioredis integration point: forward the raw
          // command to ioredis's low-level `call`, which returns a promise.
          // ioredis types `call` as a tuple-spread ([command, ...rest]), not a
          // plain string[] — `args` is cast to that shape here purely to
          // satisfy the type checker; the runtime call is unchanged.
          sendCommand: (...args: string[]) =>
            redis.call(...(args as [string, ...string[]])) as Promise<RedisReply>,
          prefix,
        })
      : undefined,
    keyGenerator: keyGenerator ?? ((req) => req.ip ?? "unknown"),
    handler: (_req, res) => {
      const body: ApiResponse<never> = {
        success: false,
        error: {
          code: ERROR_CODES.RATE_LIMITED,
          message: "Too many attempts. Please try again later.",
        },
      };
      res.status(429).json(body);
    },
  });
}

/**
 * Composite rate-limit key: IP + the attempted email together, so this
 * slows down both a single attacker hammering one account from one IP
 * and a broad guess-many-emails sweep from that IP, without one
 * heavily-used office/NAT IP locking out every account behind it.
 * Exported on its own so it's unit-testable without a real Redis
 * connection or a full express-rate-limit pipeline.
 */
export function buildLoginRateLimitKey(req: Pick<Request, "ip" | "body">): string {
  const email =
    typeof req.body === "object" && req.body !== null && typeof (req.body as Record<string, unknown>).email === "string"
      ? ((req.body as Record<string, unknown>).email as string).trim().toLowerCase()
      : "unknown";
  return `${req.ip ?? "unknown"}:${email}`;
}

/**
 * Login-specific limiter: keyed on IP *and* the attempted email together,
 * so it slows down both a single attacker hammering one account from one
 * IP and a broad guess-many-emails sweep from that IP, without one
 * heavily-used office/NAT IP locking out every account behind it.
 */
export function createLoginRateLimiter(redis: Redis | null): RateLimitRequestHandler {
  return createRedisRateLimiter({
    redis,
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10,
    prefix: "socialith:rl:login:",
    keyGenerator: buildLoginRateLimitKey,
  });
}

/**
 * Forgot-password limiter: same IP+email composite key as login, for
 * the same reason (one attacker hammering an account vs. one heavily-
 * shared IP shouldn't lock out unrelated users). A looser cap than
 * login's — a legitimate user might reasonably retry a forgot-password
 * request a few times if they mistype their email or don't see the
 * (fake) email arrive.
 */
export function createForgotPasswordRateLimiter(redis: Redis | null): RateLimitRequestHandler {
  return createRedisRateLimiter({
    redis,
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5,
    prefix: "socialith:rl:forgot-password:",
    keyGenerator: buildLoginRateLimitKey,
  });
}

/**
 * Reset-password limiter: IP-only (the default keyGenerator) rather
 * than IP+email, because the request body here carries a token, not an
 * email — there's no equivalent identity to key on before the token is
 * validated. This is the token brute-force protection: the token
 * itself is a 256-bit random value (computationally infeasible to
 * guess regardless), but rate limiting the endpoint is still cheap
 * defense in depth against a scripted guessing attempt.
 */
export function createResetPasswordRateLimiter(redis: Redis | null): RateLimitRequestHandler {
  return createRedisRateLimiter({
    redis,
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10,
    prefix: "socialith:rl:reset-password:",
  });
}

/**
 * Phase 10 §15: a real, blanket cap on every `/api` request — not a
 * replacement for the tighter per-endpoint limiters above (login/forgot/
 * reset-password), but a backstop so no single client (buggy integration,
 * scripted abuse) can hammer any endpoint those don't specifically cover.
 * IP-keyed like the default; generous enough not to bother a real user
 * clicking around the dashboard.
 */
export function createGeneralApiRateLimiter(redis: Redis | null): RateLimitRequestHandler {
  return createRedisRateLimiter({
    redis,
    windowMs: 60 * 1000, // 1 minute
    max: 300,
    prefix: "socialith:rl:api:",
  });
}

/**
 * Phase 10 §15: OAuth start/callback are each a real outbound redirect to
 * TikTok/Meta/Google's own authorize endpoint — a scripted loop hitting
 * `/oauth/:platform/start` would both hammer this API and generate a flood
 * of real requests against the platform's servers under this app's own
 * registered OAuth client. Keyed by user id (set by requireAuth, which
 * this always runs after — see routes/oauth.ts) + platform, not IP: the
 * thing being protected here is "one user connecting one platform
 * repeatedly," which an IP-only key would conflate with unrelated users
 * behind the same NAT/office IP.
 */
export function createOAuthRateLimiter(redis: Redis | null): RateLimitRequestHandler {
  return createRedisRateLimiter({
    redis,
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 20,
    prefix: "socialith:rl:oauth:",
    keyGenerator: (req) => {
      const userId = req.user?.id ?? req.ip ?? "unknown";
      return `${userId}:${req.params.platform ?? "unknown"}`;
    },
  });
}
