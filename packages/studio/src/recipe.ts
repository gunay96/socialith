import { z } from "zod";
import { ASPECT_RATIOS, TEXT_POSITIONS } from "@socialith/publishing";
import { FONT_IDS, FONT_WEIGHTS } from "./fonts.js";

/**
 * A content recipe says HOW source media and an approved text are combined: where the text sits, how it looks, how it
 * moves, how long it lasts and what is exported. A recipe is a definition: Phase 5B stores and previews it, the renderer
 * (Phase 5C) turns it into a file.
 *
 * Every setting is nullable. `null` means "not set by this recipe": the value then comes from the page, the page group,
 * the page category (the editorial identity of Phase 4) or from the built-in default, and the interface says which.
 * A value in the recipe is an explicit choice and overrides what it inherits.
 */

export const RECIPE_SCHEMA_VERSION = 1;

export const MEDIA_KINDS = ["IMAGE", "VIDEO"] as const;
export type RecipeMediaKind = (typeof MEDIA_KINDS)[number];

export const FIT_MODES = ["COVER", "CONTAIN"] as const;
export const TEXT_ALIGNS = ["LEFT", "CENTER", "RIGHT"] as const;
export const TEXT_TRANSFORMS = ["NONE", "UPPERCASE"] as const;
export const BACKGROUND_MODES = ["NONE", "BOX", "BAND"] as const;
export const TEXT_ANIMATIONS = ["NONE", "TYPEWRITER", "LINE_BY_LINE"] as const;
export const ENTRY_ANIMATIONS = ["NONE", "FADE_IN", "SLIDE_UP", "ZOOM_IN"] as const;
export const EXIT_ANIMATIONS = ["NONE", "FADE_OUT", "SLIDE_DOWN"] as const;
export const DURATION_MODES = ["SOURCE", "FIXED"] as const;
export const EXPORT_RESOLUTIONS = ["720", "1080"] as const;
export const EXPORT_FPS = [24, 25, 30] as const;
export const IMAGE_FORMATS = ["JPEG", "PNG"] as const;

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "use a 6-digit hex color such as #ffffff");
const pct = (min: number, max: number) => z.number().min(min).max(max);
const nullable = <T extends z.ZodTypeAny>(s: T) => s.nullable().default(null);

export const recipeConfigSchema = z
  .object({
    schemaVersion: z.literal(RECIPE_SCHEMA_VERSION).default(RECIPE_SCHEMA_VERSION),
    /** Which kinds of source media the recipe accepts (at least one). */
    compatibleMedia: z.array(z.enum(MEDIA_KINDS)).min(1, "choose at least one media type").max(2).default(["IMAGE", "VIDEO"]),
    aspectRatio: nullable(z.enum(ASPECT_RATIOS)),
    /** How the source fills the frame when its shape differs: COVER crops, CONTAIN keeps the whole picture with bars. */
    fit: nullable(z.enum(FIT_MODES)),
    typography: z
      .object({
        font: nullable(z.enum(FONT_IDS)),
        /** Font size as a percentage of the frame height, so it means the same at any resolution. */
        sizePct: nullable(pct(2, 14)),
        weight: nullable(z.enum(FONT_WEIGHTS)),
        color: nullable(hexColor),
        transform: nullable(z.enum(TEXT_TRANSFORMS)),
        shadow: nullable(z.boolean()),
      })
      .strict()
      .default({}),
    position: z
      .object({
        vertical: nullable(z.enum(TEXT_POSITIONS)),
        align: nullable(z.enum(TEXT_ALIGNS)),
        /** Moves the text block up (negative) or down (positive), as a percentage of the frame height. */
        offsetPct: nullable(pct(-25, 25)),
        /** Width of the text block as a percentage of the frame width. */
        maxWidthPct: nullable(pct(40, 100)),
      })
      .strict()
      .default({}),
    background: z
      .object({
        mode: nullable(z.enum(BACKGROUND_MODES)),
        color: nullable(hexColor),
        opacityPct: nullable(pct(0, 100)),
        paddingPct: nullable(pct(0, 8)),
      })
      .strict()
      .default({}),
    animation: z
      .object({
        text: nullable(z.enum(TEXT_ANIMATIONS)),
        entry: nullable(z.enum(ENTRY_ANIMATIONS)),
        exit: nullable(z.enum(EXIT_ANIMATIONS)),
        entryMs: nullable(pct(100, 3000)),
        exitMs: nullable(pct(100, 3000)),
      })
      .strict()
      .default({}),
    duration: z
      .object({
        /** SOURCE: a video keeps its own length and an image stays a picture. FIXED: the output lasts `seconds`. */
        mode: nullable(z.enum(DURATION_MODES)),
        seconds: nullable(pct(1, 60)),
      })
      .strict()
      .default({}),
    subtitles: z
      .object({
        enabled: nullable(z.boolean()),
        position: nullable(z.enum(TEXT_POSITIONS)),
        wordsPerCue: nullable(z.number().int().min(1).max(12)),
        color: nullable(hexColor),
        background: nullable(z.boolean()),
      })
      .strict()
      .default({}),
    export: z
      .object({
        /** The shorter side of the frame in pixels (portrait/square) or its height (16:9). */
        resolution: nullable(z.enum(EXPORT_RESOLUTIONS)),
        fps: nullable(z.union([z.literal(24), z.literal(25), z.literal(30)])),
        imageFormat: nullable(z.enum(IMAGE_FORMATS)),
      })
      .strict()
      .default({}),
  })
  .strict();

export type RecipeConfig = z.infer<typeof recipeConfigSchema>;

/**
 * What the preview may change without saving: any subset of the recipe's settings (a missing or null value means "no
 * adjustment", so the saved recipe, the page or the default still decides).
 */
export const recipeAdjustmentSchema = recipeConfigSchema.omit({ schemaVersion: true, compatibleMedia: true });
export type RecipeAdjustment = z.infer<typeof recipeAdjustmentSchema>;

/** The built-in defaults, used when neither the recipe nor the page's editorial identity sets a value. */
export const RECIPE_DEFAULTS = {
  aspectRatio: "9:16",
  fit: "COVER",
  font: "dejavu-sans",
  sizePct: 5,
  weight: "BOLD",
  color: "#ffffff",
  transform: "NONE",
  shadow: true,
  vertical: "CENTER",
  align: "CENTER",
  offsetPct: 0,
  maxWidthPct: 84,
  backgroundMode: "NONE",
  backgroundColor: "#000000",
  backgroundOpacityPct: 55,
  backgroundPaddingPct: 2,
  textAnimation: "NONE",
  entryAnimation: "NONE",
  exitAnimation: "NONE",
  entryMs: 600,
  exitMs: 500,
  durationMode: "SOURCE",
  durationSeconds: 8,
  subtitlesEnabled: false,
  subtitlesPosition: "BOTTOM",
  subtitlesWordsPerCue: 4,
  subtitlesColor: "#ffffff",
  subtitlesBackground: true,
  exportResolution: "1080",
  exportFps: 30,
  imageFormat: "JPEG",
} as const;

/** A blank recipe: every setting inherits. */
export function emptyRecipeConfig(overrides: Partial<Pick<RecipeConfig, "compatibleMedia">> = {}): RecipeConfig {
  return recipeConfigSchema.parse({ ...overrides });
}

export type ParsedRecipeConfig = { ok: true; config: RecipeConfig } | { ok: false; message: string; issues: { path: string; message: string }[] };

/** Validates and fills a stored or submitted configuration. Unknown keys are refused, not dropped. */
export function parseRecipeConfig(input: unknown): ParsedRecipeConfig {
  const parsed = recipeConfigSchema.safeParse(input ?? {});
  if (parsed.success) return { ok: true, config: parsed.data };
  const issues = parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
  return { ok: false, message: `${issues[0]?.path || "configuration"}: ${issues[0]?.message ?? "invalid"}`, issues };
}

export const RECIPE_NAME_MAX = 120;
