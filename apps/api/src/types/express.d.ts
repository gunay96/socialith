import "express-session";
import type { Role } from "@socialith/auth";
import type { SafeUser } from "./auth.js";

declare module "express-session" {
  interface SessionData {
    userId?: string;
    organizationId?: string;
    role?: Role;
    // Snapshot of User.sessionVersion at login time. Compared against the
    // live value on every authenticated request (see middleware/auth.ts)
    // so bumping it (e.g. on password reset, in a later Phase 02 stage)
    // invalidates every session carrying the old value without having to
    // enumerate or delete them.
    sessionVersion?: number;
    // Phase 10 OAuth connect: set by GET /api/oauth/:platform/start,
    // checked (and cleared) by the callback — the CSRF-protection `state`
    // round-trip lives server-side in the session, never trusted from a
    // client-supplied value alone. `platform` is checked too so a
    // callback for one platform can't be replayed against a state issued
    // for another. `codeVerifier` is PKCE's matching secret (only set
    // when the resolved provider's requiresPkce is true — see
    // oauth/types.ts's OAuthProvider — TikTok, confirmed live) and rides
    // in the same single-use session slot as `state`, for the same
    // never-trust-the-client reason.
    oauthState?: { platform: string; state: string; createdAt: number; codeVerifier?: string };
  }
}

declare global {
  namespace Express {
    interface Request {
      /** Populated by requireAuth. Absent on unauthenticated requests. */
      user?: SafeUser;
    }
  }
}

export {};
