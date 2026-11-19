import { prisma } from "@socialith/database";
import type { Platform, Prisma, SocialAccount, SocialAccountStatus } from "@socialith/database";

/**
 * Optional Prisma client override so services/social-account.service.ts
 * can run status/connection updates inside one `prisma.$transaction` —
 * same pattern as user.repository.ts/invitation.repository.ts.
 */
type Db = Pick<typeof prisma, "socialAccount">;

/**
 * No restrictive field-select here (unlike team.repository.ts's
 * TEAM_MEMBER_SELECT) — SocialAccount itself holds no credential data by
 * design (see schema.prisma); that's entirely in the separate
 * PlatformConnection table, which this file never touches.
 */
export type { SocialAccount };

export interface ListSocialAccountsFilters {
  search?: string;
  platform?: Platform;
  status?: SocialAccountStatus;
  page: number;
  pageSize: number;
}

export interface ListSocialAccountsResult {
  items: SocialAccount[];
  total: number;
}

/**
 * Always organization-scoped in the query itself (never filtered after
 * the fact) — the same isolation pattern as
 * team.repository.ts's listOrganizationMembers.
 */
export async function listSocialAccounts(
  organizationId: string,
  filters: ListSocialAccountsFilters,
): Promise<ListSocialAccountsResult> {
  const where: Prisma.SocialAccountWhereInput = {
    organizationId,
    ...(filters.platform ? { platform: filters.platform } : {}),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.search
      ? {
          // No `mode: "insensitive"` — see campaign.repository.ts's
          // identical comment; MySQL's collation already makes this
          // case-insensitive.
          OR: [
            { handle: { contains: filters.search } },
            { displayName: { contains: filters.search } },
          ],
        }
      : {}),
  };

  const [items, total] = await Promise.all([
    prisma.socialAccount.findMany({
      where,
      // Stable tie-break (`id`) alongside `createdAt` so pages don't
      // shuffle rows created in the same millisecond across requests —
      // matches the (organizationId, createdAt) index added for this
      // exact query shape.
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (filters.page - 1) * filters.pageSize,
      take: filters.pageSize,
    }),
    prisma.socialAccount.count({ where }),
  ]);

  return { items, total };
}

/**
 * Scoped to `organizationId` in the query itself — a cross-organization
 * `id` simply doesn't match and comes back null, which callers must
 * treat as "not found" (404), never "forbidden" (403) — same reasoning
 * as team.repository.ts's findOrganizationMemberById: a 403 would
 * confirm the ID exists somewhere.
 */
export function findSocialAccountById(organizationId: string, id: string): Promise<SocialAccount | null> {
  return prisma.socialAccount.findFirst({ where: { id, organizationId } });
}

export interface UpdateSocialAccountStatusInput {
  status: SocialAccountStatus;
  lastErrorMessage?: string | null;
}

export function updateSocialAccountStatus(
  id: string,
  input: UpdateSocialAccountStatusInput,
  db: Db = prisma,
): Promise<SocialAccount> {
  return db.socialAccount.update({ where: { id }, data: input });
}

export interface CreateSocialAccountInput {
  organizationId: string;
  platform: Platform;
  externalAccountId: string;
  handle: string;
  displayName: string;
  avatarUrl?: string | null;
  followerCount?: number | null;
  connectedById?: string | null;
  providerMetadata?: Prisma.InputJsonValue;
}

/** Used by packages/database/prisma/seed.ts's dev-only sample data. Real OAuth connect uses upsertSocialAccount below instead. */
export function createSocialAccount(input: CreateSocialAccountInput, db: Db = prisma): Promise<SocialAccount> {
  return db.socialAccount.create({ data: input });
}

export interface UpsertSocialAccountInput {
  organizationId: string;
  platform: Platform;
  externalAccountId: string;
  handle: string;
  displayName: string;
  avatarUrl?: string | null;
  followerCount?: number | null;
  connectedById?: string | null;
  providerMetadata?: Prisma.InputJsonValue;
}

/**
 * Phase 10 real OAuth connect: keyed on the same
 * `(organizationId, platform, externalAccountId)` unique constraint the
 * schema already enforces, so reconnecting an account the org previously
 * connected (and maybe disconnected) updates that same row — status back
 * to CONNECTED, error cleared, fresh profile fields — instead of creating
 * a duplicate SocialAccount. This is the one place `status` is force-set
 * to CONNECTED outside of createSocialAccount's default.
 */
export function upsertSocialAccount(input: UpsertSocialAccountInput, db: Db = prisma): Promise<SocialAccount> {
  const { organizationId, platform, externalAccountId, ...rest } = input;
  return db.socialAccount.upsert({
    where: { organizationId_platform_externalAccountId: { organizationId, platform, externalAccountId } },
    create: { organizationId, platform, externalAccountId, ...rest, status: "CONNECTED" },
    update: { ...rest, status: "CONNECTED", lastErrorMessage: null },
  });
}
