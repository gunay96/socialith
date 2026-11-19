import type { NextFunction, Request, Response } from "express";
import { ERROR_CODES, type ApiResponse } from "@socialith/types";
import { ApiHttpError } from "../middleware/error-handler.js";
import {
  listContentQuerySchema,
  createContentSchema,
  updateContentSchema,
  upsertContentVariationSchema,
  createContentAssetSchema,
  assignContentTargetsSchema,
  removeContentTargetsSchema,
  scheduleContentSchema,
  listContentTargetsQuerySchema,
  requestGenerationSchema,
  requestRenderSchema,
} from "../validation/content.validation.js";
import { platformSchema } from "../validation/social-account.validation.js";
import * as contentService from "../services/content.service.js";
import * as contentTargetService from "../services/content-target.service.js";
import * as contentGenerationService from "../services/content-generation.service.js";
import * as videoRenderService from "../services/video-render.service.js";
import * as contentAssetUploadService from "../services/content-asset-upload.service.js";
import type { ContentDetail, ContentListItem } from "../repositories/content.repository.js";
import type { ContentVariation } from "../repositories/content-variation.repository.js";
import type { ContentAsset } from "../repositories/content-asset.repository.js";
import type { ContentGenerationJob } from "../repositories/content-generation-job.repository.js";
import type { VideoRenderJob } from "../repositories/video-render-job.repository.js";
import type { PublishAttempt } from "../repositories/publish-attempt.repository.js";
import type { PostMetricsSnapshot } from "../repositories/analytics.repository.js";

export async function listContent(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = listContentQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ApiHttpError(400, ERROR_CODES.INVALID_REQUEST, "Invalid search/filter/pagination parameters.");
    }
    const result = await contentService.getContentList(req.user!, parsed.data);
    const body: ApiResponse<{ items: ContentListItem[]; total: number; page: number; pageSize: number }> = {
      success: true,
      data: { ...result, page: parsed.data.page, pageSize: parsed.data.pageSize },
    };
    res.status(200).json(body);
  } catch (err) {
    next(err);
  }
}

export async function createContent(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = createContentSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiHttpError(400, ERROR_CODES.INVALID_REQUEST, "Invalid content.");
    }
    const content = await contentService.createContent(req.user!, parsed.data);
    const body: ApiResponse<typeof content> = { success: true, data: content };
    res.status(201).json(body);
  } catch (err) {
    next(err);
  }
}

export async function getContent(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const content = await contentService.getContentDetail(req.user!, req.params.id!);
    const body: ApiResponse<ContentDetail> = { success: true, data: content };
    res.status(200).json(body);
  } catch (err) {
    next(err);
  }
}

export async function updateContent(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = updateContentSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiHttpError(400, ERROR_CODES.INVALID_REQUEST, "Invalid content update.");
    }
    const content = await contentService.updateContent(req.user!, req.params.id!, parsed.data);
    const body: ApiResponse<typeof content> = { success: true, data: content };
    res.status(200).json(body);
  } catch (err) {
    next(err);
  }
}

export async function deleteContent(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await contentService.deleteContent(req.user!, req.params.id!);
    const body: ApiResponse<{ deleted: true }> = { success: true, data: { deleted: true } };
    res.status(200).json(body);
  } catch (err) {
    next(err);
  }
}

/** PUT /api/content/:id/variations/:platform */
export async function upsertVariation(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const platformParsed = platformSchema.safeParse(req.params.platform);
    const bodyParsed = upsertContentVariationSchema.safeParse(req.body);
    if (!platformParsed.success || !bodyParsed.success) {
      throw new ApiHttpError(400, ERROR_CODES.INVALID_REQUEST, "Invalid content variation.");
    }
    const variation = await contentService.upsertVariation(req.user!, req.params.id!, platformParsed.data, bodyParsed.data);
    const body: ApiResponse<ContentVariation> = { success: true, data: variation };
    res.status(200).json(body);
  } catch (err) {
    next(err);
  }
}

/** POST /api/content/:id/assets */
export async function createAsset(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = createContentAssetSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiHttpError(400, ERROR_CODES.INVALID_REQUEST, "Invalid asset.");
    }
    const asset = await contentService.createAsset(req.user!, req.params.id!, parsed.data);
    const body: ApiResponse<ContentAsset> = { success: true, data: asset };
    res.status(201).json(body);
  } catch (err) {
    next(err);
  }
}

/** GET /api/content/:id/targets — paginated; never all targets in one response. */
export async function listTargets(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = listContentTargetsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ApiHttpError(400, ERROR_CODES.INVALID_REQUEST, "Invalid target list parameters.");
    }
    const result = await contentTargetService.getTargets(
      req.user!,
      req.params.id!,
      parsed.data.page,
      parsed.data.pageSize,
      parsed.data.status,
    );
    const body: ApiResponse<typeof result & { page: number; pageSize: number }> = {
      success: true,
      data: { ...result, page: parsed.data.page, pageSize: parsed.data.pageSize },
    };
    res.status(200).json(body);
  } catch (err) {
    next(err);
  }
}

/** POST /api/content/:id/targets — bulk assign, up to 1000 account IDs per request. */
export async function assignTargets(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = assignContentTargetsSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiHttpError(400, ERROR_CODES.INVALID_REQUEST, "socialAccountIds (1-1000) is required.");
    }
    const result = await contentTargetService.assignTargets(req.user!, req.params.id!, parsed.data.socialAccountIds);
    const body: ApiResponse<typeof result> = { success: true, data: result };
    res.status(200).json(body);
  } catch (err) {
    next(err);
  }
}

/** DELETE /api/content/:id/targets — bulk remove. */
export async function removeTargets(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = removeContentTargetsSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiHttpError(400, ERROR_CODES.INVALID_REQUEST, "socialAccountIds (1-1000) is required.");
    }
    const removed = await contentTargetService.removeTargets(req.user!, req.params.id!, parsed.data.socialAccountIds);
    const body: ApiResponse<{ removed: number }> = { success: true, data: { removed } };
    res.status(200).json(body);
  } catch (err) {
    next(err);
  }
}

/** POST /api/content/:id/schedule */
export async function scheduleContent(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = scheduleContentSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiHttpError(400, ERROR_CODES.INVALID_REQUEST, parsed.error.issues[0]?.message ?? "Invalid schedule.");
    }
    const content = await contentTargetService.scheduleContent(req.user!, req.params.id!, parsed.data.scheduledAt);
    const body: ApiResponse<typeof content> = { success: true, data: content };
    res.status(200).json(body);
  } catch (err) {
    next(err);
  }
}

/** POST /api/content/:id/assets/upload — real multipart file upload (see content-asset-upload.service.ts). */
export async function uploadAsset(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const file = req.file;
    if (!file) {
      throw new ApiHttpError(400, ERROR_CODES.INVALID_MEDIA, "No file was uploaded (expected multipart field \"file\").");
    }
    const platformParsed = platformSchema.nullable().optional().safeParse(req.body.platform || null);
    if (!platformParsed.success) {
      throw new ApiHttpError(400, ERROR_CODES.INVALID_REQUEST, "Invalid platform.");
    }
    const asset = await contentAssetUploadService.uploadAsset(req.user!, req.params.id!, {
      platform: platformParsed.data,
      buffer: file.buffer,
      mimetype: file.mimetype,
      originalFilename: file.originalname,
    });
    const body: ApiResponse<ContentAsset> = { success: true, data: asset };
    res.status(201).json(body);
  } catch (err) {
    next(err);
  }
}

/** POST /api/content/:id/generation — enqueues an AI caption/hashtag generation job; returns immediately. */
export async function requestGeneration(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = requestGenerationSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new ApiHttpError(400, ERROR_CODES.INVALID_REQUEST, "Invalid generation request.");
    }
    const job = await contentGenerationService.requestGeneration(req.user!, req.params.id!, parsed.data.platform ?? null);
    const body: ApiResponse<ContentGenerationJob> = { success: true, data: job };
    res.status(202).json(body);
  } catch (err) {
    next(err);
  }
}

/** GET /api/content/:id/generation */
export async function listGenerationJobs(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const jobs = await contentGenerationService.listGenerationJobs(req.user!, req.params.id!);
    const body: ApiResponse<ContentGenerationJob[]> = { success: true, data: jobs };
    res.status(200).json(body);
  } catch (err) {
    next(err);
  }
}

/** POST /api/content/:id/render — enqueues an FFmpeg render job; returns immediately. */
export async function requestRender(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = requestRenderSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiHttpError(400, ERROR_CODES.INVALID_REQUEST, "sourceAssetId and operation are required.");
    }
    const job = await videoRenderService.requestRender(
      req.user!,
      req.params.id!,
      parsed.data.sourceAssetId,
      parsed.data.operation,
    );
    const body: ApiResponse<VideoRenderJob> = { success: true, data: job };
    res.status(202).json(body);
  } catch (err) {
    next(err);
  }
}

/** GET /api/content/:id/render */
export async function listRenderJobs(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const jobs = await videoRenderService.listRenderJobs(req.user!, req.params.id!);
    const body: ApiResponse<VideoRenderJob[]> = { success: true, data: jobs };
    res.status(200).json(body);
  } catch (err) {
    next(err);
  }
}

/** POST /api/content/:id/publish-now — Phase 08, reuses scheduleContent's exact pipeline at an effectively-immediate timestamp. */
export async function publishNow(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const content = await contentTargetService.publishNow(req.user!, req.params.id!);
    const body: ApiResponse<typeof content> = { success: true, data: content };
    res.status(200).json(body);
  } catch (err) {
    next(err);
  }
}

/** POST /api/content/:id/targets/:socialAccountId/retry */
export async function retryTarget(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await contentTargetService.retryTarget(req.user!, req.params.id!, req.params.socialAccountId!);
    const body: ApiResponse<{ retried: true }> = { success: true, data: { retried: true } };
    res.status(200).json(body);
  } catch (err) {
    next(err);
  }
}

/** GET /api/content/:id/targets/:socialAccountId/attempts */
export async function listPublishAttempts(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const attempts = await contentTargetService.getPublishAttempts(req.user!, req.params.id!, req.params.socialAccountId!);
    const body: ApiResponse<PublishAttempt[]> = { success: true, data: attempts };
    res.status(200).json(body);
  } catch (err) {
    next(err);
  }
}

/** POST /api/content/:id/targets/:socialAccountId/sync-analytics — Phase 09, enqueues a real metrics fetch; returns immediately. */
export async function syncAnalytics(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await contentTargetService.syncAnalytics(req.user!, req.params.id!, req.params.socialAccountId!);
    const body: ApiResponse<{ enqueued: true }> = { success: true, data: { enqueued: true } };
    res.status(202).json(body);
  } catch (err) {
    next(err);
  }
}

/** GET /api/content/:id/targets/:socialAccountId/metrics */
export async function getMetricsHistory(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const snapshots = await contentTargetService.getMetricsHistory(req.user!, req.params.id!, req.params.socialAccountId!);
    const body: ApiResponse<PostMetricsSnapshot[]> = { success: true, data: snapshots };
    res.status(200).json(body);
  } catch (err) {
    next(err);
  }
}
