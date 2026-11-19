import { z } from "zod";
import { platformSchema } from "./social-account.validation.js";

export const soundStatusSchema = z.enum(["ACTIVE", "ARCHIVED"]);

/**
 * pageSize is capped at 1000, not 100 — the Content detail page's Sound
 * picker (apps/web's SoundSection) fetches up to 1000 sounds in one
 * request to populate a <select>, the same "bulk picker, not a paginated
 * list" reasoning apps/api/src/validation/social-account.validation.ts
 * documents for the exact same cap (found via a real 400 in the browser
 * console, same way that one was originally found in Phase 05).
 */
export const listSoundsQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  platform: platformSchema.optional(),
  artist: z.string().trim().max(200).optional(),
  status: soundStatusSchema.optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(1000).default(25),
});
export type ListSoundsQuery = z.infer<typeof listSoundsQuerySchema>;

export const createSoundSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(300),
  artist: z.string().trim().max(300).optional(),
  platform: platformSchema,
  externalSoundId: z.string().trim().max(200).optional(),
  soundUrl: z.string().trim().url().max(2000).optional(),
  artworkUrl: z.string().trim().url().max(2000).optional(),
});
export type CreateSoundInput = z.infer<typeof createSoundSchema>;

export const updateSoundSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  artist: z.string().trim().max(300).nullable().optional(),
  externalSoundId: z.string().trim().max(200).nullable().optional(),
  soundUrl: z.string().trim().url().max(2000).nullable().optional(),
  artworkUrl: z.string().trim().url().max(2000).nullable().optional(),
  status: soundStatusSchema.optional(),
});
export type UpdateSoundInput = z.infer<typeof updateSoundSchema>;
