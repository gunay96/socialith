import { prisma } from "@socialith/database";
import type { User, UserRole } from "@socialith/database";

/**
 * Optional Prisma client override so invitation acceptance
 * (services/invitation.service.ts) can run these inside a single
 * `prisma.$transaction(async (tx) => ...)`. Typed as the minimal shape
 * actually used (just `.user`) rather than the full `PrismaClient`,
 * because the transaction client Prisma hands to that callback doesn't
 * have `$transaction`/`$connect`/etc. — it would fail to satisfy a
 * `typeof prisma` parameter type, even though its `.user` delegate is
 * identical. Every existing caller keeps working unchanged since this
 * defaults to the plain `prisma` client.
 */
type Db = Pick<typeof prisma, "user">;

export function findUserByEmail(email: string, db: Db = prisma): Promise<User | null> {
  return db.user.findUnique({ where: { email } });
}

export function findUserById(id: string, db: Db = prisma): Promise<User | null> {
  return db.user.findUnique({ where: { id } });
}

export function touchLastLogin(id: string): Promise<User> {
  return prisma.user.update({
    where: { id },
    data: { lastLoginAt: new Date() },
  });
}

export interface CreateUserInput {
  organizationId: string;
  name: string;
  email: string;
  passwordHash: string;
  role: UserRole;
}

/**
 * Used only by invitation acceptance (services/invitation.service.ts),
 * which already validated the email doesn't belong to an existing user
 * before calling this — never called for login/registration, since
 * there is no public registration (spec: "public registration
 * OLMAYACAK").
 */
export function createUser(input: CreateUserInput, db: Db = prisma): Promise<User> {
  return db.user.create({
    data: { ...input, status: "ACTIVE" },
  });
}

export interface ReactivateUserInput {
  name: string;
  passwordHash: string;
  role: UserRole;
}

/**
 * Used only when accepting a fresh invitation for an email that
 * belongs to a previously REMOVED user in the *same* organization —
 * rather than trying to create a second User row with the same email
 * (blocked by the unique constraint), this reactivates the existing
 * row in place. See the UserStatus.REMOVED comment in schema.prisma.
 */
export function reactivateUser(id: string, input: ReactivateUserInput, db: Db = prisma): Promise<User> {
  return db.user.update({
    where: { id },
    data: { ...input, status: "ACTIVE" },
  });
}

/**
 * Used by password reset (services/password-reset.service.ts). Bumps
 * `sessionVersion` in the *same* update as the password change — using
 * Prisma's atomic `increment` rather than read-then-write — so every
 * session issued before this moment fails its next `requireAuth` check
 * (see middleware/auth.ts) without a separate write or a race between
 * reading the old value and writing the new one.
 */
export function updatePasswordAndInvalidateSessions(
  userId: string,
  passwordHash: string,
  db: Db = prisma,
): Promise<User> {
  return db.user.update({
    where: { id: userId },
    data: { passwordHash, sessionVersion: { increment: 1 } },
  });
}
