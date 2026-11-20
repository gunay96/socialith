import type { RecipeMediaKind } from "./recipe.js";

/**
 * Which recipes suit a page. A recipe can be limited to individual pages, page groups and/or page categories; a recipe
 * with none of these applies everywhere. For a given page the most specific match comes first:
 * page > page group > page category > everyone. Several recipes per page and per category are normal: they are all
 * offered, in that order.
 */
export interface RecipeScope {
  id: string;
  name: string;
  status: "ACTIVE" | "ARCHIVED";
  pageIds: string[];
  pageGroupIds: string[];
  pageCategoryIds: string[];
  compatibleMedia: RecipeMediaKind[];
}

export interface PageScope {
  id: string;
  categoryId: string | null;
  groupIds: string[];
}

export type RecipeMatch = "page" | "group" | "category" | "everyone";
const RANK: Record<RecipeMatch, number> = { page: 0, group: 1, category: 2, everyone: 3 };

/** How (and whether) one recipe applies to a page. `null` = it is limited to other pages/groups/categories. */
export function matchRecipeToPage(recipe: Pick<RecipeScope, "pageIds" | "pageGroupIds" | "pageCategoryIds">, page: PageScope): RecipeMatch | null {
  if (recipe.pageIds.length === 0 && recipe.pageGroupIds.length === 0 && recipe.pageCategoryIds.length === 0) return "everyone";
  if (recipe.pageIds.includes(page.id)) return "page";
  if (recipe.pageGroupIds.some((g) => page.groupIds.includes(g))) return "group";
  if (page.categoryId && recipe.pageCategoryIds.includes(page.categoryId)) return "category";
  return null;
}

export function selectRecipesForPage<R extends RecipeScope>(recipes: R[], page: PageScope, options: { mediaKind?: RecipeMediaKind } = {}): { recipe: R; matchedBy: RecipeMatch }[] {
  const out: { recipe: R; matchedBy: RecipeMatch }[] = [];
  for (const recipe of recipes) {
    if (recipe.status !== "ACTIVE") continue;
    if (options.mediaKind && !recipe.compatibleMedia.includes(options.mediaKind)) continue;
    const matchedBy = matchRecipeToPage(recipe, page);
    if (matchedBy) out.push({ recipe, matchedBy });
  }
  return out.sort((x, y) => RANK[x.matchedBy] - RANK[y.matchedBy] || x.recipe.name.localeCompare(y.recipe.name));
}
