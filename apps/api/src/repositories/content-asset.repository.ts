import { prisma } from "@socialith/database";
import type { AssetType, ContentAsset, Platform, Prisma } from "@socialith/database";

export type { ContentAsset };

export interface CreateContentAssetInput {
  contentId: string;
  type: AssetType;
  platform?: Platform | null;
  url: string;
  metadata?: Prisma.InputJsonValue;
}

/**
 * Registers a stable reference to media a later phase's real
 * video-generation/upload pipeline produces — does not upload, store, or
 * validate the file itself (see schema.prisma's ContentAsset comment).
 */
export function createContentAsset(input: CreateContentAssetInput): Promise<ContentAsset> {
  return prisma.contentAsset.create({ data: input });
}
