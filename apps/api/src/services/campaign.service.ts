import { ERROR_CODES } from "@socialith/types";
import { ApiHttpError } from "../middleware/error-handler.js";
import {
  listCampaigns,
  findCampaignById,
  createCampaign as createCampaignRecord,
  updateCampaign as updateCampaignRecord,
  type Campaign,
  type ListCampaignsFilters,
  type ListCampaignsResult,
  type CreateCampaignInput as RepoCreateCampaignInput,
  type UpdateCampaignInput as RepoUpdateCampaignInput,
} from "../repositories/campaign.repository.js";
import type { SafeUser } from "../types/auth.js";

export async function getCampaigns(actor: SafeUser, filters: ListCampaignsFilters): Promise<ListCampaignsResult> {
  return listCampaigns(actor.organizationId, filters);
}

/** Cross-organization `id` resolves as 404, never 403 — same reasoning as every other detail lookup in this codebase. */
export async function getCampaignDetail(actor: SafeUser, id: string): Promise<Campaign> {
  const campaign = await findCampaignById(actor.organizationId, id);
  if (!campaign) {
    throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, "Campaign not found.");
  }
  return campaign;
}

export async function createCampaign(
  actor: SafeUser,
  input: Omit<RepoCreateCampaignInput, "organizationId" | "createdById">,
): Promise<Campaign> {
  return createCampaignRecord({ ...input, organizationId: actor.organizationId, createdById: actor.id });
}

export async function updateCampaign(actor: SafeUser, id: string, input: RepoUpdateCampaignInput): Promise<Campaign> {
  // Loads (and 404s) scoped to the actor's organization before writing —
  // never trusts `id` alone, so this can't be used to edit another
  // organization's campaign even though `updateCampaign`'s WHERE is just
  // `{ id }`.
  await getCampaignDetail(actor, id);
  return updateCampaignRecord(id, input);
}
