/**
 * What exactly will be published for one destination — and a canonical string of it.
 *
 * Approval is pinned to this canonical string: when a human approves a publication the string is stored, and both
 * the scheduling step and the worker (right before it calls a provider) recompute it from the current database
 * rows. If the two differ, the content changed after approval and nothing is published.
 * Assets are identified by their row id (assets are immutable rows), never by URL: storage URLs are presigned and
 * change on every resolution.
 */

export interface PayloadInput {
  platform: string;
  caption: string | null;
  title: string | null;
  assetIds: string[];
  soundId: string | null;
}

export interface TextSources {
  captionOverride: string | null;
  titleOverride: string | null;
  variationCaption: string | null;
  variationTitle: string | null;
  contentCaption: string | null;
}

/** The text that is actually sent: the destination's own text wins, then the platform variation, then the base caption. */
export function effectiveText(s: TextSources): { caption: string | null; title: string | null } {
  return {
    caption: nonEmpty(s.captionOverride) ?? nonEmpty(s.variationCaption) ?? nonEmpty(s.contentCaption),
    title: nonEmpty(s.titleOverride) ?? nonEmpty(s.variationTitle),
  };
}

function nonEmpty(v: string | null | undefined): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

const normalize = (v: string | null) => (v === null ? null : v.replace(/\r\n?/g, "\n").trim());

export function canonicalPayload(i: PayloadInput): string {
  return JSON.stringify({
    platform: i.platform.toUpperCase(),
    caption: normalize(i.caption),
    title: normalize(i.title),
    assetIds: [...i.assetIds],
    soundId: i.soundId,
  });
}

/** True only when something was approved and it is exactly what would be published now. */
export function payloadMatchesApproval(approved: string | null | undefined, current: string): boolean {
  return typeof approved === "string" && approved === current;
}

export interface PayloadTarget {
  /** SocialAccount.platform of the destination (TIKTOK | INSTAGRAM | YOUTUBE). */
  platform: string;
  captionOverride: string | null;
  titleOverride: string | null;
  content: {
    caption: string | null;
    soundId: string | null;
    variations: { platform: string; caption: string | null; title: string | null }[];
    assets: { id: string; platform: string | null; createdAt: Date | string }[];
  };
}

/**
 * The canonical payload of one publication, computed from the database rows. The API (when approving and when
 * checking before scheduling) and the worker (right before it fires) both call THIS function, so they can never
 * disagree about what "unchanged since approval" means. Assets are the ones this destination would publish:
 * shared (platform null) plus those restricted to its platform, oldest first.
 */
export function buildTargetPayload(t: PayloadTarget): string {
  const platform = t.platform.toUpperCase();
  const variation = t.content.variations.find((v) => v.platform.toUpperCase() === platform) ?? null;
  const text = effectiveText({
    captionOverride: t.captionOverride,
    titleOverride: t.titleOverride,
    variationCaption: variation?.caption ?? null,
    variationTitle: variation?.title ?? null,
    contentCaption: t.content.caption,
  });
  const time = (v: Date | string) => (v instanceof Date ? v.getTime() : new Date(v).getTime());
  const assetIds = t.content.assets
    .filter((a) => a.platform === null || a.platform.toUpperCase() === platform)
    .sort((a, b) => time(a.createdAt) - time(b.createdAt) || a.id.localeCompare(b.id))
    .map((a) => a.id);
  return canonicalPayload({ platform, caption: text.caption, title: text.title, assetIds, soundId: t.content.soundId });
}