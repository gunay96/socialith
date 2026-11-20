# Phase 5 checkpoint

Branch `phase5-media-pack-ai-studio` (from main `a5f2470`). One sub-phase at a time; each ends with tests, documentation, commits and a report. Main is never modified; nothing is merged.

| Sub-phase | Scope | Status |
|---|---|---|
| **5A** | Media Pack manager, private storage, ZIP workers, analysis, library UI, progress ledger | **Complete and accepted** (tip `9729f14`, three checks green) |
| **5B** | Text Library, Content Recipe Engine (builder, inheritance, browser preview) | **Complete and accepted** (tip `8f6f371`, three checks green) |
| **5C** | Rendering engine on FFmpeg, Rendering Studio | **Complete, awaiting approval** (see "5C: what is in place"; report `PHASE5C_ACCEPTANCE.md`) |
| 5D | AI Content Studio | Not started |
| 5E | Live operations: real-time updates, worker heartbeat, Live Task Center | Not started (the progress ledger and polling exist from 5A) |
| 5F | Publishing Center integration with provenance | Not started |

## Owner decisions recorded at 5A acceptance (final)

1. **Large uploads: direct-to-R2 multipart** (backend-created sessions, short-lived presigned URLs, chunk-level progress, server-side completion verification, checksums, expired-upload cleanup, worker processing, no R2 credentials in the browser). The single-request path stays for development and small files. **TD-60 stays open** until implemented and verified against real R2. Design: `DIRECT_UPLOAD_ARCHITECTURE.md`. Not built in 5B.
2. **Original ZIP archives are kept by default**, never deleted automatically, reachable by administrators; a configurable retention policy is designed but no deletion exists until the owner approves one. Storage implication (archive + extracted files, about twice the pack) recorded in `MEDIA_PACK_ARCHITECTURE.md` §12 and TD-63.
3. **Real Cloudflare R2 verification is mandatory before production deployment** and does not block 5B. Development continues on local storage and the test adapter; nothing claims real R2 connectivity (TD-61).

## 5B: what is in place

* Additive migration `20261123100000_text_library_and_content_recipes` (15 tables): text categories, texts (unique per organization after folding), category / campaign / page-category / page / page-group links, collections, import batches, usage history, recipes with page-category / group / page assignments.
* `@socialith/studio` (pure): text cleaning and duplicate / search folding, the font catalogue, the recipe schema and defaults, five presets, **inheritance with the source of every setting**, which-recipe-for-which-page ordering, compatibility checks, the shared text layout.
* `@socialith/media-pack` (Node): TXT, CSV and hardened XLSX readers with Windows-1254 support.
* API: `/api/text-library/*` and `/api/recipes/*` (RBAC, organization isolation, audit).
* Web: Content Studio gains **Text Library** (list, review queue, bulk actions, add, detail with usage history and rights), **Import** (check first, then import), **Categories and collections**, **Recipes** (presets, list, suits-page filter) and the **recipe builder with live preview**.
* Integration with existing models only: pages, page categories, page groups, campaigns, media assets, `Content` (referenced, never duplicated). Full Publishing Center integration (provenance on generated content) is 5F; what exists now is the reference trail in `text_usages` and the page-rule checks reused from Phase 4.
* Docs: `TEXT_LIBRARY.md`, `CONTENT_RECIPE_ENGINE.md`, `PHASE5B_TESTING.md`, `DIRECT_UPLOAD_ARCHITECTURE.md`; `TECHNICAL_DEBT.md` (TD-60/61/63 updated, TD-65 … TD-71 added); `MEDIA_PACK_ARCHITECTURE.md` §11 and §12.

## Verification

| Check | Result |
|---|---|
| `pnpm lint` | 13/13, 0 errors (one pre-existing warning each in `packages/database` and `apps/api`) |
| `pnpm typecheck` | 13/13 |
| `pnpm test` (unit) | 10/10 packages green: studio 54, media-pack 95, video-engine 48, config 30, api 237, worker 75, web 13, publishing 111, upload-post 45, auth 37 |
| API integration, MySQL 8.4 | **281 passed** (text library 35, recipes 25, media 31, earlier phases unchanged) |
| Worker integration, MySQL 8.4 + Redis | 132 passed (regression) |
| Browser run on a throwaway database | import with dry run, bulk approval, presets, inheritance badges, preview with a real video, edit-save-restore (`PHASE5B_TESTING.md` §5) |
| Docker images api / worker / web | all three build; `@socialith/studio` (zod, publishing) and `@socialith/media-pack` load and run inside the api and worker images |
| Clean Linux replay (Debian 12, FFmpeg 5.1, the worker image's version) of lint, typecheck, unit and both integration suites | all green (this replay caught two Linux-only defects in 5A; none in 5B) |
| GitHub Actions (3 checks) | see the 5B report |

## 5C: what is in place

* Additive migration `20261124100000_media_render_jobs`: `media_render_jobs` (frozen inputs, state machine, duplicate guard, cancel request, output link) and two columns on `media_assets` (`origin`, unique `render_job_id`). Applied to a fresh MySQL 8.4 and checked: no schema drift.
* `@socialith/studio` (pure): metrics-based line breaking, the text plan, the motion timeline, subtitle plan and output decision, **shared by the preview and the renderer**; layout fixtures (96 plans).
* `@socialith/video-engine`: the FFmpeg pipeline (all five animations, four aspect ratios, audio kept, stills), font resolution with reported fallback, output validation (ffprobe plus full decode), readability warning, cancel and timeout.
* Worker: queue `media-render` (14th worker), idempotent job processing (re-delivery, crash, adopt a stored output, cancel, stale scratch cleanup), real progress, output saved as a READY Media Library file (origin RENDER) with provenance, one `RENDER` usage entry per output.
* API: `/api/renders` (resolve, create, list, detail, cancel, retry), duplicate prevention, audit actions.
* Web: **Rendering** tab (Rendering Studio list with pending / rendering / failed / done, new-render form, job detail with the real output, checks, provenance and frozen settings); the recipe preview now draws from the renderer's plan and timeline.
* Docs: `MEDIA_RENDERING.md`, `PHASE5C_TESTING.md`, `PHASE5C_ACCEPTANCE.md`; `TECHNICAL_DEBT.md` (TD-66 resolved, TD-68 partly, TD-71 updated, TD-72 … TD-78 added); `CONTENT_RECIPE_ENGINE.md`, `TEXT_LIBRARY.md`, `OPERATIONS_RUNBOOK.md`, `LIVE_OPERATIONS_ARCHITECTURE.md`, `CI.md` updated.

## 5C verification

| Check | Result |
|---|---|
| Ubuntu 24.04 (the CI runner's packages, FFmpeg 6.1.1): lint, typecheck, unit (822 tests in 10 packages), `migrate deploy`, drift check, API integration (297), worker integration (148), build 13/13 | all green |
| Real-FFmpeg render suite (96 tests incl. fonts) on Debian 12 (FFmpeg 5.1.9, the worker image's base), Ubuntu 24.04 (6.1.1), Ubuntu 26.04 (8.0.1) | all green on all three |
| Debian 12: worker integration (148 incl. 16 render tests), API render integration (16) | green |
| Production builds of the worker and API booted on Debian 12 (node 20, FFmpeg 5.1.9): `media-render worker ready`, `/api/renders` mounted and authenticated | yes (a simulation of the image build in a chroot) |
| Docker image builds | **not run locally** (Docker Desktop could not be started); the CI `images` job is the check |
| Windows (FFmpeg 9.0.1): unit tests including the render suite | see `PHASE5C_ACCEPTANCE.md` |
| Browser run (real API, worker, web) | render started from the UI, real output played, real progress on a 90 s clip, cancel, duplicate refusal |
| Real Cloudflare R2 | **NOT verified** (mandatory before production, owner decision) |
| GitHub Actions (3 checks) | see `PHASE5C_ACCEPTANCE.md` |

## Decisions that still need the owner

* Upload approach build-out and a real R2 bucket for its verification (TD-60, TD-61).
* Retention policy for original archives, if any (TD-63).
* Which safe-area margins to trust per platform (TD-72: assumed today), and whether more fonts than the five families should be licensed and added (TD-71).
* Whether Docker Desktop on the development machine can be repaired (its Windows service needs administrator rights), so image builds can be verified locally as well as in CI.
