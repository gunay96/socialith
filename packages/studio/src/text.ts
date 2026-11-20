/**
 * Text Library rules (pure): how a text is cleaned, compared and found. Nothing here writes or invents text.
 */

/** Longest single text (characters). A text is a line or a short paragraph for an image or a reel, not an article. */
export const TEXT_MAX_LENGTH = 2000;

/** Languages the library offers by default (BCP-47 primary tags). Any other well-formed tag is also accepted. */
export const COMMON_LANGUAGES: readonly { code: string; label: string }[] = [
  { code: "tr", label: "Turkish" },
  { code: "en", label: "English" },
  { code: "de", label: "German" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "ar", label: "Arabic" },
];

export const LANGUAGE_PATTERN = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/** Text categories an administrator can add with one action. Ordinary categories afterwards (editable, archivable). */
export const STARTER_TEXT_CATEGORIES: readonly { name: string; slug: string; description: string }[] = [
  { name: "Motivation", slug: "motivation", description: "Motivational and mindset messages." },
  { name: "Football", slug: "football", description: "Football commentary and headlines. Facts must be checked before approval." },
  { name: "Humor / Memes", slug: "humor-memes", description: "Short humorous texts and meme captions." },
  { name: "Relationships", slug: "relationships", description: "Emotional and relationship-oriented texts." },
  { name: "Lifestyle", slug: "lifestyle", description: "Everyday tips, habits and inspiration." },
  { name: "Artist campaigns", slug: "artist-campaigns", description: "Texts written for an artist's campaign. Never lyrics or statements the artist did not provide." },
];

// invisible characters that change nothing a reader sees but break comparisons, and bidi controls that can disguise text
const INVISIBLE = /[\u200B\u2060\uFEFF\u00AD]/g;
const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/g;
/** Drops C0/C1 control characters except the line feed (checked by code point, so no control characters sit in a pattern). */
function stripControl(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    const control = c <= 0x08 || c === 0x0b || c === 0x0c || (c >= 0x0e && c <= 0x1f) || (c >= 0x7f && c <= 0x9f);
    if (!control) out += ch;
  }
  return out;
}

/** Normalizes line endings, drops control/invisible characters, trims and collapses runs of blank lines. */
export function cleanText(raw: string): string {
  return stripControl(raw.replace(/\r\n?/g, "\n").replace(/\t/g, " "))
    .replace(INVISIBLE, "")
    .replace(BIDI_CONTROLS, "")
    .split("\n")
    .map((line) => line.replace(/[ \u00A0]+$/g, "").replace(/^[ \u00A0]+/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export type TextProblem = "EMPTY" | "TOO_LONG";

export function checkText(cleaned: string): TextProblem | null {
  if (cleaned === "") return "EMPTY";
  if ([...cleaned].length > TEXT_MAX_LENGTH) return "TOO_LONG";
  return null;
}

export function describeTextProblem(problem: TextProblem): string {
  return problem === "EMPTY" ? "The text is empty." : `The text is longer than ${TEXT_MAX_LENGTH} characters.`;
}

/**
 * The comparison form used to recognise the SAME text: case, spacing and punctuation are ignored, and the Turkish
 * dotted/dotless i is folded ("KAPI", "Kapı" and "kapi" match), but letters are never otherwise folded: "su" and "şu"
 * are different words and stay different.
 */
export function normalizeForDuplicate(text: string): string {
  return cleanText(text)
    .normalize("NFC")
    .toLowerCase()
    .replace(/\u0307/g, "")
    .replace(/ı/g, "i")
    .replace(/[^\p{L}\p{N}\p{M}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The form used for SEARCH: like the duplicate form but diacritics are removed too, so a person typing "guzel" finds
 * "güzel" (the database collation treats ı and i as different letters, see TD-30).
 */
export function normalizeForSearch(text: string): string {
  return normalizeForDuplicate(text)
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/ß/g, "ss")
    .replace(/\s+/g, " ")
    .trim();
}

/** Characters (code points) of a text, as shown to people. */
export const textLength = (text: string): number => [...text].length;
