import type { NextFunction, Request, Response } from "express";
import { ERROR_CODES } from "@socialith/types";
import { findUserById } from "../repositories/user.repository.js";
import { toSafeUser } from "../services/auth.service.js";
import { ApiHttpError } from "./error-handler.js";

const AUTH_REQUIRED_MESSAGE = "Authentication required.";

/**
 * The single source of truth for "is this request authenticated":
 *   1. reads userId/sessionVersion out of the session cookie's payload
 *   2. loads the user fresh from the database (so a disable/role-change
 *      takes effect on the very next request, not just the next login)
 *   3. rejects if the user is missing, not ACTIVE, or if the session's
 *      sessionVersion no longer matches the user's current one (i.e. the
 *      session was invalidated — see User.sessionVersion)
 *   4. attaches the safe user projection to req.user for every
 *      downstream handler/middleware (organization isolation and RBAC
 *      both read req.user.organizationId / req.user.role from here)
 *
 * Every route that needs auth uses this middleware rather than
 * re-implementing any part of the above.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { userId, sessionVersion } = req.session;

    if (!userId || sessionVersion === undefined) {
      next(new ApiHttpError(401, ERROR_CODES.AUTH_REQUIRED, AUTH_REQUIRED_MESSAGE));
      return;
    }

    const user = await findUserById(userId);

    const sessionIsValid = user !== null && user.status === "ACTIVE" && user.sessionVersion === sessionVersion;

    if (!sessionIsValid) {
      // The session refers to a user that's gone, disabled, or was
      // invalidated (sessionVersion bumped elsewhere) — destroy it
      // server-side too rather than leaving a dead session in the store.
      req.session.destroy(() => {
        /* best-effort cleanup; the request fails either way */
      });
      next(new ApiHttpError(401, ERROR_CODES.AUTH_REQUIRED, AUTH_REQUIRED_MESSAGE));
      return;
    }

    req.user = toSafeUser(user);
    next();
  } catch (err) {
    next(err);
  }
}
