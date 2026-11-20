import type { PrismaClient } from "@socialith/database";
import { DEFAULT_PUBLISHING_POLICY, buildTargetPayload, payloadMatchesApproval } from "@socialith/publishing";

/**
 * The approval gate, enforced by the worker right before anything is fired or handed to a provider.
 *
 * Whether approval is required is a property of the organization (PublishingSettings.requireApproval); an
 * organization that never saved a preference is gated too (approval is the product default). When approval IS
 * required, a publication may only go out if it is APPROVED **and** exactly what was approved: the canonical payload
 * stored at approval time (see @socialith/publishing buildTargetPayload) must equal the one computed from the
 * database now. This is the last line of defence — it holds for every path that reaches a provider (scheduled job,
 * manual retry, hand-off to the Upload-Post scheduler), including content edited through the older content API.
 */
export type GateVerdict =
  | { ok: true }
  | { ok: false; code: "NOT_APPROVED" | "CONTENT_CHANGED"; message: string };

export const GATE_MESSAGES = {
  NOT_APPROVED: "Not published: this destination has not been approved, and approval is required for this organization. Submit it for review and have it approved.",
  CONTENT_CHANGED: "Not published: the content changed after it was approved. Review it and approve it again.",
} as const;

export async function isApprovalRequired(db: PrismaClient, organizationId: string): Promise<boolean> {
  const settings = await db.publishingSettings.findUnique({ where: { organizationId }, select: { requireApproval: true } });
  // Product decision: approval is required unless the organization explicitly saved otherwise (same default as the API).
  return settings?.requireApproval ?? DEFAULT_PUBLISHING_POLICY.requireApproval;
}

export async function evaluateApprovalGate(db: PrismaClient, contentTargetId: string): Promise<GateVerdict> {
  const t = await db.contentTarget.findUnique({
    where: { id: contentTargetId },
    select: {
      approvalStatus: true,
      approvedPayload: true,
      captionOverride: true,
      titleOverride: true,
      socialAccount: { select: { platform: true } },
      content: {
        select: {
          organizationId: true,
          caption: true,
          soundId: true,
          variations: { select: { platform: true, caption: true, title: true } },
          assets: { select: { id: true, platform: true, createdAt: true } },
        },
      },
    },
  });
  if (!t) return { ok: true }; // nothing to gate; the caller handles a missing target
  if (!(await isApprovalRequired(db, t.content.organizationId))) return { ok: true };
  if (t.approvalStatus !== "APPROVED") return { ok: false, code: "NOT_APPROVED", message: GATE_MESSAGES.NOT_APPROVED };
  const current = buildTargetPayload({
    platform: t.socialAccount.platform,
    captionOverride: t.captionOverride,
    titleOverride: t.titleOverride,
    content: { caption: t.content.caption, soundId: t.content.soundId, variations: t.content.variations, assets: t.content.assets },
  });
  if (!payloadMatchesApproval(t.approvedPayload, current)) return { ok: false, code: "CONTENT_CHANGED", message: GATE_MESSAGES.CONTENT_CHANGED };
  return { ok: true };
}
