import { ERROR_CODES } from "@socialith/types";
import { ApiHttpError } from "../middleware/error-handler.js";
import {
  listContent,
  findContentById,
  createContent as createContentRecord,
  updateContent as updateContentRecord,
  deleteContent as deleteContentRecord,
  type ContentDetail,
  type ContentListItem,
  type ListContentFilters,
} from "../repositories/content.repository.js";
import { findCampaignById } from "../repositories/campaign.repository.js";
import { findSoundById } from "../repositories/sound.repository.js";
import { upsertContentVariation, type ContentVariation } from "../repositories/content-variation.repository.js";
import { createContentAsset, type ContentAsset } from "../repositories/content-asset.repository.js";
import type { CreateContentInput } from "../validation/content.validation.js";
import type { SafeUser } from "../types/auth.js";
import type { AssetType, ContentStatus, Platform, Prisma } from "@socialith/database";

export async function getContentList(
  actor: SafeUser,
  filters: ListContentFilters,
): Promise<{ items: ContentListItem[]; total: number }> {
  return listContent(actor.organizationId, filters);
}

/** Cross-organization `id` resolves as 404, never 403. */
export async function getContentDetail(actor: SafeUser, id: string): Promise<ContentDetail> {
  const content = await findContentById(actor.organizationId, id);
  if (!content) {
    throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, "Content not found.");
  }
  return content;
}

/**
 * If `campaignId` is given, it must belong to the actor's own
 * organization — without this check, a client could attach content to
 * (and thereby have it surfaced through) another organization's
 * campaign by guessing/enumerating IDs.
 */
async function assertCampaignInOrg(organizationId: string, campaignId: string | undefined | null): Promise<void> {
  if (!campaignId) return;
  const campaign = await findCampaignById(organizationId, campaignId);
  if (!campaign) {
    throw new ApiHttpError(400, ERROR_CODES.INVALID_REQUEST, "campaignId does not exist in this organization.");
  }
}

/** Phase 09: same reasoning as assertCampaignInOrg — without this check a client could attach content to another organization's Sound library entry by guessing/enumerating IDs. */
async function assertSoundInOrg(organizationId: string, soundId: string | undefined | null): Promise<void> {
  if (!soundId) return;
  const sound = await findSoundById(organizationId, soundId);
  if (!sound) {
    throw new ApiHttpError(400, ERROR_CODES.INVALID_REQUEST, "soundId does not exist in this organization.");
  }
}

export async function createContent(actor: SafeUser, input: CreateContentInput) {
  await assertCampaignInOrg(actor.organizationId, input.campaignId);
  await assertSoundInOrg(actor.organizationId, input.soundId);
  return createContentRecord({
    organizationId: actor.organizationId,
    campaignId: input.campaignId ?? null,
    soundId: input.soundId ?? null,
    caption: input.caption ?? null,
    createdById: actor.id,
  });
}

export interface UpdateContentServiceInput {
  caption?: string | null;
  campaignId?: string | null;
  soundId?: string | null;
  status?: ContentStatus;
}

export async function updateContent(actor: SafeUser, id: string, input: UpdateContentServiceInput) {
  await getContentDetail(actor, id); // 404s if not in this organization
  if (input.campaignId) {
    await assertCampaignInOrg(actor.organizationId, input.campaignId);
  }
  if (input.soundId) {
    await assertSoundInOrg(actor.organizationId, input.soundId);
  }
  return updateContentRecord(id, input);
}

/**
 * Only DRAFT content can be deleted — anything past that has real
 * targeting/scheduling history worth keeping (same "never destroy
 * history" reasoning as UserStatus.REMOVED / SocialAccount disconnect;
 * DRAFT content has none yet, so a hard delete here destroys nothing).
 */
export async function deleteContent(actor: SafeUser, id: string): Promise<void> {
  const content = await getContentDetail(actor, id);
  if (content.status !== "DRAFT") {
    throw new ApiHttpError(409, ERROR_CODES.CONFLICT, "Only draft content can be deleted.");
  }
  await deleteContentRecord(id);
}

export interface UpsertVariationServiceInput {
  title?: string | null;
  caption?: string | null;
  // Typed as the shape zod's z.record(z.unknown()) actually produces —
  // cast to Prisma.InputJsonValue at the repository call site below,
  // same pattern as audit-log.repository.ts's sanitizeMetadata (TS can't
  // structurally prove an arbitrary Record<string, unknown> is
  // JSON-safe, even though zod already validated it came from
  // JSON.parse'd request body).
  metadata?: Record<string, unknown>;
}

export async function upsertVariation(
  actor: SafeUser,
  contentId: string,
  platform: Platform,
  input: UpsertVariationServiceInput,
): Promise<ContentVariation> {
  await getContentDetail(actor, contentId); // 404s if not in this organization
  return upsertContentVariation({
    contentId,
    platform,
    ...input,
    metadata: input.metadata as unknown as Prisma.InputJsonValue | undefined,
  });
}

export interface CreateAssetServiceInput {
  type: AssetType;
  platform?: Platform | null;
  url: string;
  metadata?: Record<string, unknown>;
}

export async function createAsset(
  actor: SafeUser,
  contentId: string,
  input: CreateAssetServiceInput,
): Promise<ContentAsset> {
  await getContentDetail(actor, contentId); // 404s if not in this organization
  return createContentAsset({
    contentId,
    ...input,
    metadata: input.metadata as unknown as Prisma.InputJsonValue | undefined,
  });
}
