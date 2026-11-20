import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { ZodTypeAny, z } from "zod";
import { ERROR_CODES, type ApiResponse } from "@socialith/types";
import { ApiHttpError } from "../middleware/error-handler.js";
import * as svc from "../services/recipe.service.js";
import * as schema from "../validation/recipe.validation.js";

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

export const list: RequestHandler = wrap(async (req) => ({ data: await svc.listRecipes(user(req), query(schema.listRecipesQuerySchema, req)) }));
export const get: RequestHandler = wrap(async (req) => ({ data: await svc.getRecipe(user(req), id(req)) }));
export const presets: RequestHandler = wrap(async (req) => ({ data: await svc.listPresets(user(req)) }));
export const installPresets: RequestHandler = wrap(async (req) => ({ status: 201, data: await svc.installPresets(user(req)) }));
export const fromPreset: RequestHandler = wrap(async (req) => {
  const b = body(schema.fromPresetSchema, req);
  return { status: 201, data: await svc.createFromPreset(user(req), b.presetKey, b.name) };
});
export const create: RequestHandler = wrap(async (req) => ({ status: 201, data: await svc.createRecipe(user(req), body(schema.recipeCreateSchema, req)) }));
export const update: RequestHandler = wrap(async (req) => ({ data: await svc.updateRecipe(user(req), id(req), body(schema.recipeUpdateSchema, req)) }));
export const duplicate: RequestHandler = wrap(async (req) => ({ status: 201, data: await svc.duplicateRecipe(user(req), id(req), body(schema.duplicateSchema, req).name) }));
export const archive: RequestHandler = wrap(async (req) => ({ data: await svc.setRecipeArchived(user(req), id(req), true) }));
export const restore: RequestHandler = wrap(async (req) => ({ data: await svc.setRecipeArchived(user(req), id(req), false) }));
export const assignments: RequestHandler = wrap(async (req) => ({ data: await svc.setAssignments(user(req), id(req), body(schema.assignmentsSchema, req)) }));
export const previewConfig: RequestHandler = wrap(async (req) => ({ data: await svc.savePreviewConfig(user(req), id(req), body(schema.previewConfigSchema, req)) }));
export const evaluate: RequestHandler = wrap(async (req) => ({ data: await svc.evaluate(user(req), body(schema.effectiveSchema, req)) }));
