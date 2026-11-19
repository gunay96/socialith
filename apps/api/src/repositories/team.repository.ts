import { prisma } from "@socialith/database";
import type { User, UserRole, UserStatus } from "@socialith/database";

/**
 * The exact fields spec §2 allows GET /api/team to return — selected at
 * the query level (not filtered after the fact), so a future column
 * added to `users` doesn't accidentally leak into this response just
 * because someone forgot to update a mapper function.
 */
const TEAM_MEMBER_SELECT = {
  id: true,
  name: true,
  email: true,
  role: true,
  status: true,
  lastLoginAt: true,
  createdAt: true,
} as const;

export type TeamMember = {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  status: UserStatus;
  lastLoginAt: Date | null;
  createdAt: Date;
};

/**
 * REMOVED members are excluded — soft-removed means "no longer on the
 * team", so they shouldn't reappear in this list (unlike DISABLED, which
 * stays visible so an admin can see and re-enable it).
 */
export function listOrganizationMembers(organizationId: string): Promise<TeamMember[]> {
  return prisma.user.findMany({
    where: { organizationId, status: { not: "REMOVED" } },
    select: TEAM_MEMBER_SELECT,
    orderBy: { createdAt: "asc" },
  });
}

/**
 * Scoped to `organizationId` in the query itself — never fetch by ID
 * alone and check the organization after the fact. A user ID from
 * another organization simply doesn't match this WHERE clause and comes
 * back null, which callers should treat as "not found", not "forbidden"
 * (see docs/architecture.md "Organization isolation").
 */
export function findOrganizationMemberById(organizationId: string, userId: string): Promise<User | null> {
  return prisma.user.findFirst({ where: { id: userId, organizationId } });
}

export function updateMemberRole(userId: string, role: UserRole): Promise<User> {
  return prisma.user.update({ where: { id: userId }, data: { role } });
}

export function updateMemberStatus(
  userId: string,
  status: "ACTIVE" | "DISABLED" | "REMOVED",
): Promise<User> {
  return prisma.user.update({ where: { id: userId }, data: { status } });
}

/**
 * Counts ACTIVE OWNERs in the organization, excluding `excludeUserId` —
 * used by changeMemberRole's last-owner safeguard. Excluding the target
 * themselves (rather than counting all active owners and subtracting 1)
 * means a *disabled* OWNER's role change is never blocked by this check:
 * a disabled owner isn't a functioning owner today, so changing their
 * role doesn't reduce the count of owners who can actually act.
 */
export function countOtherActiveOwners(organizationId: string, excludeUserId: string): Promise<number> {
  return prisma.user.count({
    where: { organizationId, role: "OWNER", status: "ACTIVE", id: { not: excludeUserId } },
  });
}
