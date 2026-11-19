import { z } from "zod";

export const platformSchema = z.enum(["TIKTOK", "INSTAGRAM", "YOUTUBE"]);
export const socialAccountStatusSchema = z.enum(["CONNECTED", "DISCONNECTED", "EXPIRED", "ERROR"]);

/**
 * Parses GET /api/accounts's query string. Every field is optional except
 * the page/pageSize defaults — `page`/`pageSize` arrive as strings from
 * req.query, hence z.coerce.number(). pageSize is capped at 1000 — the
 * same cap as content-target.validation.ts's bulk-assign account-id list
 * — rather than a smaller UI-page-sized limit, because Phase 05's
 * target-account picker (apps/web's content detail page) legitimately
 * needs to fetch up to "1000+ accounts" worth of candidates in one
 * request to build a bulk assignment, not one page-of-25 at a time.
 */
export const listSocialAccountsQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  platform: platformSchema.optional(),
  status: socialAccountStatusSchema.optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(1000).default(25),
});
export type ListSocialAccountsQuery = z.infer<typeof listSocialAccountsQuerySchema>;
