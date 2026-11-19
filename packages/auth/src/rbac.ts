/**
 * Mirrors the `UserRole` enum in packages/database/prisma/schema.prisma.
 * Duplicated as a plain string union (rather than importing
 * @socialith/database) so this package stays framework/DB-free and its
 * rules can be unit tested with zero setup.
 */
export type Role = "OWNER" | "ADMIN" | "EDITOR" | "VIEWER";

const ROLE_RANK: Record<Role, number> = {
  VIEWER: 0,
  EDITOR: 1,
  ADMIN: 2,
  OWNER: 3,
};

/** True if `role` is at least as privileged as `minimumRole`. */
export function hasMinimumRole(role: Role, minimumRole: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimumRole];
}

/** OWNER and ADMIN can manage team membership (spec §4: "Admin/Owner için"). */
export function canManageTeam(actorRole: Role): boolean {
  return hasMinimumRole(actorRole, "ADMIN");
}

/**
 * Only an OWNER can grant the OWNER role to someone (including keeping it
 * on invite) — an ADMIN can promote/demote between ADMIN/EDITOR/VIEWER but
 * can never mint another OWNER.
 */
export function canAssignRole(actorRole: Role, targetRole: Role): boolean {
  if (targetRole === "OWNER") return actorRole === "OWNER";
  return canManageTeam(actorRole);
}

/**
 * Guards role changes / disable / enable / removal targeting an existing
 * member: an ADMIN can act on ADMIN/EDITOR/VIEWER members but never on an
 * OWNER. An OWNER can act on anyone (including other owners).
 */
export function canActOnMember(actorRole: Role, targetRole: Role): boolean {
  if (targetRole === "OWNER") return actorRole === "OWNER";
  return canManageTeam(actorRole);
}
