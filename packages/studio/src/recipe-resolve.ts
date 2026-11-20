import type { AspectRatio, FieldSource, ResolvedIdentity, TextPosition } from "@socialith/publishing";
import { fontById, matchFont, type FontWeight } from "./fonts.js";
import { RECIPE_DEFAULTS, type RecipeAdjustment, type RecipeConfig } from "./recipe.js";

/**
 * Effective recipe settings: one value per setting, and where it came from.
 *
 * Order, most specific first:
 *   1. adjustment  - a change made in the preview and not saved
 *   2. recipe      - an explicit setting saved in the recipe
 *   3. page > group > category - the editorial identity of the page (Phase 4), only for the settings it describes
 *      (font, text color, text position, aspect ratio)
 *   4. default     - the built-in default
 *
 * So a category's visual defaults apply first, a page's own preferences override them, and a recipe only overrides both
 * where it sets a value on purpose. A recipe that leaves a setting empty (null) lets the page and category decide.
 */
export type SettingSource = "adjustment" | "recipe" | "page" | "group" | "category" | "default";

export interface EffectiveValues {
  aspectRatio: AspectRatio;
  fit: "COVER" | "CONTAIN";
  font: string;
  sizePct: number;
  weight: FontWeight;
  color: string;
  transform: "NONE" | "UPPERCASE";
  shadow: boolean;
  vertical: TextPosition;
  align: "LEFT" | "CENTER" | "RIGHT";
  offsetPct: number;
  maxWidthPct: number;
  backgroundMode: "NONE" | "BOX" | "BAND";
  backgroundColor: string;
  backgroundOpacityPct: number;
  backgroundPaddingPct: number;
  textAnimation: "NONE" | "TYPEWRITER" | "LINE_BY_LINE";
  entryAnimation: "NONE" | "FADE_IN" | "SLIDE_UP" | "ZOOM_IN";
  exitAnimation: "NONE" | "FADE_OUT" | "SLIDE_DOWN";
  entryMs: number;
  exitMs: number;
  durationMode: "SOURCE" | "FIXED";
  durationSeconds: number;
  subtitlesEnabled: boolean;
  subtitlesPosition: TextPosition;
  subtitlesWordsPerCue: number;
  subtitlesColor: string;
  subtitlesBackground: boolean;
  exportResolution: "720" | "1080";
  exportFps: 24 | 25 | 30;
  imageFormat: "JPEG" | "PNG";
}

export type EffectiveKey = keyof EffectiveValues;

export interface EffectiveRecipe {
  values: EffectiveValues;
  sources: Record<EffectiveKey, SettingSource>;
  /** Things the person should know, e.g. a font named by a page that the renderer does not have. */
  warnings: string[];
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const isSet = (v: unknown): boolean => v !== null && v !== undefined;
const fromLayer = (s: FieldSource | undefined): SettingSource | null => (s === "page" || s === "group" || s === "category" ? s : null);

type Candidate = { value: unknown; source: SettingSource };

/** Resolves every setting. `identity` is the page's resolved editorial identity (omit it when no page is chosen). */
export function resolveEffectiveRecipe(input: { config: RecipeConfig; adjustment?: RecipeAdjustment | null; identity?: ResolvedIdentity | null }): EffectiveRecipe {
  const { config: c, identity } = input;
  const a = input.adjustment ?? null;
  const warnings: string[] = [];

  // what the editorial identity offers, already filtered to values the renderer can use
  let identityFont: Candidate | null = null;
  const fontName = identity?.visual.fonts[0];
  const fontSource = fromLayer(identity?.sources["visual.fonts"]);
  if (fontName && fontSource) {
    const match = matchFont(fontName);
    if (match) identityFont = { value: match.id, source: fontSource };
    else warnings.push(`The ${fontSource} asks for the font "${fontName}", which the renderer does not have. The default font is used instead; choose one of the available fonts in the recipe to override.`);
  }
  let identityColor: Candidate | null = null;
  const colorValue = identity?.visual.colors[0];
  const colorSource = fromLayer(identity?.sources["visual.colors"]);
  if (colorValue && colorSource) {
    if (HEX.test(colorValue)) identityColor = { value: colorValue.toLowerCase(), source: colorSource };
    else warnings.push(`The ${colorSource}'s first color "${colorValue}" is not a 6-digit hex color, so it is not used for the text.`);
  }
  const identityPosition: Candidate | null = identity?.visual.textPosition && fromLayer(identity.sources["visual.textPosition"]) ? { value: identity.visual.textPosition, source: fromLayer(identity.sources["visual.textPosition"])! } : null;
  const identityAspect: Candidate | null = identity?.visual.aspectRatio && fromLayer(identity.sources["visual.aspectRatio"]) ? { value: identity.visual.aspectRatio, source: fromLayer(identity.sources["visual.aspectRatio"])! } : null;

  const sources = {} as Record<EffectiveKey, SettingSource>;
  const values = {} as Record<EffectiveKey, unknown>;
  function pick<K extends EffectiveKey>(key: K, adjusted: unknown, saved: unknown, inherited: Candidate | null = null): void {
    if (isSet(adjusted)) {
      values[key] = adjusted;
      sources[key] = "adjustment";
    } else if (isSet(saved)) {
      values[key] = saved;
      sources[key] = "recipe";
    } else if (inherited) {
      values[key] = inherited.value;
      sources[key] = inherited.source;
    } else {
      values[key] = RECIPE_DEFAULTS[key];
      sources[key] = "default";
    }
  }

  pick("aspectRatio", a?.aspectRatio, c.aspectRatio, identityAspect);
  pick("fit", a?.fit, c.fit);
  pick("font", a?.typography.font, c.typography.font, identityFont);
  pick("sizePct", a?.typography.sizePct, c.typography.sizePct);
  pick("weight", a?.typography.weight, c.typography.weight);
  pick("color", a?.typography.color, c.typography.color, identityColor);
  pick("transform", a?.typography.transform, c.typography.transform);
  pick("shadow", a?.typography.shadow, c.typography.shadow);
  pick("vertical", a?.position.vertical, c.position.vertical, identityPosition);
  pick("align", a?.position.align, c.position.align);
  pick("offsetPct", a?.position.offsetPct, c.position.offsetPct);
  pick("maxWidthPct", a?.position.maxWidthPct, c.position.maxWidthPct);
  pick("backgroundMode", a?.background.mode, c.background.mode);
  pick("backgroundColor", a?.background.color, c.background.color);
  pick("backgroundOpacityPct", a?.background.opacityPct, c.background.opacityPct);
  pick("backgroundPaddingPct", a?.background.paddingPct, c.background.paddingPct);
  pick("textAnimation", a?.animation.text, c.animation.text);
  pick("entryAnimation", a?.animation.entry, c.animation.entry);
  pick("exitAnimation", a?.animation.exit, c.animation.exit);
  pick("entryMs", a?.animation.entryMs, c.animation.entryMs);
  pick("exitMs", a?.animation.exitMs, c.animation.exitMs);
  pick("durationMode", a?.duration.mode, c.duration.mode);
  pick("durationSeconds", a?.duration.seconds, c.duration.seconds);
  pick("subtitlesEnabled", a?.subtitles.enabled, c.subtitles.enabled);
  pick("subtitlesPosition", a?.subtitles.position, c.subtitles.position);
  pick("subtitlesWordsPerCue", a?.subtitles.wordsPerCue, c.subtitles.wordsPerCue);
  pick("subtitlesColor", a?.subtitles.color, c.subtitles.color);
  pick("subtitlesBackground", a?.subtitles.background, c.subtitles.background);
  pick("exportResolution", a?.export.resolution, c.export.resolution);
  pick("exportFps", a?.export.fps, c.export.fps);
  pick("imageFormat", a?.export.imageFormat, c.export.imageFormat);

  // a stored font id that no longer exists must not reach the renderer
  if (!fontById(values.font as string)) {
    warnings.push(`The font "${String(values.font)}" is not available; the default font is used.`);
    values.font = RECIPE_DEFAULTS.font;
    sources.font = "default";
  }
  return { values: values as unknown as EffectiveValues, sources, warnings };
}

/** Plain-language label of a source, for the interface. */
export function describeSource(source: SettingSource): string {
  switch (source) {
    case "adjustment":
      return "Changed in this preview (not saved)";
    case "recipe":
      return "Set in this recipe";
    case "page":
      return "Inherited from the page";
    case "group":
      return "Inherited from the page group";
    case "category":
      return "Inherited from the page category";
    case "default":
      return "Built-in default";
  }
}
