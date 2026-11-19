import { prisma } from "@socialith/database";
import type { Invitation, UserRole } from "@socialith/database";

/**
 * Every function here accepts an optional Prisma client so the
 * acceptance flow (services/invitation.service.ts) can run the ones it
 * needs inside a single `prisma.$transaction(async (tx) => ...)` — the
 * default parameter is the plain `prisma` client for every other caller
 * that doesn't need transactional atomicity (e.g. the invite-creation
 * duplicate check). Typed as the minimal shape actually used (just
 * `.invitation`) rather than the full `PrismaClient`, because the
 * transaction client Prisma hands to that callback doesn't have
 * `$transaction`/`$connect`/etc. — it would fail to satisfy a
 * `typeof prisma` parameter type, even though its `.invitation` delegate
 * is identical.
 */
type Db = Pick<typeof prisma, "invitation">;

export type PendingInvitation = {
  id: string;
  email: string;
  role: UserRole;
  expiresAt: Date;
  createdAt: Date;
  invitedById: string;
};

const PENDING_INVITATION_SELECT = {
  id: true,
  email: true,
  role: true,
  expiresAt: true,
  createdAt: true,
  invitedById: true,
} as const;

/**
 * Outstanding = not yet accepted AND not yet expired. This is the
 * service-layer half of "one outstanding invitation per email per
 * organization" (see the comment on the Invitation model in
 * schema.prisma) — there is no unique index behind it.
 */
export function findOutstandingInvitation(
  organizationId: string,
  email: string,
  db: Db = prisma,
): Promise<Invitation | null> {
  return db.invitation.findFirst({
    where: {
      organizationId,
      email,
      acceptedAt: null,
      expiresAt: { gt: new Date() },
    },
  });
}

export function listPendingInvitations(organizationId: string): Promise<PendingInvitation[]> {
  return prisma.invitation.findMany({
    where: {
      organizationId,
      acceptedAt: null,
      expiresAt: { gt: new Date() },
    },
    select: PENDING_INVITATION_SELECT,
    orderBy: { createdAt: "asc" },
  });
}

/**
 * Revokes an invitation early (used when a fresh invite replaces an
 * existing outstanding one) by pulling its expiry into the past, rather
 * than deleting the row — keeps a record that it existed without
 * leaving it valid.
 */
export function revokeInvitation(id: string, db: Db = prisma): Promise<Invitation> {
  return db.invitation.update({ where: { id }, data: { expiresAt: new Date(0) } });
}

export interface CreateInvitationInput {
  organizationId: string;
  email: string;
  role: UserRole;
  tokenHash: string;
  expiresAt: Date;
  invitedById: string;
}

export function createInvitationRecord(input: CreateInvitationInput, db: Db = prisma): Promise<Invitation> {
  return db.invitation.create({ data: input });
}

/** Looked up by hash only — the raw token is never persisted or queried by. */
export function findInvitationByTokenHash(tokenHash: string, db: Db = prisma): Promise<Invitation | null> {
  return db.invitation.findUnique({ where: { tokenHash } });
}

export type InvitationWithOrganizationName = Invitation & { organization: { name: string } };

/**
 * Same lookup as findInvitationByTokenHash, plus the organization's
 * display name — used only by the read-only preview endpoint (GET
 * /api/team/invitations/:token) so the frontend can render "You've been
 * invited to join {organizationName}" before the user sets a password.
 */
export function findInvitationWithOrganizationByTokenHash(
  tokenHash: string,
): Promise<InvitationWithOrganizationName | null> {
  return prisma.invitation.findUnique({
    where: { tokenHash },
    include: { organization: { select: { name: true } } },
  });
}

export function markInvitationAccepted(id: string, db: Db = prisma): Promise<Invitation> {
  return db.invitation.update({ where: { id }, data: { acceptedAt: new Date() } });
}
