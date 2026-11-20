import { prisma } from "@socialith/database";
import { createAuditLog } from "../repositories/audit-log.repository.js";
import type { SafeUser } from "../types/auth.js";
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
