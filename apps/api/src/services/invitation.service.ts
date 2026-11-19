import { prisma } from "@socialith/database";
import type { UserRole } from "@socialith/database";
import { generateSecureToken, hashToken, hashPassword } from "@socialith/auth";
import { loadEnv, resolveAppOrigin } from "@socialith/config";
import { ERROR_CODES } from "@socialith/types";
import { ApiHttpError } from "../middleware/error-handler.js";
import { findUserByEmail, createUser, reactivateUser } from "../repositories/user.repository.js";
import { findOrganizationName } from "../repositories/organization.repository.js";
import {
  findOutstandingInvitation,
  revokeInvitation,
  createInvitationRecord,
  findInvitationByTokenHash,
  findInvitationWithOrganizationByTokenHash,
  markInvitationAccepted,
} from "../repositories/invitation.repository.js";
import { createAuditLog } from "../repositories/audit-log.repository.js";
import { getEmailService } from "../lib/email/email.service.js";
import { logger } from "../logger.js";
import { toSafeUser } from "./auth.service.js";
import type { SafeUser } from "../types/auth.js";

const INVITATION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

/**
 * One message for every "this token doesn't lead anywhere" case (not
 * found, expired, already accepted) — deliberately not distinguished,
 * the same reasoning as login's generic-error requirement: no reason to
 * tell a caller *which* of those it is.
 */
const INVALID_INVITATION_MESSAGE = "This invitation link is invalid or has expired.";

function isOutstanding(invitation: { acceptedAt: Date | null; expiresAt: Date }): boolean {
  return invitation.acceptedAt === null && invitation.expiresAt.getTime() > Date.now();
}

export interface CreateInvitationResult {
  invitation: { id: string; email: string; role: UserRole; expiresAt: Date; createdAt: Date };
  /**
   * Only present outside production, since no real email provider is
   * connected yet — see lib/email/email.service.ts.
   */
  devAcceptUrl?: string;
}

export async function createInvitation(
  actor: SafeUser,
  input: { email: string; role: UserRole },
): Promise<CreateInvitationResult> {
  const email = input.email.trim().toLowerCase();

  // `users.email` is unique across the whole system, not per
  // organization — so this checks both "already a member here" and
  // "already belongs to a different org" in one lookup. REMOVED users
  // don't count as existing (their email is free to be re-invited).
  const existingUser = await findUserByEmail(email);
  if (existingUser && existingUser.status !== "REMOVED") {
    if (existingUser.organizationId === actor.organizationId) {
      throw new ApiHttpError(
        409,
        ERROR_CODES.CONFLICT,
        "This email already belongs to a member of this organization.",
      );
    }
    throw new ApiHttpError(
      409,
      ERROR_CODES.CONFLICT,
      "This email already belongs to an account in another organization.",
    );
  }

  // "Do not create duplicate outstanding invitations" — revoke any
  // existing unaccepted, unexpired invitation for this email+org first,
  // rather than stacking a second valid one alongside it.
  const existingInvitation = await findOutstandingInvitation(actor.organizationId, email);
  if (existingInvitation) {
    await revokeInvitation(existingInvitation.id);
  }

  const rawToken = generateSecureToken();
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);

  const invitation = await createInvitationRecord({
    organizationId: actor.organizationId,
    email,
    role: input.role,
    tokenHash,
    expiresAt,
    invitedById: actor.id,
  });

  await createAuditLog({
    organizationId: actor.organizationId,
    userId: actor.id,
    action: "INVITATION_CREATED",
    targetType: "Invitation",
    targetId: invitation.id,
    // Never the raw token or its hash — only what was invited.
    metadata: { email, role: input.role },
  });

  const env = loadEnv();
  const appOrigin = resolveAppOrigin(env);
  const acceptUrl = `${appOrigin}/accept-invitation/${rawToken}`;
  const organizationName = await findOrganizationName(actor.organizationId);

  const emailService = getEmailService(logger, env.EMAIL_PROVIDER);
  await emailService.sendInvitation({
    to: email,
    organizationName,
    role: input.role,
    invitedByName: actor.name,
    acceptUrl,
  });

  return {
    invitation: {
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      expiresAt: invitation.expiresAt,
      createdAt: invitation.createdAt,
    },
    devAcceptUrl: env.NODE_ENV === "production" ? undefined : acceptUrl,
  };
}

export interface InvitationPreview {
  email: string;
  role: UserRole;
  organizationName: string;
  expiresAt: Date;
}

/** Read-only — GET /api/team/invitations/:token. No side effects. */
export async function previewInvitation(rawToken: string): Promise<InvitationPreview> {
  const tokenHash = hashToken(rawToken);
  const invitation = await findInvitationWithOrganizationByTokenHash(tokenHash);

  if (!invitation || !isOutstanding(invitation)) {
    throw new ApiHttpError(400, ERROR_CODES.INVALID_INVITATION, INVALID_INVITATION_MESSAGE);
  }

  return {
    email: invitation.email,
    role: invitation.role,
    organizationName: invitation.organization.name,
    expiresAt: invitation.expiresAt,
  };
}

export interface AcceptInvitationResult {
  safeUser: SafeUser;
  sessionVersion: number;
}

/**
 * POST /api/team/invitations/:token. The critical section (re-check the
 * invitation, create-or-reactivate the user, mark the invitation
 * accepted) runs inside one `prisma.$transaction` — either all three
 * happen or none do, so a crash mid-flow can never leave an accepted
 * invitation with no matching user, or a new user with an invitation
 * that's still technically outstanding.
 */
export async function acceptInvitation(
  rawToken: string,
  input: { name: string; password: string },
): Promise<AcceptInvitationResult> {
  const tokenHash = hashToken(rawToken);
  // Hashing the (slow, memory-hard) new password outside the
  // transaction — it doesn't touch the database and there's no reason
  // to hold a transaction open for it.
  const passwordHash = await hashPassword(input.password);

  const { user, invitation } = await prisma.$transaction(async (tx) => {
    const invitation = await findInvitationByTokenHash(tokenHash, tx);

    if (!invitation || !isOutstanding(invitation)) {
      throw new ApiHttpError(400, ERROR_CODES.INVALID_INVITATION, INVALID_INVITATION_MESSAGE);
    }

    const existingUser = await findUserByEmail(invitation.email, tx);

    let user;
    if (!existingUser) {
      user = await createUser(
        {
          organizationId: invitation.organizationId,
          name: input.name,
          email: invitation.email,
          passwordHash,
          role: invitation.role,
        },
        tx,
      );
    } else if (existingUser.organizationId !== invitation.organizationId) {
      // "If the existing data model does not support multi-organization
      // users, reject conflicting organization membership with a clear
      // safe error." This schema ties one email to exactly one
      // organization — never silently move them to this invitation's
      // organization instead.
      throw new ApiHttpError(
        409,
        ERROR_CODES.CONFLICT,
        "This email is already associated with an account in a different organization. Multi-organization accounts are not supported.",
      );
    } else if (existingUser.status === "REMOVED") {
      // Same email, same org, previously soft-removed — reactivate the
      // existing row rather than trying to create a second User with
      // the same email (blocked by the unique constraint on `email`).
      user = await reactivateUser(existingUser.id, { name: input.name, passwordHash, role: invitation.role }, tx);
    } else {
      throw new ApiHttpError(
        409,
        ERROR_CODES.CONFLICT,
        "An account already exists for this email. Please log in instead.",
      );
    }

    await markInvitationAccepted(invitation.id, tx);

    return { user, invitation };
  });

  await createAuditLog({
    organizationId: user.organizationId,
    userId: user.id,
    action: "INVITATION_ACCEPTED",
    targetType: "Invitation",
    targetId: invitation.id,
    // Never the raw token or its hash.
    metadata: { email: invitation.email, role: invitation.role },
  });

  return { safeUser: toSafeUser(user), sessionVersion: user.sessionVersion };
}
