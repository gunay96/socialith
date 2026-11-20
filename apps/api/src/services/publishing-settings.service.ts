import { prisma } from "@socialith/database";
import { createAuditLog } from "../repositories/audit-log.repository.js";
import type { SafeUser } from "../types/auth.js";
import { ERROR_CODES } from "@socialith/types";
import { ApiHttpError } from "../middleware/error-handler.js";
import { getEffectiveSettings, type EffectiveSettings } from "./publishing-common.js";

export async function getSettings(actor: SafeUser): Promise<EffectiveSettings & { recommendation: string | null }> {
  const s = await getEffectiveSettings(actor.organizationId);
  return {
    ...s,
    recommendation: s.source === "default" ? "Approval is not required yet (nothing changes for existing content). Save these settings with \"Require approval\" on so that every destination must be approved before it can be scheduled." : null,
  };
}

export type SettingsInput = Partial<Omit<EffectiveSettings, "source">>;

export async function updateSettings(actor: SafeUser, input: SettingsInput): Promise<EffectiveSettings> {
  const before = await getEffectiveSettings(actor.organizationId);
  // the first save materializes the row with the CURRENT effective values, then applies the change
  const merged = { ...before, ...input };
  const data = {
    timezone: merged.timezone,
    requireApproval: merged.requireApproval,
    allowSelfApproval: merged.allowSelfApproval,
    autoScheduleOnApproval: merged.autoScheduleOnApproval,
    duplicateGuard: merged.duplicateGuard,
    similarityThresholdPct: merged.similarityThresholdPct,
    maxSimilarPerPlatform: merged.maxSimilarPerPlatform,
    maxPostsPerDestinationPerDay: merged.maxPostsPerDestinationPerDay,
    minMinutesBetweenPosts: merged.minMinutesBetweenPosts,
    minLeadMinutes: merged.minLeadMinutes,
  };
  await prisma.publishingSettings.upsert({ where: { organizationId: actor.organizationId }, update: data, create: { organizationId: actor.organizationId, ...data } });
  const changed = Object.keys(input).filter((k) => (before as unknown as Record<string, unknown>)[k] !== (input as Record<string, unknown>)[k]);
  await createAuditLog({ organizationId: actor.organizationId, userId: actor.id, action: "PUBLISHING_SETTINGS_CHANGED", targetType: "PublishingSettings", metadata: { changed, requireApproval: data.requireApproval } });
  return getEffectiveSettings(actor.organizationId);
}

/** Campaigns with their automatic-scheduling setting (null = inherit the organization setting). */
export async function listCampaignSettings(actor: SafeUser) {
  const org = await getEffectiveSettings(actor.organizationId);
  const campaigns = await prisma.campaign.findMany({ where: { organizationId: actor.organizationId }, select: { id: true, name: true, status: true, autoScheduleOnApproval: true }, orderBy: [{ createdAt: "desc" }], take: 200 });
  return { organizationDefault: org.autoScheduleOnApproval, items: campaigns.map((c) => ({ ...c, effective: c.autoScheduleOnApproval ?? org.autoScheduleOnApproval })) };
}

/** Admin-only: it is a policy ("schedule automatically once approved"), not a content edit. */
export async function setCampaignAutoSchedule(actor: SafeUser, campaignId: string, value: boolean | null) {
  const campaign = await prisma.campaign.findFirst({ where: { id: campaignId, organizationId: actor.organizationId }, select: { id: true, autoScheduleOnApproval: true } });
  if (!campaign) throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, "Campaign not found.");
  await prisma.campaign.update({ where: { id: campaignId }, data: { autoScheduleOnApproval: value } });
  await createAuditLog({ organizationId: actor.organizationId, userId: actor.id, action: "PUBLISHING_SETTINGS_CHANGED", targetType: "Campaign", targetId: campaignId, metadata: { autoScheduleOnApproval: value, previous: campaign.autoScheduleOnApproval } });
  return listCampaignSettings(actor);
}