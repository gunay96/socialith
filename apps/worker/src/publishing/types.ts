import type { Platform } from "@socialith/database";

/**
 * Everything a provider needs to attempt a real publish — assembled by
 * the publishing processor from Content/ContentVariation/ContentAsset/
 * SocialAccount/PlatformConnection, with the access token already
 * decrypted in memory (never persisted or logged in plaintext — see
 * apps/worker/src/publishing/token.ts).
 */
export interface PublishInput {
  contentId: string;
  contentTargetId: string;
  socialAccountId: string;
  /** The platform's own account/user id (SocialAccount.externalAccountId), not our internal cuid. */
  externalAccountId: string;
  accessToken: string;
  /** Platform-specific variation, if one was authored (Phase 07); falls back to Content.caption when absent. */
  caption: string | null;
  title: string | null;
  /** Content's assets relevant to this platform (platform-scoped ones first, then platform-less/shared ones). */
  assets: { type: string; url: string; platform: Platform | null }[];
  /**
   * Phase 09 music-seeding: the Sound (if any) selected on this Content.
   * Reference metadata only — never audio bytes (see schema.prisma's
   * Sound comment for why). Each provider decides for itself whether/how
   * it can act on this; see tiktok.provider.ts for the one platform this
   * phase's spec calls out by name, and why the official API can't
   * actually attach it.
   */
  sound: { title: string; artist: string | null; externalSoundId: string | null; soundUrl: string | null } | null;
}

export interface PublishSuccess {
  externalPostId: string;
  externalPostUrl: string | null;
  /** Structured, safe fields only (provider request id, etc.) — never raw credentials, never the full raw body verbatim. */
  responseMetadata: Record<string, unknown>;
  /**
   * True when this provider's publish() only *initiated* an async
   * operation (TikTok's real Direct Post flow: video/init/ returns a
   * publish_id, not a confirmed post) and the final result needs a
   * follow-up status check — see checkPublishStatus below and
   * processors/publish-status-poll.processor.ts. Omitted/false (every
   * provider but TikTok today) means this result is already final and
   * confirmed; the publishing processor marks the ContentTarget PUBLISHED
   * immediately, exactly as before this field existed.
   */
  pendingConfirmation?: boolean;
}

/** Real, converged outcome of a checkPublishStatus() call — never a guess at an in-between state. */
export interface PublishStatusResult {
  status: "PROCESSING" | "COMPLETE" | "FAILED";
  /** The platform's real, final post id — may differ from the provisional id publish() returned (e.g. TikTok's publish_id vs. its publicaly_available_post_id). Only present when status is COMPLETE. */
  externalPostId?: string;
  /** Only set when the platform's status response itself provides a real, verifiable URL — never constructed/guessed from other fields. */
  externalPostUrl?: string | null;
  /** Only present when status is FAILED. */
  failReason?: string;
  /**
   * A real, honest caveat to surface on the ContentTarget/UI when
   * status is COMPLETE but "complete" doesn't mean "live" — e.g.
   * TikTok's real Upload/Inbox flow (see tiktok.provider.ts), whose
   * genuine terminal success state is "delivered to the user's TikTok
   * inbox", not "published". Omitted for a platform/flow whose COMPLETE
   * really does mean live and public.
   */
  deliveryNote?: string;
  responseMetadata?: Record<string, unknown>;
}

/**
 * Machine-readable failure classification every adapter must produce —
 * this is what the publishing processor uses to decide retry vs permanent
 * failure (see apps/worker/src/processors/publishing.processor.ts), not
 * ad hoc string matching on `message`.
 */
export type PublishErrorCode =
  | "CONFIGURATION_ERROR" // no connection, no token, app credentials missing — nothing to retry
  | "AUTH_ERROR" // 401/403 — token invalid/expired/revoked, not fixed by retrying as-is
  | "CONTENT_ERROR" // 400/422 — the platform rejected this specific content — not fixed by retrying as-is
  | "RATE_LIMITED" // 429 — retryable, ideally after Retry-After
  | "PLATFORM_ERROR" // 5xx from the platform — retryable
  | "NETWORK_ERROR"; // fetch itself failed (DNS, timeout, connection reset) — retryable

export class PublishError extends Error {
  constructor(
    message: string,
    public readonly code: PublishErrorCode,
    public readonly retryable: boolean,
    public readonly httpStatusCode?: number,
    public readonly retryAfterMs?: number,
    public readonly responseMetadata?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "PublishError";
  }
}

export interface PublishingProvider {
  readonly platform: Platform;
  publish(input: PublishInput): Promise<PublishSuccess>;
  /** Only implemented by a provider whose publish() can return pendingConfirmation: true (today: TikTok only — see tiktok.provider.ts). */
  checkPublishStatus?(accessToken: string, providerPublishId: string): Promise<PublishStatusResult>;
}
