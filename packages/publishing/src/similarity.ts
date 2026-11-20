/**
 * Repetitive-distribution guard (PRD guardrail 2).
 *
 * Several destinations of the SAME platform must not all receive the same asset with the same text. Texts are
 * compared as sets of word 3-grams (Jaccard); two texts at or above `thresholdPct` are "the same". Within one
 * (content, platform) group, at most `maxSimilar` destinations may share text; the rest are reported with the
 * id of an earlier destination they repeat, so the operator can write a destination-specific caption.
 * Texts with fewer than three words are compared as plain word sets, and two empty texts count as identical.
 */

export function normalizeForComparison(text: string | null): string {
  return (text ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}#@\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function shingles(text: string | null, size = 3): Set<string> {
  const words = normalizeForComparison(text).split(" ").filter(Boolean);
  const out = new Set<string>();
  if (words.length === 0) return out;
  if (words.length < size) {
    out.add(words.join(" "));
    return out;
  }
  for (let i = 0; i + size <= words.length; i++) out.add(words.slice(i, i + size).join(" "));
  return out;
}

/** 0–100. Two empty texts are 100; one empty and one not is 0. */
export function similarityPercent(a: string | null, b: string | null): number {
  const sa = shingles(a);
  const sb = shingles(b);
  if (sa.size === 0 && sb.size === 0) return 100;
  if (sa.size === 0 || sb.size === 0) return 0;
  let shared = 0;
  for (const s of sa) if (sb.has(s)) shared++;
  return Math.round((shared / (sa.size + sb.size - shared)) * 100);
}

export interface RepetitionItem {
  id: string;
  platform: string;
  /** The content item: only publications of the same content (same assets) can repeat each other. */
  contentId: string;
  text: string | null;
}

export interface Repetition {
  id: string;
  /** An earlier destination in the same group whose text this one repeats. */
  repeats: string;
  similarityPct: number;
}

/**
 * `maxSimilar` = how many destinations of one platform may share (near-)identical text for one content item;
 * the default policy allows 1 (every further destination needs its own text). Order is the given order.
 */
export function findRepetitions(items: RepetitionItem[], thresholdPct: number, maxSimilar: number): Repetition[] {
  const out: Repetition[] = [];
  const groups = new Map<string, RepetitionItem[]>();
  for (const item of items) {
    const key = `${item.contentId}::${item.platform.toUpperCase()}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(item);
  }
  for (const group of groups.values()) {
    const clusters: RepetitionItem[][] = [];
    for (const item of group) {
      const home = clusters.find((c) => similarityPercent(c[0]!.text, item.text) >= thresholdPct);
      if (home) home.push(item);
      else clusters.push([item]);
    }
    for (const cluster of clusters) {
      for (let i = Math.max(1, maxSimilar); i < cluster.length; i++) {
        const item = cluster[i]!;
        out.push({ id: item.id, repeats: cluster[0]!.id, similarityPct: similarityPercent(cluster[0]!.text, item.text) });
      }
    }
  }
  return out;
}
