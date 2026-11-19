import type { PrismaClient } from "@socialith/database";
import { hashPassword } from "@socialith/auth";
import { withUpsertRaceRetry } from "../lib/db-retry.js";
import type { ValidatedOwnerInput } from "../validation/bootstrap-owner.validation.js";

/**
 * One-time production owner initialization (TD-32).
 *
 * Invariants this module enforces (all proven by the real-MySQL
 * integration tests in src/integration/bootstrap-owner.integration.test.ts):
 *
 *  - It only ever creates into an EMPTY user table. Any existing user
 *    (including the development seed owner) makes it refuse; it never
 *    adds a second owner and never modifies an existing account.
 *  - Two concurrent invocations cannot both succeed. The check-and-insert
 *    runs in ONE SERIALIZABLE transaction, so InnoDB itself guarantees the
 *    outcome is equivalent to running them one after the other: both
 *    readers take a shared lock on the empty `users` range, both inserts
 *    then wait for each other, InnoDB aborts one as a deadlock victim
 *    (Prisma P2034), the helper retries it, and the retry sees the
 *    winner's row and refuses.
 *    This is deliberately NOT a GET_LOCK scheme: a named lock is session
 *    scoped and gets released before the transaction commits, and the real
 *    concurrency test caught exactly that creating two owners on MySQL 8.0.
 *  - The password is hashed with the same scrypt implementation as every
 *    real login/invitation/reset path (@socialith/auth) before it ever
 *    reaches the database, and is never logged or put in audit metadata.
 *  - Organization + owner + audit row are written atomically.
 *  - It never creates social accounts, campaigns, content or any demo row.
 */

export type BootstrapRefusalCode = "NOT_EMPTY" | "SEED_DATA_PRESENT" | "SLUG_TAKEN" | "SCHEMA_NOT_READY";

export class BootstrapOwnerError extends Error {
  constructor(
    public readonly code: BootstrapRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = "BootstrapOwnerError";
  }
}

export interface BootstrapOwnerResult {
  /** "created": a new owner now exists. "already-initialized": the identical owner already existed; nothing was changed (password untouched). */
  status: "created" | "already-initialized";
  organizationId: string;
  userId: string;
  email: string;
}

export const SEED_ORGANIZATION_SLUG = "socialith-internal";
export const SEED_EMAIL_SUFFIX = "@socialith.local";

function isMissingTable(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "P2021" || code === "P2022";
}

export async function bootstrapOwner(
  db: PrismaClient,
  input: ValidatedOwnerInput,
  options: { hash?: (password: string) => Promise<string>; retryAttempts?: number } = {},
): Promise<BootstrapOwnerResult> {
  // Hash outside the transaction (CPU-bound, ~tens of ms) so the
  // transaction stays short and holds its locks as briefly as possible.
  const passwordHash = await (options.hash ?? hashPassword)(input.password);

  try {
    return await withUpsertRaceRetry(
      () =>
        db.$transaction(
          async (tx) => {
            const users = await tx.user.findMany({
              select: { id: true, email: true, role: true, status: true, organizationId: true },
              take: 2,
            });

            if (users.length === 1) {
              const only = users[0]!;
              if (only.email === input.email && only.role === "OWNER" && only.status === "ACTIVE") {
                return {
                  status: "already-initialized" as const,
                  organizationId: only.organizationId,
                  userId: only.id,
                  email: only.email,
                };
              }
            }

            if (users.length > 0) {
              const seed = await tx.user.findFirst({ where: { email: { endsWith: SEED_EMAIL_SUFFIX } }, select: { id: true } });
              const seedOrg = await tx.organization.findUnique({ where: { slug: SEED_ORGANIZATION_SLUG }, select: { id: true } });
              if (seed || seedOrg) {
                throw new BootstrapOwnerError(
                  "SEED_DATA_PRESENT",
                  "This database contains development seed data. A production database must start empty. Nothing was changed.",
                );
              }
              throw new BootstrapOwnerError(
                "NOT_EMPTY",
                "This database already has user accounts, so no further owner can be bootstrapped (create additional users by invitation from the app). Nothing was changed.",
              );
            }

            const slugTaken = await tx.organization.findUnique({ where: { slug: input.organizationSlug }, select: { id: true } });
            if (slugTaken) {
              throw new BootstrapOwnerError(
                "SLUG_TAKEN",
                `An organization with slug "${input.organizationSlug}" already exists but has no users. Refusing to guess; inspect the database. Nothing was changed.`,
              );
            }

            const organization = await tx.organization.create({
              data: { name: input.organizationName, slug: input.organizationSlug },
            });
            const owner = await tx.user.create({
              data: {
                organizationId: organization.id,
                name: input.name,
                email: input.email,
                passwordHash,
                role: "OWNER",
                status: "ACTIVE",
              },
            });
            await tx.auditLog.create({
              data: {
                organizationId: organization.id,
                userId: owner.id,
                action: "OWNER_BOOTSTRAPPED",
                targetType: "User",
                targetId: owner.id,
                metadataJson: { via: "cli", ownerEmail: owner.email },
              },
            });

            return {
              status: "created" as const,
              organizationId: organization.id,
              userId: owner.id,
              email: owner.email,
            };
          },
          { isolationLevel: "Serializable", timeout: 30_000, maxWait: 10_000 },
        ),
      { attempts: options.retryAttempts ?? 8 },
    );
  } catch (err) {
    if (err instanceof BootstrapOwnerError) throw err;
    if (isMissingTable(err)) {
      throw new BootstrapOwnerError(
        "SCHEMA_NOT_READY",
        "The database schema is not present. Run the migrations first (docker compose up migrate). Nothing was changed.",
      );
    }
    throw err;
  }
}
