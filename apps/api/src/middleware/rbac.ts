import type { NextFunction, Request, Response } from "express";
import { hasMinimumRole, type Role } from "@socialith/auth";
import { ERROR_CODES } from "@socialith/types";
import { ApiHttpError } from "./error-handler.js";

/**
 * Enforces a minimum role in the OWNER > ADMIN > EDITOR > VIEWER
 * hierarchy (@socialith/auth/rbac.ts). Must be mounted *after*
 * requireAuth on a route — it reads req.user and treats a missing
 * req.user as "not authenticated" rather than "not authorized".
 *
 * This is the RBAC *foundation* for Phase 02: generic hierarchy checks.
 * Team-management-specific rules (an ADMIN can never act on an OWNER,
 * only an OWNER can grant the OWNER role) already exist as
 * canActOnMember/canAssignRole in @socialith/auth and are wired into the
 * team API in a later Phase 02 stage — not duplicated here.
 *
 * Authorization is enforced here, server-side, on every request; the
 * frontend hiding a button is never sufficient on its own.
 */
export function requireMinimumRole(minimumRole: Role) {
  return function requireMinimumRoleMiddleware(req: Request, _res: Response, next: NextFunction): void {
    if (!req.user) {
      next(new ApiHttpError(401, ERROR_CODES.AUTH_REQUIRED, "Authentication required."));
      return;
    }

    if (!hasMinimumRole(req.user.role, minimumRole)) {
      next(new ApiHttpError(403, ERROR_CODES.FORBIDDEN, "Insufficient permissions."));
      return;
    }

    next();
  };
}
