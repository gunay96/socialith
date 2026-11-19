import { prisma } from "@socialith/database";
import type { ContentGenerationJob, ContentGenerationStatus, Platform } from "@socialith/database";

export type { ContentGenerationJob };

/** An in-flight job for this content(+platform) — used to make "Generate" idempotent (see the service layer). */
export function findActiveGenerationJob(
  organizationId: string,
  contentId: string,
  platform: Platform | null,
): Promise<ContentGenerationJob | null> {
  return prisma.contentGenerationJob.findFirst({
    where: { organizationId, contentId, platform, status: { in: ["PENDING", "PROCESSING"] } },
    orderBy: { createdAt: "desc" },
  });
}

export interface CreateGenerationJobInput {
  organizationId: string;
  contentId: string;
  platform: Platform | null;
  requestedById: string | null;
}

export function createGenerationJob(input: CreateGenerationJobInput): Promise<ContentGenerationJob> {
  return prisma.contentGenerationJob.create({ data: input });
}

/** Cross-organization `id` simply doesn't match — "not found", never "forbidden". */
export function findGenerationJobById(organizationId: string, id: string): Promise<ContentGenerationJob | null> {
  return prisma.contentGenerationJob.findFirst({ where: { id, organizationId } });
}

export function listGenerationJobsForContent(contentId: string): Promise<ContentGenerationJob[]> {
  return prisma.contentGenerationJob.findMany({ where: { contentId }, orderBy: { createdAt: "desc" } });
}

export interface UpdateGenerationJobInput {
  status?: ContentGenerationStatus;
  attempts?: number;
  errorMessage?: string | null;
  resultVariationId?: string | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
}

export function updateGenerationJob(id: string, input: UpdateGenerationJobInput): Promise<ContentGenerationJob> {
  return prisma.contentGenerationJob.update({ where: { id }, data: input });
}
