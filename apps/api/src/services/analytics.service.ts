import { getMetricsRollupForTargets, type MetricsRollup } from "../repositories/analytics.repository.js";
import {
  listTargetIdsForContent,
  listTargetIdsForCampaign,
  listTargetIdsForSound,
  listTargetIdsForAccount,
} from "../repositories/content-target.repository.js";
import { getContentDetail } from "./content.service.js";
import { getCampaignDetail } from "./campaign.service.js";
import { getSoundDetail } from "./sound.service.js";
import { getAccountDetail } from "./social-account.service.js";
import type { SafeUser } from "../types/auth.js";

/**
 * Four rollup entry points, one per dimension the spec calls out by name
 * ("içerik bazında / hesap bazında / campaign bazında / Sound bazında
 * performans"). Each first loads its scoping entity through that
 * entity's own existing, already-organization-scoped detail lookup —
 * this is both the 404-vs-403 isolation check and the "does this even
 * exist" check in one call, exactly like every other cross-entity
 * reference in this codebase (assertCampaignInOrg, assertSoundInOrg).
 */

export async function getContentMetrics(actor: SafeUser, contentId: string): Promise<MetricsRollup> {
  await getContentDetail(actor, contentId);
  const targetIds = await listTargetIdsForContent(contentId);
  return getMetricsRollupForTargets(targetIds);
}

export async function getCampaignMetrics(actor: SafeUser, campaignId: string): Promise<MetricsRollup> {
  await getCampaignDetail(actor, campaignId);
  const targetIds = await listTargetIdsForCampaign(campaignId);
  return getMetricsRollupForTargets(targetIds);
}

export async function getSoundMetrics(actor: SafeUser, soundId: string): Promise<MetricsRollup> {
  await getSoundDetail(actor, soundId);
  const targetIds = await listTargetIdsForSound(soundId);
  return getMetricsRollupForTargets(targetIds);
}

export async function getAccountMetrics(actor: SafeUser, socialAccountId: string): Promise<MetricsRollup> {
  await getAccountDetail(actor, socialAccountId);
  const targetIds = await listTargetIdsForAccount(socialAccountId);
  return getMetricsRollupForTargets(targetIds);
}
