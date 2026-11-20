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
