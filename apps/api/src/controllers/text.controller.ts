import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { ZodTypeAny, z } from "zod";
import { ERROR_CODES, type ApiResponse } from "@socialith/types";
import { ApiHttpError } from "../middleware/error-handler.js";
import * as lib from "../services/text-library.service.js";
import { handleTextImport } from "../services/text-import.service.js";
import * as schema from "../validation/text.validation.js";

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

// categories
export const listCategories: RequestHandler = wrap(async (req) => ({ data: await lib.listCategories(user(req), query(schema.listCategoriesQuerySchema, req).status) }));
export const createCategory: RequestHandler = wrap(async (req) => ({ status: 201, data: await lib.createCategory(user(req), body(schema.categoryCreateSchema, req)) }));
export const updateCategory: RequestHandler = wrap(async (req) => ({ data: await lib.updateCategory(user(req), id(req), body(schema.categoryUpdateSchema, req)) }));
export const archiveCategory: RequestHandler = wrap(async (req) => ({ data: await lib.setCategoryArchived(user(req), id(req), true) }));
export const restoreCategory: RequestHandler = wrap(async (req) => ({ data: await lib.setCategoryArchived(user(req), id(req), false) }));
export const addStarterCategories: RequestHandler = wrap(async (req) => ({ status: 201, data: await lib.addStarterCategories(user(req)) }));

// texts
export const summary: RequestHandler = wrap(async (req) => ({ data: await lib.getSummary(user(req)) }));
export const listTexts: RequestHandler = wrap(async (req) => ({ data: await lib.listTexts(user(req), query(schema.listTextsQuerySchema, req)) }));
export const getText: RequestHandler = wrap(async (req) => ({ data: await lib.getText(user(req), id(req)) }));
export const createText: RequestHandler = wrap(async (req) => ({ status: 201, data: await lib.createText(user(req), body(schema.textCreateSchema, req)) }));
export const updateText: RequestHandler = wrap(async (req) => ({ data: await lib.updateText(user(req), id(req), body(schema.textUpdateSchema, req)) }));
export const setCategories: RequestHandler = wrap(async (req) => ({ data: await lib.setLinks(user(req), id(req), "categories", body(schema.categoryIdsSchema, req).categoryIds) }));
export const setCampaigns: RequestHandler = wrap(async (req) => ({ data: await lib.setLinks(user(req), id(req), "campaigns", body(schema.campaignIdsSchema, req).campaignIds) }));
export const setPageCategories: RequestHandler = wrap(async (req) => ({ data: await lib.setLinks(user(req), id(req), "pageCategories", body(schema.pageCategoryIdsSchema, req).pageCategoryIds) }));
export const setPageGroups: RequestHandler = wrap(async (req) => ({ data: await lib.setLinks(user(req), id(req), "pageGroups", body(schema.pageGroupIdsSchema, req).pageGroupIds) }));
export const setPages: RequestHandler = wrap(async (req) => ({ data: await lib.setLinks(user(req), id(req), "pages", body(schema.pageIdsSchema, req).pageIds) }));
export const approve: RequestHandler = wrap(async (req) => ({ data: await lib.approveText(user(req), id(req), body(schema.reviewSchema, req).note) }));
export const reject: RequestHandler = wrap(async (req) => ({ data: await lib.rejectText(user(req), id(req), body(schema.rejectSchema, req).note) }));
export const archive: RequestHandler = wrap(async (req) => ({ data: await lib.setTextArchived(user(req), id(req), true) }));
export const restore: RequestHandler = wrap(async (req) => ({ data: await lib.setTextArchived(user(req), id(req), false) }));
export const setRights: RequestHandler = wrap(async (req) => {
  const b = body(schema.rightsSchema, req);
  return { data: await lib.setTextRights(user(req), id(req), b.status, b.notes) };
});
export const bulk: RequestHandler = wrap(async (req) => ({ data: await lib.bulkUpdate(user(req), body(schema.bulkSchema, req)) }));
export const listUsages: RequestHandler = wrap(async (req) => {
  const q = query(schema.listUsagesQuerySchema, req);
  return { data: await lib.listUsages(user(req), id(req), q.page, q.pageSize) };
});
export const recordUsage: RequestHandler = wrap(async (req) => ({ status: 201, data: await lib.recordUsage(user(req), id(req), body(schema.usageSchema, req)) }));

// collections
export const listCollections: RequestHandler = wrap(async (req) => ({ data: await lib.listCollections(user(req), query(schema.listCollectionsQuerySchema, req).status) }));
export const createCollection: RequestHandler = wrap(async (req) => ({ status: 201, data: await lib.createCollection(user(req), body(schema.collectionCreateSchema, req)) }));
export const updateCollection: RequestHandler = wrap(async (req) => ({ data: await lib.updateCollection(user(req), id(req), body(schema.collectionUpdateSchema, req)) }));
export const archiveCollection: RequestHandler = wrap(async (req) => ({ data: await lib.setCollectionArchived(user(req), id(req), true) }));
export const restoreCollection: RequestHandler = wrap(async (req) => ({ data: await lib.setCollectionArchived(user(req), id(req), false) }));
export const addCollectionTexts: RequestHandler = wrap(async (req) => ({ data: await lib.changeCollectionItems(user(req), id(req), body(schema.collectionTextsSchema, req).textIds, "add") }));
export const removeCollectionTexts: RequestHandler = wrap(async (req) => ({ data: await lib.changeCollectionItems(user(req), id(req), body(schema.collectionTextsSchema, req).textIds, "remove") }));

// import
export const importTexts: RequestHandler = wrap(async (req) => {
  const result = await handleTextImport(user(req), req);
  return { status: result.dryRun ? 200 : 201, data: result };
});
