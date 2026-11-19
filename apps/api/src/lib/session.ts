import session, { type SessionOptions } from "express-session";
import type { Request, RequestHandler } from "express";
import type { Role } from "@socialith/auth";

/** Single source of truth for the cookie name — used when clearing it on logout too. */
export const SESSION_COOKIE_NAME = "socialith.sid";

/**
 * Only the two env values session config actually needs — not the full
 * `Env` type from @socialith/config — so tests can construct a minimal
 * object instead of satisfying every required env var. The real `Env`
 * object from loadEnv() still structurally satisfies this.
 */
export interface SessionEnv {
  SESSION_SECRET: string;
  NODE_ENV: "development" | "test" | "production";
}

/**
 * `store` is optional and deliberately not defaulted to a Redis
 * connection here — the caller (apps/api/src/app.ts) passes a
 * `connect-redis` RedisStore built from the app's existing Redis
 * connection. Omitting it (as tests do) falls back to express-session's
 * built-in MemoryStore, which is exactly what a single-process test run
 * needs and nothing more.
 */
export function createSessionMiddleware(env: SessionEnv, store?: SessionOptions["store"]): RequestHandler {
  return session({
    store,
    name: SESSION_COOKIE_NAME,
    secret: env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    // Sliding expiration: an active user's cookie keeps getting renewed
    // rather than forcing a re-login exactly 7 days after their first
    // login regardless of activity.
    rolling: true,
    cookie: {
      httpOnly: true,
      // Secure requires HTTPS; only enforce it once we're actually
      // serving over HTTPS (production). See app.ts's `trust proxy`
      // setting, required for this to work correctly behind a reverse
      // proxy/load balancer.
      secure: env.NODE_ENV === "production",
      // "lax" rather than "none": the web app and API are same-site
      // (subdomains of the same registrable domain in production;
      // localhost in dev), so a Lax cookie is still sent on the
      // credentialed cross-origin fetches the frontend makes — while
      // still refusing to attach to genuinely cross-site requests. This
      // is also part of why CSRF tokens aren't implemented in this
      // stage: Lax cookies + the API's strict single-origin CORS check
      // (apps/api/src/app.ts) + JSON-only request bodies (which force a
      // CORS preflight) together block the cross-site form-style CSRF
      // this would otherwise need to defend against.
      sameSite: "lax",
      maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
      path: "/",
    },
  });
}

/**
 * Regenerates the session (new session ID) before establishing an
 * authenticated one — used on both login and invitation acceptance, so
 * a pre-set/pre-existing cookie can never carry over into a newly
 * authenticated session (session fixation prevention).
 */
export function regenerateSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => (err ? reject(err) : resolve()));
  });
}

export function destroySession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.destroy((err) => (err ? reject(err) : resolve()));
  });
}

/**
 * Writes the authenticated session payload (see the SessionData
 * augmentation in types/express.d.ts). Shared by login and invitation
 * acceptance — the two places a session is actually established —
 * rather than each setting these four fields inline.
 */
export function establishSession(
  req: Request,
  user: { id: string; organizationId: string; role: Role; sessionVersion: number },
): void {
  req.session.userId = user.id;
  req.session.organizationId = user.organizationId;
  req.session.role = user.role;
  req.session.sessionVersion = user.sessionVersion;
}
