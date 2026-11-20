import type { Prisma, PrismaClient } from "@socialith/database";
import type { UploadPostStatus } from "@socialith/upload-post";
import { finalizeContentStatus } from "../publishing/finalize.js";

export interface PublicationForStatus {
  id: string;
  contentTargetId: string;
  platform: string;
  status: string;
}

export type StatusOutcome =
  | { kind: "IN_FLIGHT"; providerStatus: string }
  | { kind: "COMPLETED"; postUrl: string | null; platformPostId: string | null; fallbackToInbox: boolean }
  | { kind: "FAILED"; reason: string }
  | { kind: "NOT_FOUND" };

const TIKTOK_INBOX_NOTE =
  "Delivered to the creator's TikTok inbox/drafts through Upload-Post — it is NOT live until it is published from the TikTok app.";

/** Pure interpretation of the provider's status for the ONE platform this publication targets. */
export function interpretProviderStatus(platform: string, status: UploadPostStatus): StatusOutcome {
  if (status.status === "not_found") return { kind: "NOT_FOUND" };

  const result = status.results.find((r) => r.platform === platform) ?? null;

  if (result && result.skipped) {
    return {
      kind: "FAILED",
      reason: `Upload-Post skipped ${platform} for this profile (${result.skipReason ?? "platform not configured"}). Reconnect the account in Upload-Post.`,
    };
  }
  if (result && (result.status === "failed" || (!result.success && status.status === "failed"))) {
    return { kind: "FAILED", reason: result.error ?? result.message ?? "Upload-Post reported the publication failed." };
  }
  if (status.status === "failed") {
    return { kind: "FAILED", reason: status.message ?? result?.error ?? "Upload-Post reported the publication failed." };
  }
  if (status.status === "completed") {
    if (result && result.success) {
      return { kind: "COMPLETED", postUrl: result.postUrl, platformPostId: result.platformPostId, fallbackToInbox: result.fallbackToInbox };
    }
    return { kind: "FAILED", reason: result?.error ?? `Upload-Post completed the job but reported no successful ${platform} result.` };
  }
  return { kind: "IN_FLIGHT", providerStatus: status.status };
}

/**
 * Applies the provider's authoritative status to the publication and its ContentTarget, idempotently:
 * the ContentTarget is only moved out of PUBLISHING/SCHEDULED (a target already PUBLISHED/FAILED by another
 * path is never overwritten) and the content status is rolled up afterwards.
 */
export async function applyProviderStatus(
  db: PrismaClient,
  publication: PublicationForStatus,
  status: UploadPostStatus,
  now: Date = new Date(),
): Promise<StatusOutcome> {
  const outcome = interpretProviderStatus(publication.platform, status);
  if (outcome.kind === "NOT_FOUND") return outcome;

  const target = await db.contentTarget.findUnique({
    where: { id: publication.contentTargetId },
    select: { id: true, contentId: true, externalPostId: true, status: true },
  });
  const summary = { providerStatus: status.status, results: status.results } as unknown as Prisma.InputJsonValue;

  if (outcome.kind === "IN_FLIGHT") {
    await db.uploadPostPublication.updateMany({
      where: { id: publication.id, status: { notIn: ["COMPLETED", "FAILED", "CANCELLED"] } },
      data: { lastProviderStatus: outcome.providerStatus, lastProviderResult: summary, lastSyncedAt: now },
    });
    return outcome;
  }

  if (outcome.kind === "COMPLETED") {
    await db.$transaction(async (tx) => {
      await tx.uploadPostPublication.update({
        where: { id: publication.id },
        data: { status: "COMPLETED", completedAt: now, lastProviderStatus: "completed", lastProviderResult: summary, lastSyncedAt: now, lastErrorKind: null, lastErrorMessage: null },
      });
      if (target) {
        await tx.contentTarget.updateMany({
          where: { id: target.id, status: { in: ["PUBLISHING", "SCHEDULED"] } },
          data: {
            status: "PUBLISHED",
            publishedAt: now,
            externalPostId: outcome.platformPostId ?? target.externalPostId,
            externalPostUrl: outcome.postUrl,
            deliveryNote: outcome.fallbackToInbox ? TIKTOK_INBOX_NOTE : null,
            errorMessage: null,
          },
        });
      }
    });
    if (target) await finalizeContentStatus(db, target.contentId);
    return outcome;
  }

  // FAILED
  await db.$transaction(async (tx) => {
    await tx.uploadPostPublication.update({
      where: { id: publication.id },
      data: { status: "FAILED", completedAt: now, lastProviderStatus: "failed", lastProviderResult: summary, lastSyncedAt: now, lastErrorKind: "PROVIDER_FAILED", lastErrorMessage: outcome.reason.slice(0, 1000) },
    });
    if (target) {
      await tx.contentTarget.updateMany({
        where: { id: target.id, status: { in: ["PUBLISHING", "SCHEDULED"] } },
        data: { status: "FAILED", errorMessage: outcome.reason },
      });
    }
  });
  if (target) await finalizeContentStatus(db, target.contentId);
  return outcome;
}
