# Content Recipe Engine (Phase 5B)

A **recipe** says how a source picture or video and an approved text are combined: where the text sits, how it looks and moves, how long the result lasts, and what is exported. **Phase 5B defines, stores and previews recipes. It does not render media.** The renderer (Phase 5C) turns a recipe into a file; until then nothing on this page produces an asset, and the interface says so wherever a preview appears ("Preview · not a rendered file").

Screens: **Content Studio → Recipes** (`/studio/recipes`: presets, list, filters) and the **recipe builder** (`/studio/recipes/:id`: settings on the left, live preview on the right).

## 1. What a recipe holds

* Name, description, an editorial **format** (the Phase 4 format ids: Cinematic quote, Meme layout, Match / player fact card, Relationship text …), the **text category** it asks for, which media it **works with** (images, videos).
* **Applies to**: page categories, page groups and individual pages (the existing Page Network models, referenced). No assignment = offered for every page.
* **Settings** (`RecipeConfig`, schema version 1, validated by one shared schema used by the API and the preview):

| Group | Settings |
|---|---|
| Frame and export | aspect ratio (9:16, 4:5, 1:1, 16:9), how the picture fills the frame (crop or keep everything), export size (720 / 1080), frames per second (24/25/30), still-image format (JPEG/PNG) |
| Text | font (the five families the renderer really has), weight (regular, bold), size (% of frame height), color, letter case, shadow |
| Position | vertical position (top, upper third, middle, lower third, bottom), alignment, nudge up or down, width of the text block |
| Text background | none, box around the text, or band across the frame; color, opacity, padding |
| Motion and length | text animation (typewriter, line by line), entry (fade in, slide up, zoom in), exit (fade out, slide down), their speeds, length (follow the source, or a fixed number of seconds) |
| Subtitles | on/off, position, words per line, color, dark box. Generated from the **text** only; nothing is transcribed from audio |

Every setting is **nullable**: `null` means "this recipe does not set it", and the value then comes from the page, its group, its category or the built-in default (§3).

**Fonts** are the families whose files exist in the worker image (`fonts-dejavu-core`, `fonts-liberation`): DejaVu Sans / Serif, Liberation Sans / Serif / Mono, regular and bold. A font a page's editorial identity names but the renderer does not have is **not used**: the default applies and the preview says why.

## 2. Presets

Five starting recipes (an administrator adds them one by one or all at once; afterwards they are ordinary recipes; the preset key is kept for traceability and survives duplication):

1. **Motivation - Cinematic Quote**: serif bold, centred, soft fade in and out, 9:16, fixed 8 s.
2. **Football - Headline Overlay**: uppercase bold on a dark band in the lower third, slide up / fade out, 9:16. Every name, score and date must be checked before approval (the check list reminds you).
3. **Meme - Image Caption**: big uppercase caption at the top of a square **image**, stays a still JPEG.
4. **Relationship - Emotional Quote**: serif on a soft box, 4:5, revealed line by line, fixed 9 s.
5. **Custom recipe**: blank; everything inherited.

Presets set the look of the format and leave **text color and, where the format has no fixed place, text position empty**, so a page's or category's own editorial preferences decide them.

## 3. Inheritance: where every setting comes from

For each setting, the first of these that has a value wins:

1. **Preview adjustment**: a change made in the preview and not saved (labelled "preview only");
2. **Recipe**: an explicit setting saved in the recipe;
3. **Page**, then **page group**, then **page category**: the editorial identity of Phase 4, for the settings it describes: **font, text color (the first color of the palette), text position, aspect ratio**;
4. **Built-in default**.

So a category's visual defaults apply first, a page's own preferences override them, a group (when chosen) sits between, and a recipe overrides all of them **only where it sets a value on purpose**. Every setting in the builder carries a badge (`recipe`, `from page`, `from group`, `from category`, `default`, `preview only`), and a recipe setting can be returned to "Inherit" with one click. This is computed by one pure function (`resolveEffectiveRecipe`) and served by `POST /api/recipes/evaluate`, so the builder, the API tests and (later) the renderer cannot disagree.

Group layer: as decided in Phase 4 (TD-55) a page's group layer applies only when a group is named. The preview's "Page group" selector does that; choosing a group without a page uses the group's own preferences only.

## 4. Which recipe suits a page

When several recipes could be used for a page they are offered **most specific first**: set for the **page**, then for one of its **page groups**, then for its **page category**, then recipes set for **everyone**; several per level are normal (sorted by name). Recipes limited to other pages, groups or categories are not offered; archived ones never are. Optionally only those that accept the chosen media type. (`GET /api/recipes?forPageId=…&forMedia=…`, and the "Suits page" filter.)

## 5. The preview

Choose, in the builder: a **page** and optionally a **page group**, a **picture or video** from the Media Library (only ready files; ones the recipe does not accept are dimmed), and a **text** from the Text Library (approved texts by default, limited to those that suit the chosen page and the recipe's text category; "also show texts that are not approved" is for trying a layout only). A **Quick adjust** panel changes font size, position and nudge in the preview without touching the recipe, with **Apply to the recipe** to keep them; **Remember these preview choices** stores the selections and adjustments so the recipe reopens as it was left. Saving, duplicating, archiving are in the header.

How accurate is it: positions and sizes come from one shared layout function (`computeLayout`) as fractions of the frame, so the **settings** are shown exactly (position, size relative to the frame, alignment, colors, background, aspect, fit, motion timing). What can differ in the final file: line breaks and glyph widths, because the browser uses its own copy of the font and the renderer wraps with its own font files; the motion shown for typewriter and line-by-line is an illustration whose exact timing the renderer defines (5C). The interface states this under every preview. Motion is not played when the system asks for reduced motion.

**Checks** under the preview (`ERROR` must fix, `WARNING` look, `INFO` note): media type not accepted, file not ready, rights "do not use", unmeasured size, picture smaller than the output, cropping explained, animation on a still image without a fixed length, text not approved (a **warning** in a preview, an **error** when rendering), archived / rejected / "do not use" text, text category or language not matching, the page's own rules (length, avoided terms, fact-checking reminder; reused from Phase 4), recipe or text limited to other pages / groups / categories, text near the platform's own buttons (an assumption, not a measured safe area).

## 6. Traceability

* A recipe records its creator and last editor, a version counter, the preset it came from and the recipe it was copied from.
* Preview selections reference the exact media file and text by id.
* `text_usages` can reference a recipe, a source file and a publication; the renderer and the Publishing Center will fill them in (5C/5F).
* Generated content (5C/5F) will keep the chain source asset → recipe (id and version) → text → page, as the Phase 5 brief requires.

## 7. Permissions and audit

Everyone can read recipes and run the preview calculation (it stores nothing, records no use, writes no file). Administrators create, edit, duplicate, assign, archive and save preview choices. Audit: `RECIPE_CREATED`, `RECIPE_UPDATED`, `RECIPE_DUPLICATED`, `RECIPE_ARCHIVED`, `RECIPE_RESTORED`, `RECIPE_ASSIGNMENT_CHANGED`, `RECIPE_PRESETS_INSTALLED`, `RECIPE_PREVIEW_SAVED`.

## 8. API (under `/api/recipes`)

`GET /` (filters: status, q, mediaKind, pageCategoryId, pageGroupId, pageId, textCategoryId, forPageId, forMedia), `GET presets`, `POST presets/install`, `POST from-preset`, `POST /`, `GET|PATCH :id`, `POST :id/duplicate|archive|restore`, `PUT :id/assignments`, `PUT :id/preview-config`, `POST evaluate`.

## 9. Code map

`packages/studio`: `recipe.ts` (schema, defaults), `recipe-presets.ts`, `recipe-resolve.ts` (inheritance and sources), `recipe-select.ts`, `recipe-compat.ts`, `layout.ts`, `fonts.ts`, `text.ts`. `apps/api`: `services/recipe.service.ts`. `apps/web`: `lib/recipes.tsx` (preview), `studio/recipes/*`.

## 10. Not in this phase (and what that means)

* **No rendering**: no FFmpeg, no output file, no thumbnail of the composition. The preview is a browser drawing.
* The animations (typewriter, line by line, slide, zoom) are **definitions plus a preview**. Which of them FFmpeg can render faithfully, and how, is decided and verified in 5C; any that cannot be rendered will be reported then rather than silently dropped.
* Platform limits (duration, size, aspect) for the export are 5C (with the verified / assumed distinction).
* Recipes cannot yet be chosen automatically for a publication (5F).
