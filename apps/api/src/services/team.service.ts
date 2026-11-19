import type { UserRole } from "@socialith/database";
import { canActOnMember, canAssignRole } from "@socialith/auth";
import { ERROR_CODES } from "@socialith/types";
import { ApiHttpError } from "../middleware/error-handler.js";
import {
  listOrganizationMembers,
  findOrganizationMemberById,
  updateMemberRole,
  updateMemberStatus,
  countOtherActiveOwners,
  type TeamMember,
} from "../repositories/team.repository.js";
import { listPendingInvitations, type PendingInvitation } from "../repositories/invitation.repository.js";
import { createAuditLog } from "../repositories/audit-log.repository.js";
import { toSafeUser } from "./auth.service.js";
import type { SafeUser } from "../types/auth.js";

export interface TeamListing {
  members: TeamMember[];
  pendingInvitations: PendingInvitation[];
}

/**
 * GET /api/team — every authenticated role can view (VIEWER included);
 * only the mutating actions below are gated to ADMIN+.
 */
export async function getTeam(organizationId: string): Promise<TeamListing> {
  const [members, pendingInvitations] = await Promise.all([
    listOrganizationMembers(organizationId),
    listPendingInvitations(organizationId),
  ]);
  return { members, pendingInvitations };
}

/**
 * Loads the target user scoped to the actor's own organization. A
 * userId that belongs to a different organization simply doesn't match
 * and comes back "not found" here — never "forbidden" — so this
 * endpoint can't be used to probe whether a given ID exists in some
 * other tenant.
 */
async function loadTargetOrThrow(organizationId: string, userId: string) {
  const target = await findOrganizationMemberById(organizationId, userId);
  if (!target) {
    throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, "Team member not found.");
  }
  return target;
}

function assertCanActOn(actor: SafeUser, targetRole: UserRole) {
  if (!canActOnMember(actor.role, targetRole)) {
    // Covers "an ADMIN must never be able to modify or remove the
    // OWNER" — canActOnMember only lets an OWNER act on an OWNER target.
    throw new ApiHttpError(403, ERROR_CODES.FORBIDDEN, "You do not have permission to modify this member.");
  }
}

export async function changeMemberRole(
  actor: SafeUser,
  targetUserId: string,
  newRole: UserRole,
): Promise<SafeUser> {
  // An OWNER must not be able to change their own role — checked before
  // the target is even loaded, matching the self-action guard pattern
  // already used by disableMember/removeMember below.
  if (targetUserId === actor.id) {
    throw new ApiHttpError(400, ERROR_CODES.INVALID_REQUEST, "You cannot change your own role.");
  }

  const target = await loadTargetOrThrow(actor.organizationId, targetUserId);
  assertCanActOn(actor, target.role);

  // Last-owner protection: an OWNER role change is only allowed when
  // another active OWNER exists, so the organization can never be left
  // with zero owners. A *disabled* OWNER target doesn't trip this check
  // (see countOtherActiveOwners) — they aren't a functioning owner
  // today, so changing their role doesn't remove one.
  if (target.role === "OWNER" && target.status === "ACTIVE") {
    const otherActiveOwners = await countOtherActiveOwners(actor.organizationId, target.id);
    if (otherActiveOwners === 0) {
      throw new ApiHttpError(
        409,
        ERROR_CODES.CONFLICT,
        "Cannot change the role of the last remaining owner. Promote another member to OWNER first.",
      );
    }
  }

  if (!canAssignRole(actor.role, newRole)) {
    // Covers "an ADMIN must not be able to promote another user to
    // OWNER" — canAssignRole only lets an OWNER hand out the OWNER role.
    throw new ApiHttpError(403, ERROR_CODES.FORBIDDEN, "You do not have permission to assign this role.");
  }

  const previousRole = target.role;
  const updated = await updateMemberRole(target.id, newRole);

  await createAuditLog({
    organizationId: actor.organizationId,
    userId: actor.id,
    action: "USER_ROLE_CHANGED",
    targetType: "User",
    targetId: target.id,
    metadata: { previousRole, newRole },
  });

  return toSafeUser(updated);
}

export async function disableMember(actor: SafeUser, targetUserId: string): Promise<SafeUser> {
  if (targetUserId === actor.id) {
    throw new ApiHttpError(400, ERROR_CODES.INVALID_REQUEST, "You cannot disable your own account.");
  }
  const target = await loadTargetOrThrow(actor.organizationId, targetUserId);
  assertCanActOn(actor, target.role);

  const updated = await updateMemberStatus(target.id, "DISABLED");
  await createAuditLog({
    organizationId: actor.organizationId,
    userId: actor.id,
    action: "USER_DISABLED",
    targetType: "User",
    targetId: target.id,
  });
  return toSafeUser(updated);
}

export async function enableMember(actor: SafeUser, targetUserId: string): Promise<SafeUser> {
  const target = await loadTargetOrThrow(actor.organizationId, targetUserId);
  assertCanActOn(actor, target.role);

  const updated = await updateMemberStatus(target.id, "ACTIVE");
  await createAuditLog({
    organizationId: actor.organizationId,
    userId: actor.id,
    action: "USER_ENABLED",
    targetType: "User",
    targetId: target.id,
  });
  return toSafeUser(updated);
}

/**
 * Soft-remove only — see the UserStatus.REMOVED comment in
 * schema.prisma for why this never issues a hard `prisma.user.delete`.
 */
export async function removeMember(actor: SafeUser, targetUserId: string): Promise<SafeUser> {
  if (targetUserId === actor.id) {
    throw new ApiHttpError(400, ERROR_CODES.INVALID_REQUEST, "You cannot remove your own account.");
  }
  const target = await loadTargetOrThrow(actor.organizationId, targetUserId);
  assertCanActOn(actor, target.role);

  const updated = await updateMemberStatus(target.id, "REMOVED");
  await createAuditLog({
    organizationId: actor.organizationId,
    userId: actor.id,
    action: "USER_REMOVED",
    targetType: "User",
    targetId: target.id,
  });
  return toSafeUser(updated);
}
