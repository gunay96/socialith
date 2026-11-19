import { prisma } from "@socialith/database";
import type { PasswordResetToken } from "@socialith/database";

/**
 * Optional Prisma client override so resetPassword
 * (services/password-reset.service.ts) can run these inside a single
 * `prisma.$transaction(async (tx) => ...)` — same pattern as
 * invitation.repository.ts. Typed as the minimal shape actually used
 * (just `.passwordResetToken`) rather than the full `PrismaClient`,
 * because the transaction client Prisma hands to that callback doesn't
 * have `$transaction`/`$connect`/etc.
 */
type Db = Pick<typeof prisma, "passwordResetToken">;

export interface CreatePasswordResetTokenInput {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
}

export function createPasswordResetToken(
  input: CreatePasswordResetTokenInput,
  db: Db = prisma,
): Promise<PasswordResetToken> {
  return db.passwordResetToken.create({ data: input });
}

/** Looked up by hash only — the raw token is never persisted or queried by. */
export function findPasswordResetTokenByHash(tokenHash: string, db: Db = prisma): Promise<PasswordResetToken | null> {
  return db.passwordResetToken.findUnique({ where: { tokenHash } });
}

export function markPasswordResetTokenUsed(id: string, db: Db = prisma): Promise<PasswordResetToken> {
  return db.passwordResetToken.update({ where: { id }, data: { usedAt: new Date() } });
}
