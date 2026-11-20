/**
 * Editorial identity of the Page Network (Phase 4) - pure rules, no I/O, shared by the API (and, later, the worker).
 *
 * Every thematic page has an editorial profile. A CATEGORY defines the defaults, a PAGE GROUP may add group-level
 * preferences, and the PAGE itself may override anything. Precedence, most specific first: page > group > category >
 * built-in default. A value counts as "set" only when it is meaningful (a non-blank string, a non-empty list, a finite
 * number, a boolean, a known enum value); everything else inherits. There is no merging INSIDE a list: a page that sets
 * `colors` replaces the category's colors, it does not append to them.
 *
 * This file also holds the reusable editorial FORMAT definitions (what kinds of content a page can make) - definitions
 * only: rendering and automatic text placement belong to Media Packs / the Format Engine (Phase 5/6), and nothing here
 * produces media.
 */
import { similarityPercent } from "./similarity.js";
import type { ValidationIssue } from "./validation.js";

export const ASPECT_RATIOS = ["9:16", "4:5", "1:1", "16:9"] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];

export const TEXT_POSITIONS = ["TOP", "UPPER_THIRD", "CENTER", "LOWER_THIRD", "BOTTOM"] as const;
export type TextPosition = (typeof TEXT_POSITIONS)[number];

export const RULE_ENFORCEMENTS = ["WARN", "BLOCK"] as const;
export type RuleEnforcement = (typeof RULE_ENFORCEMENTS)[number];

// ------------------------------------------------------------------------------------------------ formats

export interface EditorialFormat {
  id: string;
  label: string;
  description: string;
  /** Aspect ratios the format is meant for (the first is the usual one). */
  aspectRatios: AspectRatio[];
  /** True when the format's text must be based on checked facts (names, scores, dates). */
  needsVerifiedFacts: boolean;
  /** Always DEFINITION_ONLY in Phase 4: nothing renders or places text yet. */
  implementation: "DEFINITION_ONLY";
}

/** Reusable editorial format definitions for the future Media Pack / AI Content Studio phases. */
export const EDITORIAL_FORMATS: readonly EditorialFormat[] = [
  { id: "SHORT_MESSAGE", label: "Short message", description: "One short message, big and readable, on a plain or photographic background.", aspectRatios: ["9:16", "4:5", "1:1"], needsVerifiedFacts: false, implementation: "DEFINITION_ONLY" },
  { id: "CINEMATIC_QUOTE", label: "Cinematic quote", description: "A short line over a cinematic background with bold typography.", aspectRatios: ["9:16", "4:5"], needsVerifiedFacts: false, implementation: "DEFINITION_ONLY" },
  { id: "MEME_LAYOUT", label: "Meme layout", description: "A humorous text set in a meme layout, conversational language.", aspectRatios: ["1:1", "4:5", "9:16"], needsVerifiedFacts: false, implementation: "DEFINITION_ONLY" },
  { id: "COMMENTARY", label: "Commentary", description: "A short opinion or commentary text about a topic of the page.", aspectRatios: ["9:16", "4:5", "1:1"], needsVerifiedFacts: false, implementation: "DEFINITION_ONLY" },
  { id: "MATCH_FACT_CARD", label: "Match / player fact card", description: "Match, result or player information. Every name, number and date must be checked before approval.", aspectRatios: ["9:16", "4:5", "1:1"], needsVerifiedFacts: true, implementation: "DEFINITION_ONLY" },
  { id: "RELATIONSHIP_STORY", label: "Relationship text", description: "Emotional, relationship-oriented text with cinematic visuals.", aspectRatios: ["9:16", "4:5"], needsVerifiedFacts: false, implementation: "DEFINITION_ONLY" },
  { id: "LIFESTYLE_TIP", label: "Lifestyle tip", description: "A practical everyday tip or idea.", aspectRatios: ["9:16", "4:5", "1:1"], needsVerifiedFacts: false, implementation: "DEFINITION_ONLY" },
];

export const EDITORIAL_FORMAT_IDS: readonly string[] = EDITORIAL_FORMATS.map((f) => f.id);

// ------------------------------------------------------------------------------------------------ profile

/** The structured part of an editorial profile (the free-text identity/style lives beside it, see EditorialLayer). */
export interface EditorialProfile {
  contentPreferences?: {
    /** Ids from EDITORIAL_FORMATS. */
    formats?: string[];
    topics?: string[];
    avoidTopics?: string[];
    /** Terms that must not appear in the page's text (matched case-insensitively, at the start of a word). */
    avoidTerms?: string[];
    /** Longest text (characters) that suits the page. */
    maxTextLength?: number | null;
    /** The page's text must rest on checked facts (football, news): reminds the approver, never claims verification. */
    requiresVerifiedFacts?: boolean;
  };
  visual?: {
    style?: string | null;
    fonts?: string[];
    /** CSS hex colors, e.g. "#ff6a00". */
    colors?: string[];
    textPosition?: TextPosition | null;
    aspectRatio?: AspectRatio | null;
  };
  guidelines?: string | null;
  originality?: {
    /** Words-3-gram similarity at or above which a text counts as a repeat; null = the organization's publishing setting. */
    similarityThresholdPct?: number | null;
    /** How many of the page's most recent posts a new text is compared with; 0 switches the check off. */
    lookbackPosts?: number | null;
  };
  /** What the page rules (text length, avoided terms, originality) do when broken: WARN (default) or BLOCK. */
  ruleEnforcement?: RuleEnforcement | null;
}

/** One level of the inheritance chain (a category, a group or a page). */
export interface EditorialLayer {
  /** The page's editorial identity / the category's default editorial style. */
  editorialStyle?: string | null;
  language?: string | null;
  profile?: EditorialProfile | null;
}

export type LayerName = "page" | "group" | "category";
export type FieldSource = LayerName | "default" | "unset";

export const DEFAULT_ORIGINALITY_LOOKBACK = 30;

export interface ResolvedIdentity {
  editorialStyle: string | null;
  language: string | null;
  contentPreferences: {
    formats: string[];
    topics: string[];
    avoidTopics: string[];
    avoidTerms: string[];
    maxTextLength: number | null;
    requiresVerifiedFacts: boolean;
  };
  visual: { style: string | null; fonts: string[]; colors: string[]; textPosition: TextPosition | null; aspectRatio: AspectRatio | null };
  guidelines: string | null;
  originality: { similarityThresholdPct: number | null; lookbackPosts: number };
  ruleEnforcement: RuleEnforcement;
  /** Where every value came from: which level set it, a built-in default, or nothing (unset). */
  sources: Record<string, FieldSource>;
}

const isStr = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const isList = (v: unknown): v is string[] => Array.isArray(v) && v.some(isStr);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isBool = (v: unknown): v is boolean => typeof v === "boolean";

function cleanList(v: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of v) {
    const t = typeof s === "string" ? s.trim() : "";
    const key = t.toLowerCase();
    if (t && !seen.has(key)) {
      seen.add(key);
      out.push(t);
    }
  }
  return out;
}

type Layers = [LayerName, EditorialLayer | null | undefined][];

/** Resolves the effective editorial identity: page over group over category over built-in default. */
export function resolveEditorialIdentity(input: { category?: EditorialLayer | null; group?: EditorialLayer | null; page?: EditorialLayer | null }): ResolvedIdentity {
  const layers: Layers = [
    ["page", input.page],
    ["group", input.group],
    ["category", input.category],
  ];
  const sources: Record<string, FieldSource> = {};

  function pick<T>(field: string, get: (l: EditorialLayer) => unknown, ok: (v: unknown) => boolean, fallback: T, fallbackSource: FieldSource, map: (v: never) => T = (v) => v as T): T {
    for (const [name, layer] of layers) {
      if (!layer) continue;
      const v = get(layer);
      if (ok(v)) {
        sources[field] = name;
        return map(v as never);
      }
    }
    sources[field] = fallbackSource;
    return fallback;
  }
  const trimmed = (v: string) => v.trim();
  const list = (v: string[]) => cleanList(v);

  return {
    editorialStyle: pick<string | null>("editorialStyle", (l) => l.editorialStyle, isStr, null, "unset", trimmed),
    language: pick<string | null>("language", (l) => l.language, isStr, null, "unset", trimmed),
    contentPreferences: {
      formats: pick<string[]>("contentPreferences.formats", (l) => l.profile?.contentPreferences?.formats, isList, [], "unset", list),
      topics: pick<string[]>("contentPreferences.topics", (l) => l.profile?.contentPreferences?.topics, isList, [], "unset", list),
      avoidTopics: pick<string[]>("contentPreferences.avoidTopics", (l) => l.profile?.contentPreferences?.avoidTopics, isList, [], "unset", list),
      avoidTerms: pick<string[]>("contentPreferences.avoidTerms", (l) => l.profile?.contentPreferences?.avoidTerms, isList, [], "unset", list),
      maxTextLength: pick<number | null>("contentPreferences.maxTextLength", (l) => l.profile?.contentPreferences?.maxTextLength, (v) => isNum(v) && v > 0, null, "unset"),
      requiresVerifiedFacts: pick<boolean>("contentPreferences.requiresVerifiedFacts", (l) => l.profile?.contentPreferences?.requiresVerifiedFacts, isBool, false, "default"),
    },
    visual: {
      style: pick<string | null>("visual.style", (l) => l.profile?.visual?.style, isStr, null, "unset", trimmed),
      fonts: pick<string[]>("visual.fonts", (l) => l.profile?.visual?.fonts, isList, [], "unset", list),
      colors: pick<string[]>("visual.colors", (l) => l.profile?.visual?.colors, isList, [], "unset", list),
      textPosition: pick<TextPosition | null>("visual.textPosition", (l) => l.profile?.visual?.textPosition, (v) => (TEXT_POSITIONS as readonly unknown[]).includes(v), null, "unset"),
      aspectRatio: pick<AspectRatio | null>("visual.aspectRatio", (l) => l.profile?.visual?.aspectRatio, (v) => (ASPECT_RATIOS as readonly unknown[]).includes(v), null, "unset"),
    },
    guidelines: pick<string | null>("guidelines", (l) => l.profile?.guidelines, isStr, null, "unset", trimmed),
    originality: {
      similarityThresholdPct: pick<number | null>("originality.similarityThresholdPct", (l) => l.profile?.originality?.similarityThresholdPct, (v) => isNum(v) && v >= 1 && v <= 100, null, "unset"),
      lookbackPosts: pick<number>("originality.lookbackPosts", (l) => l.profile?.originality?.lookbackPosts, (v) => isNum(v) && v >= 0, DEFAULT_ORIGINALITY_LOOKBACK, "default"),
    },
    ruleEnforcement: pick<RuleEnforcement>("ruleEnforcement", (l) => l.profile?.ruleEnforcement, (v) => (RULE_ENFORCEMENTS as readonly unknown[]).includes(v), "WARN", "default"),
    sources,
  };
}

// ------------------------------------------------------------------------------------------------ handles

/** A page's public handle as it is stored and compared: trimmed, no leading "@", lower-case. */
export function normalizeHandle(raw: string): string {
  return raw.trim().replace(/^@+/, "").toLowerCase();
}

// ------------------------------------------------------------------------------------------------ page rules

/** Lower-case and fold the Turkish dotted/dotless i so "İSTANBUL" and "istanbul" compare equal. */
function fold(s: string): string {
  return s.toLowerCase().replace(/̇/g, "").replace(/ı/g, "i");
}

const severityOf = (identity: ResolvedIdentity): ValidationIssue["severity"] => (identity.ruleEnforcement === "BLOCK" ? "ERROR" : "WARNING");

/**
 * The page-specific content rules for one text: length, avoided terms and the reminder that facts must be verified.
 * They are guidance set by the organization for THIS page; by default they warn, and only when the page (or its
 * category) says BLOCK do they stop a publication. Nothing here claims that a text is true or original.
 */
export function checkPageRules(identity: ResolvedIdentity, text: string | null): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const t = text ?? "";
  const sev = severityOf(identity);
  const max = identity.contentPreferences.maxTextLength;
  const length = [...t].length;
  if (max !== null && length > max) {
    issues.push({ code: "PAGE_RULE_TEXT_TOO_LONG", severity: sev, field: "caption", message: `This page's rules ask for texts of at most ${max} characters; this one has ${length}.` });
  }
  const folded = fold(t);
  const hits = identity.contentPreferences.avoidTerms.filter((term) => {
    const f = fold(term.trim());
    if (!f) return false;
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "u");
    return re.test(folded);
  });
  if (hits.length > 0) {
    issues.push({ code: "PAGE_RULE_AVOIDED_TERM", severity: sev, field: "caption", message: `This page's rules say to avoid: ${hits.map((h) => `"${h}"`).join(", ")}. Reword the text or change the page's rules.` });
  }
  if (identity.contentPreferences.requiresVerifiedFacts && t.trim() !== "") {
    issues.push({ code: "PAGE_RULE_VERIFIED_FACTS", severity: "INFO", field: "content", message: "This page publishes factual content: check every name, number, score and date against a reliable source before approving. Socialith does not verify facts." });
  }
  return issues;
}

export interface PreviousPost {
  id: string;
  text: string | null;
}

export interface OriginalityMatch {
  id: string;
  similarityPct: number;
}

/** The closest of the page's recent posts that the text repeats (at or above the threshold), if any. */
export function findOriginalityMatch(text: string | null, previous: PreviousPost[], thresholdPct: number): OriginalityMatch | null {
  if (!text || text.trim() === "") return null;
  let best: OriginalityMatch | null = null;
  for (const p of previous) {
    if (!p.text || p.text.trim() === "") continue;
    const pct = similarityPercent(text, p.text);
    if (pct >= thresholdPct && (best === null || pct > best.similarityPct)) best = { id: p.id, similarityPct: pct };
  }
  return best;
}

/**
 * Originality of a text against the SAME page's recent posts (the cross-page repetition guard of the Publishing Center
 * is separate and unchanged). `fallbackThresholdPct` = the organization's publishing setting, used when the page sets
 * none. `previous` must already be limited to the page's lookback window.
 */
export function checkOriginality(identity: ResolvedIdentity, text: string | null, previous: PreviousPost[], fallbackThresholdPct: number): ValidationIssue[] {
  if (identity.originality.lookbackPosts <= 0) return [];
  const threshold = identity.originality.similarityThresholdPct ?? fallbackThresholdPct;
  const match = findOriginalityMatch(text, previous.slice(0, identity.originality.lookbackPosts), threshold);
  if (!match) return [];
  return [{ code: "PAGE_RULE_NOT_ORIGINAL", severity: severityOf(identity), field: "content", message: `This text is ${match.similarityPct}% the same as an earlier post on this page. Write something new for the page instead of repeating itself.` }];
}

// ------------------------------------------------------------------------------------------------ starter categories

export interface StarterCategory {
  name: string;
  slug: string;
  description: string;
  defaultEditorialStyle: string;
  profile: EditorialProfile;
}

/**
 * The starter set an administrator can add with one action. They are ordinary categories (editable and archivable);
 * only what the product brief states is filled in - no fonts, colors or positions are invented.
 */
export const STARTER_CATEGORIES: readonly StarterCategory[] = [
  {
    name: "Motivation",
    slug: "motivation",
    description: "Motivational and mindset pages.",
    defaultEditorialStyle: "Short motivational messages on cinematic backgrounds with bold typography.",
    profile: { contentPreferences: { formats: ["SHORT_MESSAGE", "CINEMATIC_QUOTE"] }, visual: { style: "Cinematic backgrounds, bold typography" } },
  },
  {
    name: "Football",
    slug: "football",
    description: "Football news, commentary and match content.",
    defaultEditorialStyle: "Football-related commentary built on verified player and match information, with a sports-oriented visual design.",
    profile: { contentPreferences: { formats: ["COMMENTARY", "MATCH_FACT_CARD"], requiresVerifiedFacts: true }, visual: { style: "Sports-oriented design" } },
  },
  {
    name: "Humor / Memes",
    slug: "humor-memes",
    description: "Humor and meme pages.",
    defaultEditorialStyle: "Short humorous texts in conversational language, set in meme layouts.",
    profile: { contentPreferences: { formats: ["MEME_LAYOUT"] }, visual: { style: "Meme layouts" } },
  },
  {
    name: "Relationships",
    slug: "relationships",
    description: "Relationship and emotional content.",
    defaultEditorialStyle: "Emotional text in a relationship-oriented editorial language with cinematic visuals.",
    profile: { contentPreferences: { formats: ["RELATIONSHIP_STORY", "CINEMATIC_QUOTE"] }, visual: { style: "Cinematic visuals" } },
  },
  {
    name: "Lifestyle",
    slug: "lifestyle",
    description: "Lifestyle, habits and everyday inspiration.",
    defaultEditorialStyle: "Practical, upbeat everyday tips and ideas.",
    profile: { contentPreferences: { formats: ["LIFESTYLE_TIP", "SHORT_MESSAGE"] } },
  },
  {
    name: "Entertainment",
    slug: "entertainment",
    description: "Entertainment, music, film, TV and culture.",
    defaultEditorialStyle: "Short commentary on entertainment and culture topics.",
    profile: { contentPreferences: { formats: ["COMMENTARY"] } },
  },
];
