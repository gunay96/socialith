import type { NextFunction, Request, Response } from "express";
import { ERROR_CODES, type ApiResponse } from "@socialith/types";
import { ApiHttpError } from "../middleware/error-handler.js";
import { loginSchema } from "../validation/auth.validation.js";
import { forgotPasswordSchema, resetPasswordSchema } from "../validation/password-reset.validation.js";
import { authenticateWithPassword, toSafeUser } from "../services/auth.service.js";
import {
  requestPasswordReset,
  resetPassword as resetPasswordService,
} from "../services/password-reset.service.js";
import { touchLastLogin } from "../repositories/user.repository.js";
import { createAuditLog } from "../repositories/audit-log.repository.js";
import type { SafeUser } from "../types/auth.js";
import { logger } from "../logger.js";
import { SESSION_COOKIE_NAME, destroySession, establishSession, regenerateSession } from "../lib/session.js";

// One generic message for every failure mode (unknown email, wrong
// password, disabled account) — the client never learns which.
const GENERIC_AUTH_ERROR_MESSAGE = "Invalid email or password.";

// Same response every time, regardless of whether the email matched an
// eligible account — see services/password-reset.service.ts for why.
const GENERIC_FORGOT_PASSWORD_MESSAGE =
  "If an account with that email exists, a password reset link has been sent.";

export async function login(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiHttpError(400, ERROR_CODES.INVALID_REQUEST, "Email and password are required.");
    }
    const { email, password } = parsed.data;

    const result = await authenticateWithPassword(email, password);

    if (result.outcome !== "success") {
      // Only persist a LOGIN_FAILED row when there's an organization to
      // attach it to (audit_logs.organization_id is NOT NULL) — an
      // unknown email has no such context. See
      // docs/architecture.md "Known limitations" for this trade-off.
      if (result.outcome === "invalid_password" || result.outcome === "disabled") {
        await createAuditLog({
          organizationId: result.user.organizationId,
          userId: result.user.id,
          action: "LOGIN_FAILED",
          metadata: { reason: result.outcome },
        });
      } else {
        logger.warn("Login attempt for an email with no matching account");
      }
      throw new ApiHttpError(401, ERROR_CODES.AUTH_REQUIRED, GENERIC_AUTH_ERROR_MESSAGE);
    }

    const { user } = result;

    // Regenerate the session (new session ID) on privilege escalation —
    // prevents session fixation from a pre-set cookie carrying over into
    // an authenticated session.
    await regenerateSession(req);
    establishSession(req, user);

    await touchLastLogin(user.id);
    await createAuditLog({
      organizationId: user.organizationId,
      userId: user.id,
      action: "LOGIN_SUCCESS",
    });

    const body: ApiResponse<SafeUser> = { success: true, data: toSafeUser(user) };
    res.status(200).json(body);
  } catch (err) {
    next(err);
  }
}

export async function logout(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    // requireAuth ran first, so req.user is guaranteed populated here.
    const currentUser = req.user;

    await destroySession(req);
    res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });

    if (currentUser) {
      await createAuditLog({
        organizationId: currentUser.organizationId,
        userId: currentUser.id,
        action: "LOGOUT",
      });
    }

    const body: ApiResponse<{ loggedOut: true }> = { success: true, data: { loggedOut: true } };
    res.status(200).json(body);
  } catch (err) {
    next(err);
  }
}

export function me(req: Request, res: Response): void {
  // requireAuth ran first, so req.user is guaranteed populated here.
  const body: ApiResponse<SafeUser> = { success: true, data: req.user as SafeUser };
  res.status(200).json(body);
}

/**
 * POST /api/auth/forgot-password. Always returns the same 200 body
 * regardless of whether the email matched an eligible account — see
 * services/password-reset.service.ts's requestPasswordReset for the
 * full reasoning. A malformed email (fails validation) still gets 400
 * INVALID_REQUEST like every other endpoint in this app; that's a
 * distinct concern from "is this a real account" — a syntactically
 * invalid address was never going to match anything either way, so
 * responding differently for it doesn't reveal which real emails exist.
 */
export async function forgotPassword(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = forgotPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiHttpError(400, ERROR_CODES.INVALID_REQUEST, "A valid email is required.");
    }

    await requestPasswordReset(parsed.data.email);

    const body: ApiResponse<{ message: string }> = {
      success: true,
      data: { message: GENERIC_FORGOT_PASSWORD_MESSAGE },
    };
    res.status(200).json(body);
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/auth/reset-password. Unlike login/invitation-acceptance,
 * this does *not* establish a session — the whole point of a reset is
 * to invalidate every existing session (sessionVersion bump, see
 * password-reset.service.ts), so the outcome is "logged out
 * everywhere, please log in again with the new password," not an
 * automatic new session.
 */
export async function resetPassword(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = resetPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiHttpError(400, ERROR_CODES.INVALID_REQUEST, "A reset token and a valid password are required.");
    }

    await resetPasswordService(parsed.data.token, parsed.data.password);

    const body: ApiResponse<{ passwordReset: true }> = { success: true, data: { passwordReset: true } };
    res.status(200).json(body);
  } catch (err) {
    next(err);
  }
}
