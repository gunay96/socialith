import { prisma } from "@socialith/database";
import type { Content, ContentStatus, Platform, Prisma } from "@socialith/database";

export type { Content };

export interface ListContentFilters {
  search?: string;
  status?: ContentStatus;
  campaignId?: string;
  soundId?: string;
  platform?: Platform;
  page: number;
  pageSize: number;
}

/**
 * List rows never include `variations`/`assets`/`targets` — this query
 * can return hundreds of content items at once, and eagerly joining each
 * one's (potentially 1000+) targets here would be exactly the "pull
 * everything into memory in one request" mistake this phase is meant to
 * avoid. A `_count.targets` is cheap (one aggregate per row, not N rows).
 */
const LIST_INCLUDE = {
  _count: { select: { targets: true } },
} satisfies Prisma.ContentInclude;

export type ContentListItem = Content & { _count: { targets: number } };

export interface ListContentResult {
  items: ContentListItem[];
  total: number;
}

export async function listContent(organizationId: string, filters: ListContentFilters): Promise<ListContentResult> {
  const where: Prisma.ContentWhereInput = {
    organizationId,
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.campaignId ? { campaignId: filters.campaignId } : {}),
    ...(filters.soundId ? { soundId: filters.soundId } : {}),
    ...(filters.platform ? { targets: { some: { socialAccount: { platform: filters.platform } } } } : {}),
    // No `mode: "insensitive"` — see campaign.repository.ts's identical
    // comment; MySQL's collation already makes this case-insensitive.
    ...(filters.search ? { caption: { contains: filters.search } } : {}),
  };

  const [items, total] = await Promise.all([
    prisma.content.findMany({
      where,
      include: LIST_INCLUDE,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (filters.page - 1) * filters.pageSize,
      take: filters.pageSize,
    }),
    prisma.content.count({ where }),
  ]);

  return { items, total };
}

const DETAIL_INCLUDE = {
  variations: true,
  assets: true,
  sound: true,
  _count: { select: { targets: true } },
} satisfies Prisma.ContentInclude;

export type ContentDetail = Content & {
  variations: Prisma.ContentVariationGetPayload<object>[];
  assets: Prisma.ContentAssetGetPayload<object>[];
  sound: Prisma.SoundGetPayload<object> | null;
  _count: { targets: number };
};

/** Cross-organization `id` simply doesn't match — "not found", never "forbidden". */
export function findContentById(organizationId: string, id: string): Promise<ContentDetail | null> {
  return prisma.content.findFirst({ where: { id, organizationId }, include: DETAIL_INCLUDE });
}

export interface CreateContentInput {
  organizationId: string;
  campaignId?: string | null;
  soundId?: string | null;
  caption?: string | null;
  createdById?: string | null;
}

export function createContent(input: CreateContentInput): Promise<Content> {
  return prisma.content.create({ data: input });
}

export interface UpdateContentInput {
  caption?: string | null;
  campaignId?: string | null;
  soundId?: string | null;
  status?: ContentStatus;
  scheduledAt?: Date | null;
}

/** Optional `db` override so content-target.service.ts's scheduleContent can run this inside one `prisma.$transaction`. */
export function updateContent(
  id: string,
  input: UpdateContentInput,
  db: Pick<typeof prisma, "content"> = prisma,
): Promise<Content> {
  return db.content.update({ where: { id }, data: input });
}

export function deleteContent(id: string): Promise<Content> {
  return prisma.content.delete({ where: { id } });
}
