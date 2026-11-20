/**
 * The fonts a recipe can use. Only fonts the renderer really has: the worker image installs `fonts-dejavu-core` and
 * `fonts-liberation`, so these are the families (and the two weights) whose files exist there. Nothing here is a font
 * the renderer would have to guess at.
 *
 * The browser preview uses the CSS stack, which resolves to the visitor's own copy of the family (or a close system
 * font): the preview shows the style, the final render uses the renderer's file. The interface says so.
 */
export const FONT_WEIGHTS = ["REGULAR", "BOLD"] as const;
export type FontWeight = (typeof FONT_WEIGHTS)[number];

export interface FontFamily {
  id: string;
  label: string;
  kind: "sans" | "serif" | "mono";
  /** CSS font-family stack for the browser preview. */
  css: string;
  /** Font files in the renderer image (Debian packages `fonts-dejavu-core` / `fonts-liberation`). */
  files: Record<FontWeight, string>;
  debianPackage: "fonts-dejavu-core" | "fonts-liberation";
}

export const FONT_FAMILIES: readonly FontFamily[] = [
  { id: "dejavu-sans", label: "DejaVu Sans", kind: "sans", css: '"DejaVu Sans", Verdana, "Segoe UI", sans-serif', files: { REGULAR: "DejaVuSans.ttf", BOLD: "DejaVuSans-Bold.ttf" }, debianPackage: "fonts-dejavu-core" },
  { id: "dejavu-serif", label: "DejaVu Serif", kind: "serif", css: '"DejaVu Serif", Georgia, "Times New Roman", serif', files: { REGULAR: "DejaVuSerif.ttf", BOLD: "DejaVuSerif-Bold.ttf" }, debianPackage: "fonts-dejavu-core" },
  { id: "liberation-sans", label: "Liberation Sans (Arial-style)", kind: "sans", css: '"Liberation Sans", Arial, Helvetica, sans-serif', files: { REGULAR: "LiberationSans-Regular.ttf", BOLD: "LiberationSans-Bold.ttf" }, debianPackage: "fonts-liberation" },
  { id: "liberation-serif", label: "Liberation Serif (Times-style)", kind: "serif", css: '"Liberation Serif", "Times New Roman", Times, serif', files: { REGULAR: "LiberationSerif-Regular.ttf", BOLD: "LiberationSerif-Bold.ttf" }, debianPackage: "fonts-liberation" },
  { id: "liberation-mono", label: "Liberation Mono (Courier-style)", kind: "mono", css: '"Liberation Mono", "Courier New", Courier, monospace', files: { REGULAR: "LiberationMono-Regular.ttf", BOLD: "LiberationMono-Bold.ttf" }, debianPackage: "fonts-liberation" },
];

export const FONT_IDS = FONT_FAMILIES.map((f) => f.id) as [string, ...string[]];
export const DEFAULT_FONT_ID = "dejavu-sans";

export const fontById = (id: string | null | undefined): FontFamily | undefined => FONT_FAMILIES.find((f) => f.id === id);

/** Finds a font by an id or a human name ("Liberation Sans", "dejavu sans"), so an editorial profile's font can be matched. */
export function matchFont(name: string): FontFamily | undefined {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return undefined;
  return FONT_FAMILIES.find((f) => f.id === wanted || f.label.toLowerCase() === wanted || f.label.toLowerCase().startsWith(`${wanted} `) || f.label.toLowerCase().replace(/\s*\(.*\)$/, "") === wanted);
}
