# Media rendering (Phase 5C)

How Socialith turns *a source picture or video + an approved text + a recipe* into a finished MP4 (or JPEG/PNG) with real FFmpeg, and how the browser preview and the renderer are kept in agreement.

Status of this document: describes what is implemented on branch `phase5-media-pack-ai-studio`. Things that are assumed or not yet verified are marked **ASSUMED** or **NOT VERIFIED** and collected in [Limits and open items](#limits-and-open-items).

## 1. The workflow

```
choose source media  ->  choose an APPROVED text  ->  choose a target page or page group
        |
        v
resolve the recipe  (named recipe, else page > page group > page category > everyone, restricted to the media type)
        |
        v
evaluate: effective settings (recipe, then page/group/category identity, then one-off adjustment) + compatibility checks
        |   + the text plan (line breaks, size, positions) + the motion timeline + the subtitle plan   <- shared with the preview
        v
create render job (frozen copy of words, settings and source fingerprint)  ->  operation task  ->  BullMQ `media-render`
        |
        v
worker: download source -> plan again (same shared code) -> FFmpeg -> validate -> store -> thumbnail/analysis -> Media Library asset
        v
output is a READY MediaAsset (origin RENDER, tag "rendered", folder "Renders") with its provenance; the Publishing Center cannot select it yet (see "Publishing Center" below)
```

Nothing is published automatically. The original source file is never modified: a render writes a *new* object under `{org}/renders/{jobId}/output.{mp4|jpg|png}`.

## 2. One calculation for the preview and the renderer

The browser preview and FFmpeg must not each decide where text goes. Everything geometric is computed once, in the pure package `@socialith/studio`, and both consumers follow it:

| Concern | Function | Used by |
| --- | --- | --- |
| Which characters, which font, which size | `planText` (`text-plan.ts`) | API `evaluate` (preview), worker (renderer) |
| Line breaks | `wrapText` with **advance-width tables** of the real font files (`font-metrics.data.ts`) | both |
| Where each line sits (left, top, baseline) | `PlannedLine` (`leftPx/topPx/baselinePx`) | both |
| Box / band behind the text, safe area | `TextPlan.outer/inner/safeArea` | both |
| Motion over time | `buildTimeline`, `stateAt` (`timeline.ts`) | preview evaluates `stateAt`; renderer turns the same numbers into filters |
| Subtitles | `planSubtitles` | both |
| Video or still, length | `decideOutput` (`render-output.ts`) | both, and the compatibility check |

`POST /api/recipes/evaluate` and `POST /api/renders/resolve` return `plan`, `timeline`, `subtitles`, `output`. The recipe preview (`apps/web/src/lib/recipes.tsx`) draws every line at the plan's pixel position inside a frame of the real output size (scaled with CSS), and plays the timeline with a JavaScript clock and a scrubber. It does **not** re-wrap text in the browser.

What can still differ between preview and file (and is shown to the user): the *shape* of the letters (the browser may not have the same font file; the renderer uses the worker's file), anti-aliasing, and video compression.

### Line breaking and fonts

* Fonts are the five families the worker image installs: DejaVu Sans/Serif, Liberation Sans/Serif/Mono, each Regular/Bold (`packages/studio/src/fonts.ts`).
* Widths are advance widths per 1/1000 em, **without kerning** (FFmpeg `drawtext` is called with `expansion=none`, one `drawtext` per line, and does not kern). Line height is 1.2 x font size. Baseline = ascent + half the room the line box has beyond the font's content area.
* The table is **generated** from the real font files by `packages/video-engine/scripts/generate-font-metrics.ts` and checked against the installed fonts by `packages/video-engine/src/fonts/font-metrics.test.ts` (which fails in CI if the fonts are missing, instead of skipping).
* Characters the font cannot draw are refused with a clear message (`UNSUPPORTED_TEXT`), never drawn as boxes. Right-to-left text and emoji are **not supported** and are refused the same way.
* If the requested font file is missing the renderer falls back to another installed family, plans the line breaks *for the font actually used*, and reports the fallback on the job. If no font at all exists the job is refused with the searched directories (`FONT_UNAVAILABLE`). On a Windows development machine, metric-compatible stand-ins (Arial/Times/Courier for Liberation) are used and reported.
* Font directories: `FONT_DIRS` (comma separated) overrides the defaults (`/usr/share/fonts/truetype/{dejavu,liberation,liberation2}` and friends).

### Safe areas

The safe-area margins (`packages/studio/src/safe-area.ts`) are **ASSUMED** values chosen for common vertical-video overlays (`SAFE_AREA_STATUS = "ASSUMED"`). They are not measured from any platform's current interface, and the interface says so wherever it shows them. Text that cannot fit inside the safe area at the smallest allowed size is refused (`TEXT_DOES_NOT_FIT`); text that fits only after shrinking is shrunk and the change is reported in `adjustments`.

## 3. Motion: how each animation is rendered

All five requested text animations are rendered by FFmpeg and verified by reading frames back (section 7).

| Animation | Definition (timeline) | FFmpeg |
| --- | --- | --- |
| Fade in | linear opacity 0 to 1 over `entry.ms` | `fade=t=in:alpha=1` on the transparent text layer |
| Fade out | linear 1 to 0 over the last `exit.ms` | `fade=t=out:alpha=1` |
| Slide (up in / down out) | block moves `slidePx` (4 % of the frame height) with ease-out-cubic in, ease-in-cubic out, combined with the fade | overlay `y` expression of `t` |
| Zoom (in) | block grows from 0.85 to 1 with ease-out-cubic, with the fade | `scale ... eval=frame` on the layer + centre-based overlay expression |
| Typewriter | characters appear in at most 80 steps over `reveal.durationMs` (half the clip, 1.2 s to 6 s) | prefix `drawtext`s with `enable='between(t,a,b)'`, numeric x so already-typed letters never move |
| Line by line | each line fades in (up to 300 ms) at its own start | per-line `enable` + `alpha` expression |

Entry and exit are shortened proportionally if together they would exceed 90 % of the clip. A **still image output cannot animate**: the job renders the text complete and the interface says so, instead of pretending.

Subtitles are generated from the **text only** (cut into cues of N words, evenly spaced over the clip). Nothing is transcribed from audio and nothing is timed to speech.

## 4. The FFmpeg pipeline

`packages/video-engine/src/render/`:

* `command.ts` builds the whole command: base video (fps, `scale` cover or contain + `pad`, `setsar=1`, `yuv420p`), then a transparent RGBA text layer (`color=0xRRGGBB@alpha,format=rgba`, sized to the text block or the full width for a band; the colour and alpha are the background's (box or band) or fully transparent when there is none — **not** drawn with `drawbox replace=1`, which crashes FFmpeg 5.1.9 on Debian 12), one `drawtext` per line (`textfile`, `expansion=none`, relative file names, the font copied into the work directory so no path with a colon or backslash enters the filtergraph), then the animation filters and an `overlay`.
* The filtergraph is written to a **script file** (`-filter_complex_script` before FFmpeg 7, `-/filter_complex` from 7; detected from `ffmpeg -version`), so no quoting of user text on a command line is possible.
* Output video: H.264 (`libx264`, high profile, `yuv420p`, BT.709 tags, `+faststart`), preset and CRF from `RENDER_X264_PRESET` (default `veryfast`) and `RENDER_X264_CRF` (default 21). Audio: AAC 128 kb/s, 48 kHz stereo, copied from the source when it has one. 9:16, 1:1, 16:9 and 4:5 are supported; any source size is scaled to cover or contain.
* Stills: JPEG (`mjpeg`) or PNG.
* `-progress pipe:1` gives the real position (`out_time_us`), which becomes the task progress.
* `runner.ts` supervises the process: abort signal (cancel), wall-clock timeout (`RENDER_TIMEOUT_MS`, default 900 000), stderr tail kept for the failure message.
* `validate.ts` (below) and `readability.ts` finish the job.

### Progress is real or absent

While the job is preparing (download, planning) there is **no total**, so the interface shows an animated indeterminate bar and no percentage. When encoding starts the total becomes the output length in milliseconds (`unit: "ms of output"`) and `completed` is FFmpeg's reported position, so the percentage is `completed / total`. Stills have no total at all. A job that stops reporting is shown as *stalled* by the task ledger's staleness rule. See `packages/studio/src/progress.ts`.

### Output validation

After encoding, `ffprobe` and a full decode (`-xerror`) check: container is MP4 (or JPEG/PNG), video codec `h264`, pixel format `yuv420p`, dimensions equal the planned frame, duration within max(250 ms, 3 %) of the planned length, frame rate within 0.5 fps of the plan, AAC audio present exactly when the source had audio (and none otherwise), file size > 0, and the whole stream decodes without error. A failed check fails the job (`OUTPUT_INVALID`) with the check table stored on the job; nothing is added to the library.

### Readability

Samples of the backdrop behind the text block are taken from the source at a few times; the WCAG contrast ratio against the text colour is computed (good at 4.5:1, fair at 3:1, else low). It is a **warning only**, measured on a few frames, and shown on the result.

## 5. The job: state, idempotency and restarts

`MediaRenderJob` (table `media_render_jobs`):

* Frozen inputs: source asset id and **SHA-256**, the text id and a **copy of the words**, language, recipe id/name/**version** and a copy of the recipe configuration, page / group / campaign ids, one-off adjustment, and the **effective settings with the source of each value**. A retry uses these, not the live recipe.
* State machine `QUEUED -> RUNNING -> SUCCEEDED | FAILED | CANCELLED`. All transitions are conditional updates (`updateMany ... where status`), so two workers can never both own a job.
* **Duplicate prevention.** `dedupeKey` = SHA-256 of {asset id and hash, text hash, recipe id, effective values, page, group}. While the job is live (QUEUED/RUNNING) or succeeded, `activeKey = dedupeKey` and `@@unique([organizationId, activeKey])` makes the database refuse a second identical job, even for requests made at the same instant (tested with six parallel requests). A *succeeded* identical job can be repeated on purpose with `force: true`, which supersedes the old one (its `activeKey` is cleared). Failed and cancelled jobs release the key.
* **One output per job.** `media_assets.render_job_id` is unique; the worker creates the output asset with an upsert keyed on it and **adopts** an already stored output instead of rendering twice, so a re-delivery or a crash between "stored" and "marked succeeded" yields exactly one output.
* **Worker restart.** A job stays RUNNING if the worker dies; BullMQ delivers it again (stalled-job handling), the processor sees `attempts`, resets the task's progress (`completedUnits` back to 0), removes the previous work directory and starts again. Stale work directories left by a crashed worker are removed at boot (`cleanupStaleRenderDirs`). The final failure of the queue job (attempts exhausted or stalled too often) marks the job and task FAILED.
* **Cancel.** Queued: removed from the queue and ended `CANCELLED` at once. Running: `cancelRequestedAt` is set; the worker polls it every second and aborts FFmpeg through an `AbortController`; the job ends `CANCELLED`, leaves no output, and its scratch directory is removed.
* **Failures** carry a stable code, a plain message and a remedy: `UNSUPPORTED_TEXT`, `TEXT_DOES_NOT_FIT`, `SOURCE_UNUSABLE`, `FONT_UNAVAILABLE`, `SOURCE_MISSING`, `SOURCE_CHANGED` (the stored file no longer matches the fingerprint), `RENDER_TIMEOUT`, `OUTPUT_INVALID`, `RENDER_FAILED` (with the stderr tail), `CONFIGURATION_ERROR`. Refusals are final (no retry by the queue); unexpected errors are re-thrown for BullMQ's retry (2 attempts).
* Foreign-key note: history tables hold **plain ids** (no foreign keys) except to the organization, because MySQL cannot cascade an organization delete through `SET NULL` links on the same cascade path.

## 6. API

| Method and path | Role | Purpose |
| --- | --- | --- |
| `GET /api/renders?state=active\|finished\|all&status&pageId&sourceAssetId&page&pageSize` | any | list with per-status counts |
| `POST /api/renders/resolve` | any | recipe candidates (page > group > category > everyone), the chosen one, and the full evaluation (plan, timeline, subtitles, issues) |
| `POST /api/renders` | editor+ | create (202); 409 `DUPLICATE_RENDER` (with `jobId`, `canForce`); 422 `NOT_RENDERABLE` (with the issues) or no recipe suits |
| `GET /api/renders/:id` | any | detail incl. frozen settings, result, validation, related attempts |
| `POST /api/renders/:id/cancel` | editor+ | see section 5 |
| `POST /api/renders/:id/retry` | editor+ | new job with the same frozen inputs (refused if the text is no longer approved or the source changed/gone) |

Audit actions: `RENDER_REQUESTED`, `RENDER_CANCEL_REQUESTED`, `RENDER_RETRIED`.

Refused **before** anything is queued: text not approved / archived / rights restricted, characters the font cannot draw, text that cannot fit, a source that is not a READY picture or video, a recipe that does not accept the media type, an image asked to become a video without a fixed length, and unknown or foreign ids (404, so other organizations learn nothing).

## 7. Interface: the Rendering Studio

`/studio/renders` (tab "Rendering" in the Content Studio): counts, *Rendering now*, *Waiting*, *Failed and cancelled*, *Done*; each job shows its source thumbnail, page or group, recipe and version, the text, the real progress bar, elapsed time, and the failure message with a remedy. Polling every 2 s (active) / 6 s (finished), paused while the tab is hidden, with a "stale" marker if refreshes fail.
`/studio/renders/new`: media picker, page / group / campaign, approved text picker, recipe candidates with *why* each applies, the plan-based preview, the issue list, and **Start render**; a duplicate offers "Open the existing render" and (when allowed) "Render again on purpose".
`/studio/renders/[id]`: the job card, the real output (`<video controls>` or `<img>`) from storage, facts read back from the file, notes to check (readability, font fallback, adjustments), the output-check table, provenance, the frozen settings with their sources, other attempts, and the FFmpeg filtergraph.

Design rules from `docs/SOCIALITH_UX_DESIGN_SYSTEM.md` are followed: status is never colour alone, progress bars are determinate only with real numbers, reduced motion is respected, and the preview is labelled "Preview · not a rendered file".

## 8. Testing

* `packages/studio` unit tests: wrapping, plan, timeline, subtitles, output decision (pure, no FFmpeg).
* `packages/video-engine/src/render/render.test.ts`: **real FFmpeg** (no mocks). Each of the five animations, all of 9:16 / 1:1 / 16:9 (and 4:5), image and video sources of different sizes, audio preserved, stills, subtitles, cancel, timeout and output validation. "Visual regression" is **structural**, read back from decoded frames: ink bounding box against the plan (position, width, line count), brightness over time against the timeline (fades, slide offset, zoom size, typewriter prefix growth, line-by-line reveal), and row bands per line. This is deliberately independent of pixel-exact glyph shapes, which differ between FreeType/FFmpeg versions; it does not compare against stored screenshots.
* `font-metrics.test.ts`: the table equals the installed font files.
* Worker integration (`apps/worker/src/integration/render-processing.integration.test.ts`): real MySQL, real FFmpeg, real storage; video with audio, stills, image to video, campaign / group links, re-delivery idempotency, worker crash and re-delivery, adopt-stored-output, DB duplicate refusal, refusals, source missing / changed / damaged, FFmpeg missing, invalid output, cancel before start and while running, stale directory cleanup.
* API integration (`apps/api/src/integration/renders.integration.test.ts`): recipe resolution order, refusals before queueing, duplicates under concurrency, force, cancel, retry, roles, organization isolation, lists.

## 9. The Publishing Center (what 5C does and does not do)

Done: the render's output is a **READY** file in the Media Library (origin RENDER, tag "rendered"), linked to its campaign and page group, with the render job recording the source file and its SHA-256, the exact words, the recipe and its version, the page or group, and the frozen settings.

**Not done: the Publishing Center cannot select a rendered file yet.** It publishes `Content` rows whose `ContentAsset.url` points into the older asset store (with a re-signed URL for R2 at publish time); it does not read `media_assets` at all. Media Library files are deliberately private (served only through authenticated, organization-checked routes), and a platform has to fetch the media from a URL, so connecting the two means deciding how a private library file becomes a provider-fetchable URL (signed, short-lived, or copied). That is a privacy-relevant design that also depends on real Cloudflare R2, so it belongs to Phase 5F (Publishing Center integration with provenance) and needs the owner's decision (`PHASE5C_ACCEPTANCE.md`, decisions). Until then a rendered file can be downloaded or played from the Media Library and attached by hand through the existing upload path.

## 10. Operating it

* Worker image installs `ffmpeg`, `fonts-dejavu-core`, `fonts-liberation`. The worker's readiness check reports the render queue (`mediaRender`).
* Environment (all in `packages/config`): `RENDER_CONCURRENCY` (1), `RENDER_TIMEOUT_MS` (900000), `RENDER_X264_PRESET` (`veryfast`), `RENDER_X264_CRF` (21), `FONT_DIRS`.
* Scratch space: each job uses its own work directory under the worker's temp directory; it is deleted on success, failure and cancel, and stale ones are deleted at boot.
* Cloudflare R2: rendering reads and writes through the same storage layer as the Media Library. **Real R2 verification remains mandatory before production and has not been done**; local development and every test here use the local storage implementation (owner decision 3 of Phase 5C).
* Original ZIP archives remain preserved indefinitely, with no automatic deletion (owner decision 1).

## Limits and open items

* **Right-to-left text, emoji and characters outside the supported ranges are refused.** Latin (incl. Turkish and Azerbaijani), Greek and Cyrillic are supported where the installed font has the glyph.
* **No kerning** in line breaking and drawing; widths are summed advances. Wrapping is exact for FFmpeg's own placement by construction, but a browser that kerns may break a line differently *if* it were allowed to wrap; the preview does not wrap.
* Fade is linear; slide and zoom use cubic easing; these are the definitions in `timeline.ts`.
* Safe areas are **ASSUMED**, not verified against platform interfaces.
* Subtitles are text-only; no speech recognition.
* Visual regression is structural (see above), not pixel-exact golden images.
* Readability is measured on a few frames and is advisory.
* Real Cloudflare R2 is **NOT VERIFIED** (mandatory before production).
* See `TECHNICAL_DEBT.md` (TD-66 resolved by this phase; new items listed there).
