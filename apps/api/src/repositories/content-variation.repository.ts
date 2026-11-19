import { prisma } from "@socialith/database";
import type { ContentVariation, Platform, Prisma } from "@socialith/database";

export type { ContentVariation };

export interface UpsertContentVariationInput {
  contentId: string;
  platform: Platform;
  title?: string | null;
  caption?: string | null;
  metadata?: Prisma.InputJsonValue;
}

/**
 * Create-or-replace by (contentId, platform) — matches the PUT semantics
 * of PUT /api/content/:id/variations/:platform (idempotent: sending the
 * same variation twice produces the same row, not a duplicate).
 */
export function upsertContentVariation(input: UpsertContentVariationInput): Promise<ContentVariation> {
  const { contentId, platform, ...data } = input;
  return prisma.contentVariation.upsert({
    where: { contentId_platform: { contentId, platform } },
    update: data,
    create: { contentId, platform, ...data },
  });
}
