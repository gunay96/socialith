import { z } from "zod";

const id = z.string().trim().min(1).max(64);
const page = z.coerce.number().int().min(1).default(1);
const bool = z.enum(["true", "false"]).transform((v) => v === "true");

export const listAssetsQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  kind: z.enum(["VIDEO", "IMAGE", "AUDIO", "TEXT", "SPREADSHEET"]).optional(),
  status: z.enum(["READY", "ANALYZING", "FAILED", "REJECTED", "DUPLICATE", "ARCHIVED", "ACTIVE", "ALL"]).default("ACTIVE"),
  packId: id.optional(),
  tag: z.string().trim().max(64).optional(),
  campaignId: id.optional(),
  pageGroupId: id.optional(),
  orientation: z.enum(["portrait", "landscape", "square"]).optional(),
  aspect: z.string().trim().max(16).optional(),
  minDurationMs: z.coerce.number().int().min(0).optional(),
  maxDurationMs: z.coerce.number().int().min(0).optional(),
  minWidth: z.coerce.number().int().min(0).optional(),
  hasAudio: bool.optional(),
  rights: z.enum(["UNVERIFIED", "CONFIRMED", "RESTRICTED"]).optional(),
  sort: z.enum(["newest", "oldest", "name", "size", "duration"]).default("newest"),
  page,
  pageSize: z.coerce.number().int().min(1).max(100).default(40),
});

export const listPacksQuerySchema = z.object({
  status: z.enum(["PROCESSING", "READY", "PARTIAL", "FAILED", "ARCHIVED", "ACTIVE", "ALL"]).default("ACTIVE"),
  search: z.string().trim().max(120).optional(),
  page,
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

const tag = z.string().trim().min(1).max(64);
export const tagsSchema = z.object({ tags: z.array(tag).max(30) });
export const bulkTagsSchema = z
  .object({ assetIds: z.array(id).min(1).max(200), add: z.array(tag).max(30).default([]), remove: z.array(tag).max(30).default([]) })
  .refine((v) => v.add.length + v.remove.length > 0, "provide tags to add or remove");
export const notesSchema = z.object({ notes: z.string().trim().max(4000).nullable().transform((v) => (v === "" ? null : v)) });
export const rightsSchema = z.object({ status: z.enum(["UNVERIFIED", "CONFIRMED", "RESTRICTED"]), notes: z.string().trim().max(2000).nullable().optional().transform((v) => (v === "" || v === undefined ? null : v)) });
export const campaignIdsSchema = z.object({ campaignIds: z.array(id).max(100) });
export const pageGroupIdsSchema = z.object({ groupIds: z.array(id).max(100) });
export const packUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(2000).nullable().optional().transform((v) => (v === "" ? null : v)),
});

export const listTasksQuerySchema = z.object({
  state: z.enum(["active", "finished", "all"]).default("active"),
  type: z.string().trim().max(40).optional(),
  subjectType: z.string().trim().max(40).optional(),
  subjectId: id.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
