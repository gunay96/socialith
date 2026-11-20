import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { ZodTypeAny, z } from "zod";
import { EDITORIAL_FORMATS } from "@socialith/publishing";
import { ERROR_CODES, type ApiResponse } from "@socialith/types";
import { ApiHttpError } from "../middleware/error-handler.js";
import * as campaigns from "../services/page-network-campaign.service.js";
import * as categories from "../services/page-network-category.service.js";
import * as groups from "../services/page-network-group.service.js";
import * as overview from "../services/page-network-overview.service.js";
import * as pages from "../services/page-network-page.service.js";
import * as schema from "../validation/page-network.validation.js";

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

export const getOverview: RequestHandler = wrap(async (req) => ({ data: await overview.getOverview(user(req)) }));
export const getMapping: RequestHandler = wrap(async (req) => ({ data: await overview.getMapping(user(req), query(schema.mappingQuerySchema, req)) }));
export const listFormats: RequestHandler = wrap(async () => ({ data: { items: EDITORIAL_FORMATS } }));

// categories
export const listCategories: RequestHandler = wrap(async (req) => ({ data: await categories.listCategories(user(req), query(schema.listCategoriesQuerySchema, req).status) }));
export const getCategory: RequestHandler = wrap(async (req) => ({ data: await categories.getCategory(user(req), id(req)) }));
export const createCategory: RequestHandler = wrap(async (req) => ({ status: 201, data: await categories.createCategory(user(req), body(schema.categoryCreateSchema, req)) }));
export const updateCategory: RequestHandler = wrap(async (req) => ({ data: await categories.updateCategory(user(req), id(req), body(schema.categoryUpdateSchema, req)) }));
export const archiveCategory: RequestHandler = wrap(async (req) => ({ data: await categories.archiveCategory(user(req), id(req)) }));
export const restoreCategory: RequestHandler = wrap(async (req) => ({ data: await categories.restoreCategory(user(req), id(req)) }));
export const addStarterCategories: RequestHandler = wrap(async (req) => ({ data: await categories.addStarterCategories(user(req), body(schema.starterCategoriesSchema, req).language) }));

// pages
export const listPages: RequestHandler = wrap(async (req) => ({ data: await pages.listPages(user(req), query(schema.listPagesQuerySchema, req)) }));
export const getPage: RequestHandler = wrap(async (req) => ({ data: await pages.getPage(user(req), id(req)) }));
export const createPage: RequestHandler = wrap(async (req) => ({ status: 201, data: await pages.createPage(user(req), body(schema.pageCreateSchema, req)) }));
export const updatePage: RequestHandler = wrap(async (req) => ({ data: await pages.updatePage(user(req), id(req), body(schema.pageUpdateSchema, req)) }));
export const getIdentity: RequestHandler = wrap(async (req) => ({ data: await pages.getIdentity(user(req), id(req), query(schema.identityQuerySchema, req).groupId) }));
export const updateIdentity: RequestHandler = wrap(async (req) => ({ data: await pages.updateIdentity(user(req), id(req), body(schema.identityUpdateSchema, req)) }));
export const archivePage: RequestHandler = wrap(async (req) => ({ data: await pages.archivePage(user(req), id(req)) }));
export const restorePage: RequestHandler = wrap(async (req) => ({ data: await pages.restorePage(user(req), id(req)) }));
export const setDestination: RequestHandler = wrap(async (req) => ({ data: await pages.setDestination(user(req), id(req), body(schema.destinationLinkSchema, req).socialAccountId) }));
export const destinationCandidates: RequestHandler = wrap(async (req) => ({ data: await pages.destinationCandidates(user(req), id(req)) }));
export const checkText: RequestHandler = wrap(async (req) => {
  const b = body(schema.checkTextSchema, req);
  return { data: await pages.checkText(user(req), id(req), b.text, b.groupId) };
});

// groups
export const listGroups: RequestHandler = wrap(async (req) => ({ data: await groups.listGroups(user(req), query(schema.listGroupsQuerySchema, req)) }));
export const getGroup: RequestHandler = wrap(async (req) => ({ data: await groups.getGroup(user(req), id(req)) }));
export const createGroup: RequestHandler = wrap(async (req) => ({ status: 201, data: await groups.createGroup(user(req), body(schema.groupCreateSchema, req)) }));
export const updateGroup: RequestHandler = wrap(async (req) => ({ data: await groups.updateGroup(user(req), id(req), body(schema.groupUpdateSchema, req)) }));
export const archiveGroup: RequestHandler = wrap(async (req) => ({ data: await groups.setGroupStatus(user(req), id(req), "ARCHIVED") }));
export const restoreGroup: RequestHandler = wrap(async (req) => ({ data: await groups.setGroupStatus(user(req), id(req), "ACTIVE") }));
export const addGroupMembers: RequestHandler = wrap(async (req) => ({ data: await groups.addMembers(user(req), id(req), body(schema.groupMembersSchema, req).pageIds) }));
export const removeGroupMember: RequestHandler = wrap(async (req) => ({ data: await groups.removeMember(user(req), id(req), req.params.pageId!) }));

// campaigns
export const getCampaignPages: RequestHandler = wrap(async (req) => ({ data: await campaigns.getCampaignPages(user(req), id(req)) }));
export const assignCampaign: RequestHandler = wrap(async (req) => ({ data: await campaigns.assign(user(req), id(req), body(schema.campaignAssignSchema, req)) }));
export const unassignCampaignPage: RequestHandler = wrap(async (req) => ({ data: await campaigns.unassignPage(user(req), id(req), req.params.pageId!) }));
export const unassignCampaignGroup: RequestHandler = wrap(async (req) => ({ data: await campaigns.unassignGroup(user(req), id(req), req.params.groupId!) }));
export const campaignContent: RequestHandler = wrap(async (req) => ({ data: await campaigns.campaignContent(user(req), id(req), query(schema.campaignContentQuerySchema, req)) }));
