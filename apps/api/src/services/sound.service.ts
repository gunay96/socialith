import { ERROR_CODES } from "@socialith/types";
import { ApiHttpError } from "../middleware/error-handler.js";
import {
  listSounds,
  findSoundById,
  createSound as createSoundRecord,
  updateSound as updateSoundRecord,
  getSoundUsage,
  type Sound,
  type ListSoundsFilters,
  type ListSoundsResult,
  type CreateSoundInput as RepoCreateSoundInput,
  type UpdateSoundInput,
  type SoundUsage,
} from "../repositories/sound.repository.js";
import type { SafeUser } from "../types/auth.js";

export async function getSounds(actor: SafeUser, filters: ListSoundsFilters): Promise<ListSoundsResult> {
  return listSounds(actor.organizationId, filters);
}

/** Cross-organization `id` resolves as 404, never 403 — same reasoning as every other detail lookup in this codebase. */
export async function getSoundDetail(actor: SafeUser, id: string): Promise<Sound & { usage: SoundUsage }> {
  const sound = await findSoundById(actor.organizationId, id);
  if (!sound) {
    throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, "Sound not found.");
  }
  const usage = await getSoundUsage(id);
  return { ...sound, usage };
}

export async function createSound(
  actor: SafeUser,
  input: Omit<RepoCreateSoundInput, "organizationId" | "createdById">,
): Promise<Sound> {
  return createSoundRecord({ ...input, organizationId: actor.organizationId, createdById: actor.id });
}

export async function updateSound(actor: SafeUser, id: string, input: UpdateSoundInput): Promise<Sound> {
  await getSoundDetail(actor, id); // 404s if not in this organization
  return updateSoundRecord(id, input);
}

/** Same "archive rather than hard-delete" reasoning as UserStatus.REMOVED / SocialAccount disconnect — a Sound can be referenced by real Content history, and Content.soundId's onDelete:SetNull means a hard delete would silently sever that history rather than preserve it. */
export async function archiveSound(actor: SafeUser, id: string): Promise<Sound> {
  await getSoundDetail(actor, id);
  return updateSoundRecord(id, { status: "ARCHIVED" });
}
