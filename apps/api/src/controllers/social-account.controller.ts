import type { NextFunction, Request, Response } from "express";
import { ERROR_CODES, type ApiResponse } from "@socialith/types";
import { ApiHttpError } from "../middleware/error-handler.js";
import { listSocialAccountsQuerySchema } from "../validation/social-account.validation.js";
import * as socialAccountService from "../services/social-account.service.js";
import type { ListSocialAccountsResult, SocialAccount } from "../repositories/social-account.repository.js";

/** GET /api/accounts — every authenticated role can view (VIEWER included), same read-openness as GET /api/team. */
export async function listAccounts(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = listSocialAccountsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ApiHttpError(400, ERROR_CODES.INVALID_REQUEST, "Invalid search/filter/pagination parameters.");
    }

    const result = await socialAccountService.getAccounts(req.user!, parsed.data);
    const body: ApiResponse<ListSocialAccountsResult & { page: number; pageSize: number }> = {
      success: true,
      data: { ...result, page: parsed.data.page, pageSize: parsed.data.pageSize },
    };
    res.status(200).json(body);
  } catch (err) {
    next(err);
  }
}

/** GET /api/accounts/:id — org-scoped; a cross-organization id resolves as 404, never 403. */
export async function getAccount(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const account = await socialAccountService.getAccountDetail(req.user!, req.params.id!);
    const body: ApiResponse<typeof account> = { success: true, data: account };
    res.status(200).json(body);
  } catch (err) {
    next(err);
  }
}

/** POST /api/accounts/:id/disconnect — requireMinimumRole("ADMIN") already ran (see routes/social-account.ts). */
export async function disconnectAccount(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const account = await socialAccountService.disconnectAccount(req.user!, req.params.id!);
    const body: ApiResponse<SocialAccount> = { success: true, data: account };
    res.status(200).json(body);
  } catch (err) {
    next(err);
  }
}
