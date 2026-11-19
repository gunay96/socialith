import { prisma } from "@socialith/database";
import type { VideoRenderJob, VideoRenderOperation } from "@socialith/database";

export type { VideoRenderJob };

/** An in-flight job for this content+source+operation — used to make "Render" idempotent (see the service layer). */
export function findActiveRenderJob(
  organizationId: string,
  contentId: string,
  sourceAssetId: string,
  operation: VideoRenderOperation,
): Promise<VideoRenderJob | null> {
  return prisma.videoRenderJob.findFirst({
    where: { organizationId, contentId, sourceAssetId, operation, status: { in: ["PENDING", "PROCESSING"] } },
    orderBy: { createdAt: "desc" },
  });
}

export interface CreateRenderJobInput {
  organizationId: string;
  contentId: string;
  sourceAssetId: string;
  operation: VideoRenderOperation;
  requestedById: string | null;
}

export function createRenderJob(input: CreateRenderJobInput): Promise<VideoRenderJob> {
  return prisma.videoRenderJob.create({ data: input });
}

export function findRenderJobById(organizationId: string, id: string): Promise<VideoRenderJob | null> {
  return prisma.videoRenderJob.findFirst({ where: { id, organizationId } });
}

export function listRenderJobsForContent(contentId: string): Promise<VideoRenderJob[]> {
  return prisma.videoRenderJob.findMany({ where: { contentId }, orderBy: { createdAt: "desc" } });
}
