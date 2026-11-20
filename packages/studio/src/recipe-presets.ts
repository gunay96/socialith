import { recipeConfigSchema, type RecipeConfig } from "./recipe.js";

/**
 * The starting recipes. They are ordinary recipes once installed (editable, duplicable, archivable); the preset key is
 * only kept so the origin is traceable. Presets set the look of the format (typeface, size, background, motion) and
 * deliberately leave the text color and the text position empty where the format does not need a fixed value, so a
 * page's or category's own editorial preferences decide them.
 */
export interface RecipePreset {
  key: string;
  name: string;
  description: string;
  /** An id from EDITORIAL_FORMATS (Phase 4), or null for the blank recipe. */
  formatId: string | null;
  /** Slug of the text category the recipe asks for; resolved to the organization's category when it exists. */
  textCategorySlug: string | null;
  config: RecipeConfig;
}

const make = (input: Record<string, unknown>): RecipeConfig => recipeConfigSchema.parse(input);

export const RECIPE_PRESETS: readonly RecipePreset[] = [
  {
    key: "MOTIVATION_CINEMATIC_QUOTE",
    name: "Motivation - Cinematic Quote",
    description: "A short motivational line over a cinematic image or clip: serif type, soft fade in and out, centred.",
    formatId: "CINEMATIC_QUOTE",
    textCategorySlug: "motivation",
    config: make({
      compatibleMedia: ["IMAGE", "VIDEO"],
      aspectRatio: "9:16",
      fit: "COVER",
      typography: { font: "liberation-serif", sizePct: 5.5, weight: "BOLD", shadow: true },
      position: { align: "CENTER", maxWidthPct: 80 },
      background: { mode: "NONE" },
      animation: { entry: "FADE_IN", exit: "FADE_OUT", entryMs: 900, exitMs: 700 },
      duration: { mode: "FIXED", seconds: 8 },
    }),
  },
  {
    key: "FOOTBALL_HEADLINE_OVERLAY",
    name: "Football - Headline Overlay",
    description: "A bold uppercase headline on a dark band over a match image or clip. Every name, score and date must be checked before approval.",
    formatId: "MATCH_FACT_CARD",
    textCategorySlug: "football",
    config: make({
      compatibleMedia: ["IMAGE", "VIDEO"],
      aspectRatio: "9:16",
      fit: "COVER",
      typography: { font: "dejavu-sans", sizePct: 4.5, weight: "BOLD", transform: "UPPERCASE", shadow: false },
      position: { vertical: "LOWER_THIRD", align: "LEFT", maxWidthPct: 90 },
      background: { mode: "BAND", color: "#000000", opacityPct: 72, paddingPct: 2.5 },
      animation: { entry: "SLIDE_UP", exit: "FADE_OUT", entryMs: 500, exitMs: 400 },
      duration: { mode: "SOURCE" },
    }),
  },
  {
    key: "MEME_IMAGE_CAPTION",
    name: "Meme - Image Caption",
    description: "A big uppercase caption at the top of a square image, in the classic meme style. The result stays a still image.",
    formatId: "MEME_LAYOUT",
    textCategorySlug: "humor-memes",
    config: make({
      compatibleMedia: ["IMAGE"],
      aspectRatio: "1:1",
      fit: "COVER",
      typography: { font: "liberation-sans", sizePct: 7, weight: "BOLD", color: "#ffffff", transform: "UPPERCASE", shadow: true },
      position: { vertical: "TOP", align: "CENTER", maxWidthPct: 92 },
      background: { mode: "NONE" },
      animation: { text: "NONE", entry: "NONE", exit: "NONE" },
      duration: { mode: "SOURCE" },
      export: { imageFormat: "JPEG" },
    }),
  },
  {
    key: "RELATIONSHIP_EMOTIONAL_QUOTE",
    name: "Relationship - Emotional Quote",
    description: "An emotional line over a soft dark box on a 4:5 picture or clip, revealed line by line.",
    formatId: "RELATIONSHIP_STORY",
    textCategorySlug: "relationships",
    config: make({
      compatibleMedia: ["IMAGE", "VIDEO"],
      aspectRatio: "4:5",
      fit: "COVER",
      typography: { font: "dejavu-serif", sizePct: 4.2, weight: "REGULAR", shadow: false },
      position: { vertical: "CENTER", align: "CENTER", maxWidthPct: 78 },
      background: { mode: "BOX", color: "#000000", opacityPct: 38, paddingPct: 3 },
      animation: { text: "LINE_BY_LINE", entry: "FADE_IN", exit: "FADE_OUT", entryMs: 800, exitMs: 600 },
      duration: { mode: "FIXED", seconds: 9 },
    }),
  },
  {
    key: "CUSTOM",
    name: "Custom recipe",
    description: "A blank recipe: everything is inherited from the page, the page group, the category or the built-in defaults until you set it.",
    formatId: null,
    textCategorySlug: null,
    config: make({ compatibleMedia: ["IMAGE", "VIDEO"] }),
  },
];

export const presetByKey = (key: string): RecipePreset | undefined => RECIPE_PRESETS.find((p) => p.key === key);
