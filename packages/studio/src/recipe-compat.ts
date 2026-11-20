import { EDITORIAL_FORMATS, checkPageRules, type ResolvedIdentity, type ValidationIssue } from "@socialith/publishing";
import { aspectDecimal, exportSize } from "./layout.js";
import type { RecipeConfig } from "./recipe.js";
import type { EffectiveRecipe } from "./recipe-resolve.js";
import { matchRecipeToPage, type RecipeScope } from "./recipe-select.js";
import { textLength } from "./text.js";

/**
 * Does this recipe fit this media, this text and this page (or page group)? Pure and shared by the API and the preview.
 *
 *   ERROR    the combination must not be rendered or published as it is
 *   WARNING  allowed, but a person should look at it
 *   INFO     good to know
 *
 * For a PREVIEW an unapproved text is only a warning (an editor may try a draft text); for a RENDER it is an error.
 * Nothing here judges whether a text is true or whether a picture is allowed to be used beyond what a person recorded.
 */
export interface CompatAsset {
  kind: "VIDEO" | "IMAGE" | "AUDIO" | "TEXT" | "SPREADSHEET";
  status: string;
  rightsStatus: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
}

export interface CompatText {
  body: string;
  language: string | null;
  approvalStatus: string;
  rightsStatus: string;
  categoryIds: string[];
  pageIds: string[];
  pageGroupIds: string[];
  pageCategoryIds: string[];
}

export type CompatTarget =
  | { kind: "page"; id: string; categoryId: string | null; groupIds: string[]; language: string | null; identity: ResolvedIdentity | null }
  | { kind: "group"; id: string; memberPageIds: string[]; memberCategoryIds: string[]; identity: ResolvedIdentity | null };

export interface CompatInput {
  recipe: Pick<RecipeScope, "pageIds" | "pageGroupIds" | "pageCategoryIds"> & { config: RecipeConfig; formatId: string | null; requiredTextCategoryId: string | null };
  effective: EffectiveRecipe;
  asset?: CompatAsset | null;
  text?: CompatText | null;
  target?: CompatTarget | null;
  purpose: "PREVIEW" | "RENDER";
}

const issue = (code: string, severity: ValidationIssue["severity"], field: ValidationIssue["field"], message: string): ValidationIssue => ({ code, severity, field, message });

export function recipeAppliesToTarget(recipe: Pick<RecipeScope, "pageIds" | "pageGroupIds" | "pageCategoryIds">, target: CompatTarget): boolean {
  if (target.kind === "page") return matchRecipeToPage(recipe, { id: target.id, categoryId: target.categoryId, groupIds: target.groupIds }) !== null;
  const unrestricted = recipe.pageIds.length + recipe.pageGroupIds.length + recipe.pageCategoryIds.length === 0;
  return unrestricted || recipe.pageGroupIds.includes(target.id) || recipe.pageIds.some((p) => target.memberPageIds.includes(p)) || recipe.pageCategoryIds.some((c) => target.memberCategoryIds.includes(c));
}

function textAppliesToTarget(text: CompatText, target: CompatTarget): boolean {
  const unrestricted = text.pageIds.length + text.pageGroupIds.length + text.pageCategoryIds.length === 0;
  if (unrestricted) return true;
  if (target.kind === "page") return text.pageIds.includes(target.id) || text.pageGroupIds.some((g) => target.groupIds.includes(g)) || (target.categoryId !== null && text.pageCategoryIds.includes(target.categoryId));
  return text.pageGroupIds.includes(target.id) || text.pageIds.some((p) => target.memberPageIds.includes(p)) || text.pageCategoryIds.some((c) => target.memberCategoryIds.includes(c));
}

export function checkRecipeCompatibility(input: CompatInput): ValidationIssue[] {
  const { recipe, effective, asset, text, target, purpose } = input;
  const v = effective.values;
  const issues: ValidationIssue[] = [];
  const render = purpose === "RENDER";

  const format = recipe.formatId ? EDITORIAL_FORMATS.find((f) => f.id === recipe.formatId) : undefined;
  if (format?.needsVerifiedFacts) {
    issues.push(issue("FORMAT_NEEDS_VERIFIED_FACTS", "INFO", "content", `The "${format.label}" format publishes factual content: check every name, number and date before approving. Socialith does not verify facts.`));
  }

  if (asset) {
    if (asset.kind !== "IMAGE" && asset.kind !== "VIDEO") {
      issues.push(issue("ASSET_KIND_UNSUPPORTED", "ERROR", "media", `A ${asset.kind.toLowerCase()} file cannot be the picture of a recipe. Choose an image or a video.`));
    } else if (!recipe.config.compatibleMedia.includes(asset.kind)) {
      issues.push(issue("ASSET_KIND_NOT_ACCEPTED", "ERROR", "media", `This recipe accepts ${recipe.config.compatibleMedia.map((k) => k.toLowerCase()).join(" or ")} only; the chosen file is ${asset.kind === "IMAGE" ? "an image" : "a video"}.`));
    }
    if (asset.status !== "READY") issues.push(issue("ASSET_NOT_READY", "ERROR", "media", `The chosen file is ${asset.status.toLowerCase()}, not ready to use.`));
    if (asset.rightsStatus === "RESTRICTED") issues.push(issue("ASSET_RIGHTS_RESTRICTED", "ERROR", "media", "This file is marked 'do not use'. Choose another file or ask an administrator to review its usage rights."));
    if ((asset.kind === "IMAGE" || asset.kind === "VIDEO") && asset.status === "READY") {
      if (asset.width === null || asset.height === null) {
        issues.push(issue("ASSET_SIZE_UNKNOWN", "WARNING", "media", "The size of this file was not measured, so cropping and quality cannot be checked. Use Re-analyze on the file."));
      } else {
        const out = exportSize(v.aspectRatio, v.exportResolution);
        const sourceRatio = asset.width / asset.height;
        const targetRatio = aspectDecimal(v.aspectRatio);
        if (Math.abs(sourceRatio - targetRatio) / targetRatio > 0.02) {
          issues.push(issue("ASSET_ASPECT_DIFFERS", "INFO", "media", v.fit === "COVER" ? `The picture is ${asset.width}x${asset.height} and the output is ${v.aspectRatio}: it will be cropped to fill the frame.` : `The picture is ${asset.width}x${asset.height} and the output is ${v.aspectRatio}: the whole picture is kept, with empty bars.`));
        }
        if (asset.width < out.width * 0.75 && asset.height < out.height * 0.75) {
          issues.push(issue("ASSET_LOW_RESOLUTION", "WARNING", "media", `The picture (${asset.width}x${asset.height}) is smaller than the ${out.width}x${out.height} output and will look soft. Choose a larger file or a lower export resolution.`));
        }
      }
      const animated = v.textAnimation !== "NONE" || v.entryAnimation !== "NONE" || v.exitAnimation !== "NONE";
      if (asset.kind === "IMAGE" && animated && v.durationMode === "SOURCE") {
        issues.push(issue("ANIMATION_NEEDS_DURATION", "WARNING", "content", "Animation needs a video. With an image, set a fixed duration in the recipe; otherwise the result is a still image without motion."));
      }
      if (asset.kind === "VIDEO" && asset.durationMs !== null && v.durationMode === "FIXED" && v.durationSeconds * 1000 > asset.durationMs) {
        issues.push(issue("DURATION_LONGER_THAN_SOURCE", "WARNING", "media", `The recipe asks for ${v.durationSeconds} s but the video lasts ${(asset.durationMs / 1000).toFixed(1)} s.`));
      }
    }
  }

  if (text) {
    if (text.approvalStatus === "ARCHIVED") issues.push(issue("TEXT_ARCHIVED", "ERROR", "caption", "This text is archived. Restore it or choose another."));
    else if (text.approvalStatus === "REJECTED") issues.push(issue("TEXT_REJECTED", "ERROR", "caption", "This text was rejected. Choose another text."));
    else if (text.approvalStatus !== "APPROVED") issues.push(issue("TEXT_NOT_APPROVED", render ? "ERROR" : "WARNING", "caption", render ? "Only approved texts can be rendered. Ask an administrator to approve this text." : "This text is not approved yet. It is fine for trying a layout, but it cannot be rendered or published until an administrator approves it."));
    if (text.rightsStatus === "RESTRICTED") issues.push(issue("TEXT_RIGHTS_RESTRICTED", "ERROR", "caption", "This text is marked 'do not use'. Choose another text."));
    else if (text.rightsStatus === "UNVERIFIED") issues.push(issue("TEXT_RIGHTS_UNVERIFIED", "INFO", "caption", "The usage rights of this text have not been confirmed."));
    if (recipe.requiredTextCategoryId && !text.categoryIds.includes(recipe.requiredTextCategoryId)) {
      issues.push(issue("TEXT_CATEGORY_MISMATCH", "WARNING", "caption", "This recipe is meant for texts of a different category. Check that the text suits the recipe."));
    }
    if (target?.kind === "page" && target.language && text.language && text.language.split("-")[0] !== target.language.split("-")[0]) {
      issues.push(issue("TEXT_LANGUAGE_MISMATCH", "WARNING", "caption", `The text is in "${text.language}" but the page publishes in "${target.language}".`));
    }
    if (target && !textAppliesToTarget(text, target)) {
      issues.push(issue("TEXT_NOT_FOR_TARGET", "WARNING", "caption", `This text is limited to other pages, groups or page categories than the one chosen.`));
    }
    if (target?.identity) issues.push(...checkPageRules(target.identity, text.body));
    if (textLength(text.body) > 220 && v.sizePct >= 5) {
      issues.push(issue("TEXT_LONG_FOR_SIZE", "INFO", "caption", "This is a long text for a large font size; it may fill much of the frame. Lower the font size or widen the text block if it looks crowded."));
    }
  }

  if (target && !recipeAppliesToTarget(recipe, target)) {
    issues.push(issue("RECIPE_NOT_FOR_TARGET", "WARNING", "content", target.kind === "page" ? "This recipe is limited to other pages, page groups or page categories than this page." : "This recipe is limited to other pages, page groups or page categories than this group."));
  }
  if (v.vertical === "BOTTOM" && v.aspectRatio === "9:16") {
    issues.push(issue("TEXT_NEAR_PLATFORM_UI", "INFO", "content", "Text at the very bottom of a vertical video can be covered by the platform's own buttons and caption. This is an assumption, not a measured safe area."));
  }
  return issues;
}

export const hasBlockingIssue = (issues: ValidationIssue[]): boolean => issues.some((i) => i.severity === "ERROR");
