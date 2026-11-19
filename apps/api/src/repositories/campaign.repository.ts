import { prisma } from "@socialith/database";
import type { Campaign, CampaignStatus, Prisma } from "@socialith/database";

export type { Campaign };

export interface ListCampaignsFilters {
  search?: string;
  status?: CampaignStatus;
  page: number;
  pageSize: number;
}

export interface ListCampaignsResult {
  items: Campaign[];
  total: number;
}

/** Always organization-scoped in the query itself — same isolation pattern as every other repository in this codebase. */
export async function listCampaigns(
  organizationId: string,
  filters: ListCampaignsFilters,
): Promise<ListCampaignsResult> {
  const where: Prisma.CampaignWhereInput = {
    organizationId,
    ...(filters.status ? { status: filters.status } : {}),
    // No `mode: "insensitive"` — MySQL's utf8mb4_unicode_ci collation
    // (this schema's default, see the migration) already makes `contains`
    // case-insensitive; Prisma's MySQL connector doesn't expose `mode` at
    // all (Postgres-only option), so this is a real, required removal,
    // not a stylistic one.
    ...(filters.search ? { name: { contains: filters.search } } : {}),
  };

  const [items, total] = await Promise.all([
    prisma.campaign.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (filters.page - 1) * filters.pageSize,
      take: filters.pageSize,
    }),
    prisma.campaign.count({ where }),
  ]);

  return { items, total };
}

/** Cross-organization `id` simply doesn't match — "not found", never "forbidden". */
export function findCampaignById(organizationId: string, id: string): Promise<Campaign | null> {
  return prisma.campaign.findFirst({ where: { id, organizationId } });
}

export interface CreateCampaignInput {
  organizationId: string;
  name: string;
  description?: string | null;
  status?: CampaignStatus;
  startAt?: Date | null;
  endAt?: Date | null;
  createdById?: string | null;
}

export function createCampaign(input: CreateCampaignInput): Promise<Campaign> {
  return prisma.campaign.create({ data: input });
}

export interface UpdateCampaignInput {
  name?: string;
  description?: string | null;
  status?: CampaignStatus;
  startAt?: Date | null;
  endAt?: Date | null;
}

export function updateCampaign(id: string, input: UpdateCampaignInput): Promise<Campaign> {
  return prisma.campaign.update({ where: { id }, data: input });
}
