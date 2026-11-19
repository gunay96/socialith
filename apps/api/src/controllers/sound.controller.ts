import type { NextFunction, Request, Response } from "express";
import { ERROR_CODES, type ApiResponse } from "@socialith/types";
import { ApiHttpError } from "../middleware/error-handler.js";
import { listSoundsQuerySchema, createSoundSchema, updateSoundSchema } from "../validation/sound.validation.js";
import * as soundService from "../services/sound.service.js";
import type { ListSoundsResult, Sound, SoundUsage } from "../repositories/sound.repository.js";

/** GET /api/sounds — every authenticated role can view. */
export async function listSounds(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = listSoundsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ApiHttpError(400, ERROR_CODES.INVALID_REQUEST, "Invalid search/filter/pagination parameters.");
    }
    const result = await soundService.getSounds(req.user!, parsed.data);
    const body: ApiResponse<ListSoundsResult & { page: number; pageSize: number }> = {
      success: true,
      data: { ...result, page: parsed.data.page, pageSize: parsed.data.pageSize },
    };
    res.status(200).json(body);
  } catch (err) {
    next(err);
  }
}

/** POST /api/sounds — requireMinimumRole("EDITOR") already ran (routes/sound.ts). */
export async function createSound(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = createSoundSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiHttpError(400, ERROR_CODES.INVALID_REQUEST, parsed.error.issues[0]?.message ?? "Invalid sound.");
    }
    const sound = await soundService.createSound(req.user!, parsed.data);
    const body: ApiResponse<Sound> = { success: true, data: sound };
    res.status(201).json(body);
  } catch (err) {
    next(err);
  }
}

/** GET /api/sounds/:id — org-scoped; a cross-organization id resolves as 404. Includes usage counts. */
export async function getSound(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const sound = await soundService.getSoundDetail(req.user!, req.params.id!);
    const body: ApiResponse<Sound & { usage: SoundUsage }> = { success: true, data: sound };
    res.status(200).json(body);
  } catch (err) {
    next(err);
  }
}

/** PATCH /api/sounds/:id — requireMinimumRole("EDITOR") already ran. */
export async function updateSound(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = updateSoundSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiHttpError(400, ERROR_CODES.INVALID_REQUEST, "Invalid sound update.");
    }
    const sound = await soundService.updateSound(req.user!, req.params.id!, parsed.data);
    const body: ApiResponse<Sound> = { success: true, data: sound };
    res.status(200).json(body);
  } catch (err) {
    next(err);
  }
}

/** POST /api/sounds/:id/archive — requireMinimumRole("EDITOR") already ran. */
export async function archiveSound(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const sound = await soundService.archiveSound(req.user!, req.params.id!);
    const body: ApiResponse<Sound> = { success: true, data: sound };
    res.status(200).json(body);
  } catch (err) {
    next(err);
  }
}
