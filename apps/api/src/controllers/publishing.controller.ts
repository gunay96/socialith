import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { ZodTypeAny, z } from "zod";
import { ERROR_CODES, type ApiResponse } from "@socialith/types";
import { ApiHttpError } from "../middleware/error-handler.js";
import * as read from "../services/publishing-read.service.js";
import * as workflow from "../services/publishing-workflow.service.js";
import * as settings from "../services/publishing-settings.service.js";
import * as schema from "../validation/publishing.validation.js";

type Result = { status?: number; data: unknown };

function wrap(fn: (req: Request) => Promise<Result>): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await fn(req);
      const body: ApiResponse<unknown> = { success: true, data: result.data };
      res.status(result.status ?? 200).json(body);
    } catch (err) {
      next(err);
    }
  };
}

function parse<S extends ZodTypeAny>(s: S, input: unknown, what = "request"): z.infer<S> {
  const parsed = s.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ApiHttpError(400, ERROR_CODES.INVALID_REQUEST, `Invalid ${what}${first ? `: ${first.path.join(".") || "input"} ${first.message}` : "."}`);
  }
  return parsed.data;
}
const user = (req: Request) => req.user!;
const idParam = (req: Request) => req.params.id!;

/** query `state` → the service's `states` */
function filters<T extends { state?: unknown }>(q: T): Omit<T, "state"> & { states: T["state"] } {
  const { state, ...rest } = q;
  return { ...rest, states: state };
}

export const getOverview: RequestHandler = wrap(async (req) => ({ data: await read.getOverview(user(req), filters(parse(schema.overviewQuerySchema, req.query, "query")) as read.PublicationFilters) }));
export const listPublications: RequestHandler = wrap(async (req) => ({ data: await read.listPublications(user(req), filters(parse(schema.listPublicationsQuerySchema, req.query, "query")) as never) }));
export const getCalendar: RequestHandler = wrap(async (req) => ({ data: await read.getCalendar(user(req), filters(parse(schema.calendarQuerySchema, req.query, "query")) as never) }));
export const getPublication: RequestHandler = wrap(async (req) => ({ data: await read.getPublicationDetail(user(req), idParam(req)) }));
export const listDestinations: RequestHandler = wrap(async (req) => ({ data: await read.listDestinations(user(req), parse(schema.destinationsQuerySchema, req.query, "query")) }));

export const getSettings: RequestHandler = wrap(async (req) => ({ data: await settings.getSettings(user(req)) }));
export const updateSettings: RequestHandler = wrap(async (req) => ({ data: await settings.updateSettings(user(req), parse(schema.settingsSchema, req.body, "body")) }));

export const listCampaignSettings: RequestHandler = wrap(async (req) => ({ data: await settings.listCampaignSettings(user(req)) }));
export const setCampaignAutoSchedule: RequestHandler = wrap(async (req) => ({ data: await settings.setCampaignAutoSchedule(user(req), idParam(req), parse(schema.campaignAutoScheduleSchema, req.body, "body").autoScheduleOnApproval) }));

export const createPublications: RequestHandler = wrap(async (req) => ({ status: 201, data: await workflow.createPublications(user(req), parse(schema.createPublicationsSchema, req.body, "body")) }));
export const updatePublication: RequestHandler = wrap(async (req) => ({ data: await workflow.updatePublication(user(req), idParam(req), parse(schema.updatePublicationSchema, req.body, "body")) }));
export const submitPublication: RequestHandler = wrap(async (req) => ({ data: await workflow.submitPublication(user(req), idParam(req)) }));
export const withdrawPublication: RequestHandler = wrap(async (req) => ({ data: await workflow.withdrawPublication(user(req), idParam(req)) }));
export const approvePublication: RequestHandler = wrap(async (req) => ({ data: await workflow.approvePublication(user(req), idParam(req), parse(schema.approveSchema, req.body ?? {}, "body").note) }));
export const rejectPublication: RequestHandler = wrap(async (req) => ({ data: await workflow.rejectPublication(user(req), idParam(req), parse(schema.rejectSchema, req.body, "body").reason) }));
export const schedulePublication: RequestHandler = wrap(async (req) => ({ data: await workflow.schedulePublication(user(req), idParam(req), parse(schema.scheduleSchema, req.body, "body")) }));
export const unschedulePublication: RequestHandler = wrap(async (req) => ({ data: await workflow.unschedulePublication(user(req), idParam(req)) }));
export const holdPublication: RequestHandler = wrap(async (req) => ({ data: await workflow.holdPublication(user(req), idParam(req), parse(schema.optionalReasonSchema, req.body ?? {}, "body").reason ?? null) }));
export const releasePublication: RequestHandler = wrap(async (req) => ({ data: await workflow.releasePublication(user(req), idParam(req)) }));
export const cancelPublication: RequestHandler = wrap(async (req) => ({ data: await workflow.cancelPublication(user(req), idParam(req), parse(schema.optionalReasonSchema, req.body ?? {}, "body").reason ?? null) }));
export const reopenPublication: RequestHandler = wrap(async (req) => ({ data: await workflow.reopenPublication(user(req), idParam(req)) }));
export const retryPublication: RequestHandler = wrap(async (req) => ({ data: await workflow.retryPublication(user(req), idParam(req)) }));
export const validatePublication: RequestHandler = wrap(async (req) => ({ data: await workflow.validatePublicationDryRun(user(req), idParam(req), parse(schema.validateSchema, req.body ?? {}, "body").scheduledAt ?? null) }));
