import { z } from "zod";
import { PUBLICATION_STATES, isValidTimeZone } from "@socialith/publishing";

const id = z.string().trim().min(1).max(64);
const page = z.coerce.number().int().min(1).default(1);
const pageSize = z.coerce.number().int().min(1).max(100).default(25);
const platform = z.enum(["TIKTOK", "INSTAGRAM", "YOUTUBE"]);
const instant = z.string().trim().min(10).max(40);
const timezone = z.string().trim().min(1).max(64).refine(isValidTimeZone, "must be a valid IANA timezone, e.g. Europe/Istanbul");

/** `?state=SCHEDULED,FAILED` — one or several derived lifecycle states. */
const states = z
  .string()
  .optional()
  .transform((s) => (s ? s.split(",").map((x) => x.trim().toUpperCase()).filter(Boolean) : undefined))
  .pipe(z.array(z.enum(PUBLICATION_STATES)).max(PUBLICATION_STATES.length).optional());

const filterShape = {
  state: states,
  platform: platform.optional(),
  campaignId: id.optional(),
  contentId: id.optional(),
  destinationId: id.optional(),
  creatorId: id.optional(),
  managedPageId: id.optional(),
  artist: z.string().trim().min(1).max(100).optional(),
  search: z.string().trim().min(1).max(100).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  dateField: z.enum(["scheduledAt", "publishedAt", "createdAt"]).optional(),
  owner: z.enum(["SOCIALITH", "PROVIDER"]).optional(),
};

export const overviewQuerySchema = z.object(filterShape);
export const listPublicationsQuerySchema = z.object({ ...filterShape, page, pageSize, sort: z.enum(["scheduledAt_asc", "scheduledAt_desc", "updatedAt_desc"]).optional() });

const MAX_CALENDAR_DAYS = 62;
export const calendarQuerySchema = z
  .object({ ...filterShape, from: z.coerce.date(), to: z.coerce.date() })
  .refine((q) => q.to.getTime() > q.from.getTime(), { message: "to must be after from", path: ["to"] })
  .refine((q) => q.to.getTime() - q.from.getTime() <= MAX_CALENDAR_DAYS * 86_400_000, { message: `the range may cover at most ${MAX_CALENDAR_DAYS} days`, path: ["to"] });

export const destinationsQuerySchema = z.object({
  page,
  pageSize,
  search: z.string().trim().min(1).max(100).optional(),
  platform: platform.optional(),
  provider: z.enum(["NATIVE", "UPLOAD_POST"]).optional(),
  creatorId: id.optional(),
  managedPageId: id.optional(),
  readyOnly: z.enum(["true", "false"]).optional().transform((v) => v === "true"),
});

const text = z.string().max(5000).nullable();
const title = z.string().max(255).nullable();

export const createPublicationsSchema = z.object({
  contentId: id,
  destinations: z
    .array(
      z.object({
        socialAccountId: id,
        captionOverride: text.optional(),
        titleOverride: title.optional(),
        requireMusic: z.boolean().optional(),
        scheduledAt: instant.nullable().optional(),
        timezone: timezone.optional(),
      }),
    )
    .min(1)
    .max(100)
    .refine((d) => new Set(d.map((x) => x.socialAccountId)).size === d.length, "each destination can be listed once"),
});

export const updatePublicationSchema = z
  .object({ captionOverride: text.optional(), titleOverride: title.optional(), requireMusic: z.boolean().optional(), scheduledAt: instant.nullable().optional(), timezone: timezone.optional() })
  .refine((v) => Object.keys(v).length > 0, "nothing to change");

export const scheduleSchema = z.object({ scheduledAt: instant, timezone: timezone.optional() });
export const validateSchema = z.object({ scheduledAt: instant.nullable().optional() });
export const approveSchema = z.object({ note: z.string().trim().max(1000).nullable().optional() });
export const rejectSchema = z.object({ reason: z.string().trim().min(3, "a reason is required").max(1000) });
export const optionalReasonSchema = z.object({ reason: z.string().trim().max(1000).nullable().optional() });

export const settingsSchema = z
  .object({
    timezone: timezone.optional(),
    requireApproval: z.boolean().optional(),
    allowSelfApproval: z.boolean().optional(),
    autoScheduleOnApproval: z.boolean().optional(),
    duplicateGuard: z.enum(["BLOCK", "WARN", "OFF"]).optional(),
    similarityThresholdPct: z.number().int().min(50).max(100).optional(),
    maxSimilarPerPlatform: z.number().int().min(1).max(50).optional(),
    maxPostsPerDestinationPerDay: z.number().int().min(1).max(50).optional(),
    minMinutesBetweenPosts: z.number().int().min(0).max(1440).optional(),
    minLeadMinutes: z.number().int().min(1).max(1440).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "nothing to change");
