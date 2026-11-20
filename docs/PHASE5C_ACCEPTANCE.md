# Phase 5C acceptance report: FFmpeg rendering engine and Rendering Studio

Branch `phase5-media-pack-ai-studio` (on top of the accepted 5B tip `8f6f371`). Main is untouched; nothing is merged or deployed; Phase 5D is not started.

## 1. In one paragraph

A person can now choose a picture or video, an approved text and a page (or page group), see which recipe applies and what the result will look like, and start a render. A worker turns it into a real MP4 (H.264 + AAC) or still with FFmpeg, shows real progress, validates the file, and saves it in the Media Library as a READY file with its provenance. All five requested animations are rendered and each is verified by reading frames back. The browser preview no longer re-wraps text on its own: it draws the exact plan (line breaks, positions, timing) that the renderer follows. Two things are **not** done and are stated plainly in section 5: the **Publishing Center cannot select a rendered file yet**, and **real Cloudflare R2 and the Docker image builds were not verified on this machine**.

## 2. Status at a glance

| Item | Status |
|---|---|
| Real FFmpeg rendering, all five animations, 9:16 / 1:1 / 16:9 (and 4:5) | **Done and verified** (96 real-FFmpeg tests on 3 Linux versions plus Windows) |
| Rendering Studio (waiting, rendering, failed and cancelled, done; percentage, elapsed time, output preview, retry, cancel) | **Done**; browser-verified except retry-by-click and a failed render's look |
| Preview and renderer agree | **Done by construction** (one shared plan); checked by measurement for the file and by eye for the browser |
| Worker restart, failed jobs, duplicate jobs, cancel | **Done and tested** against real MySQL, Redis and FFmpeg |
| Output saved in the Media Library as a READY asset | **Done** |
| Available to the **Publishing Center** | **Not done**: it cannot select Media Library files yet (section 5, decision 1) |
| Linux real-FFmpeg runs, not only Windows | **Done**: Debian 12 (FFmpeg 5.1.9), Ubuntu 24.04 (6.1.1), Ubuntu 26.04 (8.0.1) |
| Docker image builds | **Not run locally** (Docker Desktop could not be started); a simulation of the worker and API builds ran on Debian 12, and the CI `images` job then built the real images successfully |
| Real Cloudflare R2 | **NOT verified** (mandatory before production, as decided) |
| GitHub Actions (hygiene, verify, images) | **all three green** on `8d65140` (section 9); that includes the real Docker image builds |

## 3. The brief, item by item

| Brief | What exists | Evidence |
|---|---|---|
| 1. Select source media | picker of READY pictures and videos; the API refuses anything else | `renders.integration.test.ts` (refuses non-ready, audio, wrong recipe media) |
| 2. Select approved text | picker of approved texts only; API refuses pending, archived, rights-restricted, undrawable and too-long texts before anything is queued | API integration |
| 3. Target page or group | page or page group, optional campaign | API + browser |
| 4. Resolve recipe and page overrides | named recipe, else page, then group, then category, then everyone, limited to the media type; effective settings with the source of each value | API integration (ordering), `MEDIA_RENDERING.md` §6 |
| 5. Validate compatibility | the 5B checks plus text plan, output decision and source checks; errors block, warnings show | API + UI |
| 6. Create render job | frozen words, settings, recipe version, source SHA-256; duplicate guard | schema, API integration |
| 7. Process with FFmpeg | the real binary, filter graph from a script file | 96 renderer tests, 16 worker tests |
| 8. Report actual progress | determinate only once FFmpeg reports its position (ms of output produced / output length); indeterminate while preparing and for stills | worker test (no total at first, never ahead, ends complete); browser: "0:09 of 1:30 rendered, 10.1 %" |
| 9. Thumbnail and metadata | the existing analysis (dimensions, duration, codecs, thumbnail) runs on the output | worker test |
| 10. Save in the Media Library | origin RENDER, folder Renders, tag rendered, linked to campaign and group | worker test |
| 11. Available to the Publishing Center as READY | READY library file yes; **selection inside the Publishing Center no** | section 5 |
| Real FFmpeg, no simulated previews | the preview is labelled "Preview, not a rendered file"; results are real files | tests, UI |
| Preserve originals | a render never writes to the source; tested byte for byte | worker test |
| MP4 H.264 + AAC; 9:16, 1:1, 16:9; varied source sizes; audio kept | yes (4:5 as well) | renderer tests |
| Font fallback and report missing fonts | fallback to another installed family with the reason shown on the job; no font at all refuses with the searched directories | renderer tests, job detail |
| Validate duration, dimensions, codecs, integrity | ffprobe plus a full decode; failure fails the job with the check table | validation tests |
| Worker restarts and failed jobs | job stays RUNNING, BullMQ re-delivers, exactly one output; stored output adopted; final failure marks the job failed | worker tests |
| Prevent duplicate jobs | database unique key; six simultaneous identical requests make one job; "render again on purpose" is explicit | API integration, browser |
| Configuration and provenance stored | frozen effective settings with sources, recipe version and configuration, source file and hash, text copy, page, group, campaign, plan, fonts, validation | worker test, job detail page |
| Progress from measurable work | as above | as above |
| Visual fidelity to the preview | one shared plan (`@socialith/studio`) for both; measured against the file | renderer tests, `plans.json` fixtures |
| Automated FFmpeg output tests and visual regression fixtures | 96 renderer tests (structural frame measurements) and 96 layout fixtures; not pixel goldens | TD-75 |
| Rendering Studio UI | `/studio/renders`, `/new`, `/[id]` | browser run |
| Tests on all five animations, three aspect ratios, media types, restart, duplicates, failures, validation, Linux | yes | section 6 |

## 4. How it works (short)

Full description: `MEDIA_RENDERING.md`. In brief: `@socialith/studio` computes the text plan, timeline and subtitle plan from the effective settings and the real fonts' advance widths. The API returns that plan for the preview and the worker recomputes it for the render. The renderer builds one FFmpeg command: the source scaled to the frame, a transparent RGBA layer with the text block (one `drawtext` per line, box or band as the layer's own colour), fades, slide, zoom, typewriter and line-by-line as filters of the same timeline, subtitles, H.264 + AAC. The output is validated, stored, analysed and recorded.

## 5. What is not done, not verified, or limited (read this part)

**Decision 1 for the owner: the Publishing Center cannot use a rendered file yet.** The Publishing Center publishes `Content` rows whose `ContentAsset.url` points into the older asset store; it never reads `media_assets`. Media Library files are private and only served through authenticated routes, while a platform must fetch media from a URL. Connecting them means deciding how a private file becomes a provider-fetchable URL (short-lived signed URL, public bucket, or a copy into the publishing store), which changes the privacy of library files and depends on real R2. I did not make that decision for you. Planned for 5F; today a rendered file can be played and downloaded from the Media Library and attached by hand (TD-78).

**Not verified**
* **Real Cloudflare R2.** Everything ran on the local storage implementation. Mandatory before production; development was not blocked, as decided (TD-61).
* **Docker image builds.** Docker Desktop could not be started here (its Windows service needs administrator rights). I built and booted the production worker and API in a Debian 12 chroot (the worker image's base: node 20, FFmpeg 5.1.9, the font packages): `media-render worker ready`, `/api/renders` mounted. That is a simulation, not the Dockerfile. The CI `images` job then built the real images successfully (run 44770619152), so this is verified in CI but not on this machine.
* **Retry by clicking in the browser and the look of a failed render.** Retry and failure are covered by API and worker tests; I did not click through them.
* **Browser preview against the rendered file pixel by pixel.** The file is measured against the plan; the browser drawing follows the same plan and was compared by eye on one composition. No automated browser-to-file comparison exists.
* **Phone layout.** The application shell's sidebar does not collapse (TD-65, older); the new pages have no overflow of their own.

**Assumed**
* **Safe areas are assumptions** (TD-72), not measured from any platform's current interface. The guide says so.

**Limits**
* No right-to-left text, no emoji, no scripts beyond Latin (with Turkish and Azerbaijani), Greek and Cyrillic; unsupported characters are refused, never drawn as boxes (TD-74).
* Line breaking uses advance widths without kerning; three characters whose width differs between font package versions are refused (TD-73). A font package update can move line breaks and the table must then be regenerated; a test fails when the table and the fonts disagree.
* Visual regression is structural plus layout fixtures, not pixel goldens (TD-75).
* Subtitles come from the text, evenly spaced; nothing is transcribed (no speech recognition).
* A still image cannot animate; the job says so and shows the text complete.
* Readability is measured on a few frames and is only a warning.
* One render at a time per worker by default (`RENDER_CONCURRENCY`, 1). No bulk rendering (5D/5E).

## 6. Verification

| Check | Result |
|---|---|
| Ubuntu 24.04 (the CI runner's package versions, FFmpeg 6.1.1, `fonts-liberation` 2.1.5), throwaway MySQL 8.4 + Redis | lint 13/13 (0 errors), typecheck 13/13, **unit 822 tests in 10 packages** (config 31, publishing 111, auth 37, studio 81, worker 75, web 13, upload-post 45, api 238, media-pack 95, video-engine 96), `migrate deploy` on a fresh database, **drift check: none**, **API integration 297**, **worker integration 148**, build 13/13 |
| Debian 12 (the worker image's base, FFmpeg 5.1.9, `fonts-liberation` 1.07.4), same MySQL 8.4 + Redis | video-engine 96/96, studio 81/81, **API integration 297/297**, **worker integration 148/148** (all with the final code) |
| Ubuntu 26.04 (FFmpeg 8.0.1) | video-engine 96/96, API integration 297, worker integration 147 |
| Windows 11 (FFmpeg 9.0.1, Arial / Times / Courier stand-ins for Liberation, reported by the renderer) | `pnpm test`: 10/10 packages green, video-engine 96/96, api 237 passed and 1 skipped (it needs a database), the rest as above; lint and typecheck 13/13 |
| Production builds booted on Debian 12 | worker: all 14 workers ready including `media-render`; API: health ok, `/api/renders` answers 401 without a session |
| Browser run (real API, worker and web on a throwaway database) | presets installed; render started from the form; the real output played (1080 x 1920, h264 + AAC, 5 s) with its check table, provenance and frozen settings; a 90 s clip showed real progress and was cancelled from the list; the same render requested again was refused with "already made" and the open / render-again choices; no console errors apart from one caused by my own hot edit |

### Defects the multi-version runs found and fixed

| Found on | Defect | Fix |
|---|---|---|
| Debian 12, FFmpeg 5.1.9 | `drawbox replace=1` crashes FFmpeg with SIGSEGV (box and band backgrounds) | the layer is created in the background colour and opacity |
| Ubuntu 24.04, FFmpeg 6.1 | the last progress line was 2987 of 3000 ms, so progress never reached the total | progress is set to the exact total once FFmpeg has exited successfully |
| Linux | the font table (first generated on Windows) did not match the real fonts; U+00B7, U+040D, U+2011 differ between `fonts-liberation` 1.07.4 and 2.1.5 | regenerated from the Debian 12 files; those three characters are refused |
| Linux | a test assumed missing fonts always fall back (only true with Windows stand-ins) | split by platform |
| Test setup (mine) | a dev worker on the same Redis consumed integration-test jobs | do not run one against the test Redis |

None of the first four would have been seen by running on Windows alone; the CI runner would have failed on the second, third and fourth.

## 7. Database and rollback

Additive migration `20261124100000_media_render_jobs`: new table `media_render_jobs` (indexes, a unique `(organization_id, active_key)`, a foreign key to the organization only), new enum column `media_assets.origin` (default `UPLOAD`, so every existing row stays an upload) and nullable unique `media_assets.render_job_id`. Written by hand, applied to a fresh MySQL 8.4 and checked with `prisma migrate diff --exit-code`: no drift. Rollback: the new columns and table are unused by `main`; reverting the application code leaves them dormant. To drop them: remove the table and the two columns (no existing data depends on them).

## 8. Changes

55 files, about 12 000 lines added (about 7 000 of them the generated font table and layout fixtures). Six code commits (studio plan, FFmpeg engine, schema, worker, API, web) and one documentation commit. New environment variables: `FONT_DIRS`, `RENDER_CONCURRENCY`, `RENDER_TIMEOUT_MS`, `RENDER_X264_PRESET`, `RENDER_X264_CRF` (defaults are safe; none is required). No new infrastructure, no new secrets. The worker image already installed FFmpeg and both font packages.

## 9. GitHub Actions

Pushed to `phase5-media-pack-ai-studio` (fast-forward from `8f6f371`, no force). For the code and documentation commit `8d65140` GitHub Actions run 44770619152 finished with all three checks **successful**: `hygiene` (including the full-history scan), `verify` (lint, typecheck, unit, migrations, drift check, API and worker integration, build, with real FFmpeg and fonts on the runner) and `images` (the three Docker images build). That run is the first real Docker build of the 5C code. This report was added in a later documentation-only commit.

## 10. Technical debt

Resolved: TD-66 (motion). Partly: TD-68 (render writes usage entries; publishing still to come). Updated: TD-71 (fonts). New: TD-72 safe areas assumed, TD-73 font table and version-dependent glyphs, TD-74 text limits, TD-75 structural regression, TD-76 FFmpeg versions, TD-77 list sizes and no bulk, TD-78 Publishing Center cannot select rendered files.

## 11. Decisions I need from you

1. **How a private Media Library file reaches the Publishing Center** (short-lived signed URL, a public bucket, or a copy into the publishing store). Needed for 5F; it changes who can fetch library files, and it needs real R2 to verify.
2. **Safe areas**: which margins to trust per platform, or approve measuring them against each platform's current guidance (TD-72).
3. **More fonts**: keep the five families, or license and add others (each needs its file in the image, the catalogue and the metrics table; TD-71).
4. **Docker on the development machine**: its Windows service needs administrator rights I do not have; if you can start it (or repair Docker Desktop), I can run the image builds locally as well as in CI.
5. Whether to proceed to **5D (AI Content Studio)**. I have not started it.

## 12. How to review

Read `MEDIA_RENDERING.md`, then open **Content Studio, Rendering, New render** with a video, a page and an approved text; start it and watch the job page. Run the renderer tests where FFmpeg and the fonts exist (`PHASE5C_TESTING.md` §4); `packages/studio/src/__fixtures__/plans.json` shows the plans the preview and renderer share.
