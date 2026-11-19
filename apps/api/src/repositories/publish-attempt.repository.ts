import { prisma } from "@socialith/database";
import type { PublishAttempt } from "@socialith/database";

export type { PublishAttempt };

/** Org isolation enforced by the caller (content.service.ts's getContentDetail already 404s a wrong-org contentId before this runs). */
export function listPublishAttempts(contentTargetId: string): Promise<PublishAttempt[]> {
  return prisma.publishAttempt.findMany({
    where: { contentTargetId },
    orderBy: { attemptNumber: "asc" },
  });
}
