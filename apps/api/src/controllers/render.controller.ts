import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { ZodTypeAny, z } from "zod";
import { ERROR_CODES, type ApiResponse } from "@socialith/types";
import { ApiHttpError } from "../middleware/error-handler.js";
import * as svc from "../services/render.service.js";
import * as schema from "../validation/render.validation.js";

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
const id = (req: Request) => req.params.id!;
const body = <S extends ZodTypeAny>(s: S, req: Request) => parse(s, req.body ?? {}, "body");
const query = <S extends ZodTypeAny>(s: S, req: Request) => parse(s, req.query, "query");

export const list: RequestHandler = wrap(async (req) => ({ data: await svc.listRenders(user(req), query(schema.listRendersQuerySchema, req)) }));
export const get: RequestHandler = wrap(async (req) => ({ data: await svc.getRender(user(req), id(req)) }));
export const resolve: RequestHandler = wrap(async (req) => ({ data: await svc.resolveForRender(user(req), body(schema.renderResolveSchema, req)) }));
export const create: RequestHandler = wrap(async (req) => ({ status: 202, data: await svc.createRender(user(req), body(schema.renderRequestSchema, req)) }));
export const cancel: RequestHandler = wrap(async (req) => ({ status: 202, data: await svc.cancelRender(user(req), id(req)) }));
export const retry: RequestHandler = wrap(async (req) => ({ status: 202, data: await svc.retryRender(user(req), id(req)) }));
