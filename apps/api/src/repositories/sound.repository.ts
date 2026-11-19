import { prisma } from "@socialith/database";
import type { Platform, Prisma, Sound, SoundStatus } from "@socialith/database";

export type { Sound };

export interface ListSoundsFilters {
  search?: string;
  platform?: Platform;
  artist?: string;
  status?: SoundStatus;
  page: number;
  pageSize: number;
}

export interface ListSoundsResult {
  items: Sound[];
  total: number;
}

/** Always organization-scoped in the query itself — same isolation pattern as every other repository in this codebase. */
export async function listSounds(organizationId: string, filters: ListSoundsFilters): Promise<ListSoundsResult> {
  const where: Prisma.SoundWhereInput = {
    organizationId,
    ...(filters.platform ? { platform: filters.platform } : {}),
    ...(filters.status ? { status: filters.status } : {}),
    // No `mode: "insensitive"` — see campaign.repository.ts's identical
    // comment; MySQL's collation already makes this case-insensitive.
    ...(filters.artist ? { artist: { contains: filters.artist } } : {}),
    ...(filters.search
      ? {
          OR: [
            { title: { contains: filters.search } },
            { artist: { contains: filters.search } },
          ],
        }
      : {}),
  };

  const [items, total] = await Promise.all([
    prisma.sound.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (filters.page - 1) * filters.pageSize,
      take: filters.pageSize,
    }),
    prisma.sound.count({ where }),
  ]);

  return { items, total };
}

/** Cross-organization `id` simply doesn't match — "not found", never "forbidden". */
export function findSoundById(organizationId: string, id: string): Promise<Sound | null> {
  return prisma.sound.findFirst({ where: { id, organizationId } });
}

export interface CreateSoundInput {
  organizationId: string;
  title: string;
  artist?: string | null;
  platform: Platform;
  externalSoundId?: string | null;
  soundUrl?: string | null;
  artworkUrl?: string | null;
  createdById?: string | null;
}

export function createSound(input: CreateSoundInput): Promise<Sound> {
  return prisma.sound.create({ data: input });
}

export interface UpdateSoundInput {
  title?: string;
  artist?: string | null;
  externalSoundId?: string | null;
  soundUrl?: string | null;
  artworkUrl?: string | null;
  status?: SoundStatus;
}

export function updateSound(id: string, input: UpdateSoundInput): Promise<Sound> {
  return prisma.sound.update({ where: { id }, data: input });
}

export interface SoundUsage {
  contentCount: number;
  targetCount: number;
  publishedTargetCount: number;
}

/**
 * How widely this Sound is actually used — the "kaç içerikte / kaç
 * hesaba gönderildi" numbers the Sound detail view and Music/Sounds
 * library need. Three cheap aggregate queries (indexed on
 * Content.soundId and the existing ContentTarget indexes), never an
 * N+1 walk over individual Content/ContentTarget rows.
 */
export async function getSoundUsage(soundId: string): Promise<SoundUsage> {
  const [contentCount, targetCount, publishedTargetCount] = await Promise.all([
    prisma.content.count({ where: { soundId } }),
    prisma.contentTarget.count({ where: { content: { soundId } } }),
    prisma.contentTarget.count({ where: { content: { soundId }, status: "PUBLISHED" } }),
  ]);
  return { contentCount, targetCount, publishedTargetCount };
}
