import { z } from "zod";

const page = z.coerce.number().int().min(1).default(1);
const pageSize = z.coerce.number().int().min(1).max(100).default(25);
const search = z.string().trim().max(100).optional();
const id = z.string().trim().min(1).max(64);

export const listProfilesQuerySchema = z.object({
  page,
  pageSize,
  search,
  status: z.enum(["ACTIVE", "REMOVED"]).optional(),
  mapped: z.enum(["true", "false"]).optional(),
  managedPageId: id.optional(),
});

export const listAccountsQuerySchema = z.object({
  page,
  pageSize,
  search,
  platform: z.string().trim().toLowerCase().regex(/^[a-z_]{2,32}$/).optional(),
  status: z.enum(["CONNECTED", "REAUTH_REQUIRED", "DISCONNECTED"]).optional(),
  mapped: z.enum(["true", "false"]).optional(),
  destination: z.enum(["true", "false"]).optional(),
  profileId: id.optional(),
  creatorId: id.optional(),
});

export const listPublicationsQuerySchema = z.object({
  page,
  pageSize,
  status: z.enum(["PENDING", "PROCESSING", "SCHEDULED_AT_PROVIDER", "COMPLETED", "FAILED", "CANCELLED", "UNKNOWN_OUTCOME"]).optional(),
});

export const profileMappingSchema = z.object({ managedPageId: id.nullable() });
export const accountMappingSchema = z.object({ creatorId: id.nullable() });

const name = z.string().trim().min(1).max(120);
export const managedPageCreateSchema = z.object({
  name,
  slug: z.string().trim().toLowerCase().min(2).max(60).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "slug may only contain lowercase letters, digits and single hyphens").optional(),
  description: z.string().trim().max(2000).nullable().optional(),
});
export const managedPageUpdateSchema = z.object({
  name: name.optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  status: z.enum(["ACTIVE", "ARCHIVED"]).optional(),
});
export const creatorCreateSchema = z.object({ name, notes: z.string().trim().max(2000).nullable().optional() });
export const creatorUpdateSchema = z.object({
  name: name.optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  status: z.enum(["ACTIVE", "ARCHIVED"]).optional(),
});

export const musicQuerySchema = z.object({
  /** Upload-Post profile (internal id) whose TikTok account is used to look music up. */
  profileId: id,
  q: z.string().trim().max(80).optional(),
  genre: z.string().trim().max(40).optional(),
  countryCode: z.string().trim().toUpperCase().length(2).optional(),
  dateRange: z.enum(["1DAY", "7DAY", "30DAY", "90DAY"]).optional(),
});

export const musicMappingCreateSchema = z.object({
  providerMusicId: z.string().trim().min(1).max(64),
  commercialMusicId: z.string().trim().max(64).nullable().optional(),
  providerTitle: z.string().trim().min(1).max(300),
  providerArtist: z.string().trim().max(300).nullable().optional(),
  durationSec: z.number().int().min(0).max(36_000).nullable().optional(),
  previewUrl: z.string().url().max(2000).nullable().optional(),
  coverUrl: z.string().url().max(2000).nullable().optional(),
});
export const musicVerifySchema = z.object({ profileId: id });
export const rightsConfirmSchema = z.object({ confirmed: z.boolean(), note: z.string().trim().max(2000).nullable().optional() });
