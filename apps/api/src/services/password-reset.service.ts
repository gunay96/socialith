import { prisma } from "@socialith/database";
import { generateSecureToken, hashToken, hashPassword } from "@socialith/auth";
import { loadEnv, resolveAppOrigin } from "@socialith/config";
import { ERROR_CODES } from "@socialith/types";
import { ApiHttpError } from "../middleware/error-handler.js";
import {
  findUserByEmail,
  findUserById,
  updatePasswordAndInvalidateSessions,
} from "../repositories/user.repository.js";
import {
  createPasswordResetToken,
  findPasswordResetTokenByHash,
  markPasswordResetTokenUsed,
} from "../repositories/password-reset-token.repository.js";
import { createAuditLog } from "../repositories/audit-log.repository.js";
import { getEmailService } from "../lib/email/email.service.js";
import { logger } from "../logger.js";

const RESET_TOKEN_TTL_MS = 1000 * 60 * 60; // 1 hour — shorter-lived than an invitation (7 days), since this is a self-service action the requester triggers and should act on promptly.

/**
 * One message for every "this token doesn't work" case (not found,
 * expired, already used, user no longer eligible) — same reasoning as
 * login's and invitation acceptance's generic-error requirements: no
 * reason to tell a caller *which* case it was.
 */
const INVALID_RESET_TOKEN_MESSAGE = "This password reset link is invalid or has expired.";

/**
 * POST /api/auth/forgot-password. Always resolves — never throws for
 * "unknown email" or "ineligible account", only for genuine
 * infrastructure failures. The controller returns the exact same
 * response regardless of what happened in here; this function's job is
 * only to (maybe) create a token and send an email, never to signal
 * back which case occurred.
 *
 * Unlike invitation creation (an authenticated, admin-only action with
 * no enumeration risk), this endpoint is unauthenticated and public —
 * so, deliberately unlike createInvitation's `devAcceptUrl`, nothing
 * here is surfaced through the API response even outside production.
 * Any conditional field in the response would itself be a distinguishing
 * signal. The dev-only visibility into the reset link is the
 * ConsoleEmailService log line only.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  const normalizedEmail = email.trim().toLowerCase();
  const user = await findUserByEmail(normalizedEmail);

  // Always pay the token-generation cost, whether or not it ends up
  // being used, so this function's timing doesn't reveal whether the
  // email/account is eligible — the same reasoning as login's dummy
  // scrypt verification (see auth.service.ts), applied here to token
  // generation instead of password verification, since there's no
  // password check on this path.
  const rawToken = generateSecureToken();
  const tokenHash = hashToken(rawToken);

  // Only an ACTIVE user is eligible. INVITED (never logged in with a
  // password yet), DISABLED, and REMOVED are all treated the same as
  // "unknown email" — none of them should be distinguishable from the
  // outside, and none of them should receive a working reset link.
  const eligible = user !== null && user.status === "ACTIVE";

  if (!eligible) {
    // No AuditLog row: an unknown email has no organization to attach
    // one to, and for a real-but-ineligible account, deliberately not
    // persisting a distinguishable trail either — see
    // docs/architecture.md "Known limitations" for the same trade-off
    // login's unknown-email case already makes. A structured log line
    // is enough for operational visibility without creating a
    // per-organization audit signal for an account that didn't act.
    logger.warn("Password reset requested for an unknown or ineligible account");
    return;
  }

  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);
  await createPasswordResetToken({ userId: user.id, tokenHash, expiresAt });

  await createAuditLog({
    organizationId: user.organizationId,
    userId: user.id,
    action: "PASSWORD_RESET_REQUESTED",
  });

  const env = loadEnv();
  const appOrigin = resolveAppOrigin(env);
  const resetUrl = `${appOrigin}/reset-password/${rawToken}`;

  const emailService = getEmailService(logger, env.EMAIL_PROVIDER);
  await emailService.sendPasswordReset({ to: user.email, resetUrl, expiresAt });
}

/**
 * POST /api/auth/reset-password. The critical section (re-check the
 * token, update the password + bump sessionVersion, mark the token
 * used) runs inside one `prisma.$transaction` — same pattern as
 * invitation acceptance — so a crash mid-flow can't leave a used token
 * with an unchanged password, or a changed password with a token still
 * valid for reuse.
 */
export async function resetPassword(rawToken: string, newPassword: string): Promise<void> {
  const tokenHash = hashToken(rawToken);
  // Hashing the new (slow, memory-hard) password outside the
  // transaction — it doesn't touch the database and there's no reason
  // to hold a transaction open for it.
  const passwordHash = await hashPassword(newPassword);

  const updatedUser = await prisma.$transaction(async (tx) => {
    const resetToken = await findPasswordResetTokenByHash(tokenHash, tx);

    if (!resetToken || resetToken.usedAt !== null || resetToken.expiresAt.getTime() <= Date.now()) {
      throw new ApiHttpError(400, ERROR_CODES.INVALID_RESET_TOKEN, INVALID_RESET_TOKEN_MESSAGE);
    }

    const user = await findUserById(resetToken.userId, tx);
    // A user who was disabled/removed *after* requesting a reset must
    // not be able to complete it — re-checked here, not just at
    // request time, since time passes between the two steps.
    if (!user || user.status !== "ACTIVE") {
      throw new ApiHttpError(400, ERROR_CODES.INVALID_RESET_TOKEN, INVALID_RESET_TOKEN_MESSAGE);
    }

    const updated = await updatePasswordAndInvalidateSessions(user.id, passwordHash, tx);
    await markPasswordResetTokenUsed(resetToken.id, tx);

    return updated;
  });

  await createAuditLog({
    organizationId: updatedUser.organizationId,
    userId: updatedUser.id,
    action: "PASSWORD_RESET_COMPLETED",
  });
}
