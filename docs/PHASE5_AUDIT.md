# Phase 5 audit — Media Pack & AI Content Studio

Base: `main` @ `a5f2470` (Phase 4 merged as PR #5; all three checks green). Branch `phase5-media-pack-ai-studio`. This records what the repository contained before the work, the decisions that follow from it, and the risks. Checkpoints per sub-phase: `PHASE5_CHECKPOINT.md`.

## 0. Step 0 verification

| Check | Result |
|---|---|
| `origin` fetched | yes |
| Phase 4 merged into `main` | yes (`a5f2470`, PR #5; the branch tip `0fcee63` is an ancestor) |
| Checks on that `main` commit | `hygiene`, `verify`, `images`: all success |
| Working tree clean | yes |
| Local `main` | fast-forwarded from `110e637` to `a5f2470` |
| Phase 4 documents present | `SOCIALITH_UX_DESIGN_SYSTEM.md`, `LIVE_OPERATIONS_ARCHITECTURE.md`, `PAGE_NETWORK_ARCHITECTURE.md`, `PAGE_MANAGEMENT.md` — read and used as the contract (progress rules, tokens, page/identity model) |

## 1. What already exists (and what is missing)

| Concern | Today | Consequence for Phase 5 |
|---|---|---|
| **Storage abstraction** | `@socialith/video-engine` `AssetStorage` with `LocalAssetStorage` and `R2AssetStorage` (AWS SDK v3, S3-compatible, presigned or public URLs). **`upload()` takes a whole `Buffer`.** | The adapter is the right place to extend, but a Buffer API cannot satisfy "never load large files into memory". Add stream/file methods; keep the old ones working. |
| **Upload path** | `POST /api/content/:id/assets/upload`: multer **memory** storage, 200 MB cap, MIME taken from the client | Unsuitable for packs. New upload path streams to disk and validates signatures. The old route is untouched. |
| **Static media** | `app.use("/media", express.static(LOCAL_STORAGE_DIR))` — **public, unauthenticated** (documented in `app.ts`) | Originals of an unreleased campaign must not live behind a public static route. Library files go in a private namespace served only by an authenticated, organization-checked route. Only *exports that become publishable assets* use the public namespace (that is already how publishing works). |
| **FFmpeg** | `assertFfmpegAvailable`, `extractThumbnail`, a `THUMBNAIL` operation; `RESIZE/CROP/SUBTITLES/…` exist only as comments | Real render engine to build. **No existing test runs FFmpeg.** |
| **Media facts** | none: no ffprobe, `ContentAsset.metadata` holds `sizeBytes` only (TD-49) | Probing closes TD-49 for the media library. Phase 3's "media UNVERIFIED" can become VERIFIED once facts are recorded. |
| **Fonts** | none; no font is shipped | Text rendering needs a font registry resolved from real files; the worker image must install one. |
| **Presets** | `PLATFORM_EXPORT_PRESETS` (TikTok/Reels/Shorts, all 9:16) with comments presenting limits as "real, documented" | The brief forbids presenting platform limits as facts without verification. New presets separate geometry (our choice) from platform limits, each limit flagged ASSUMED or VERIFIED with a source. |
| **AI** | `OpenAiCompatibleProvider.generateCaption()` only; **writes the result straight into `Content.caption`/`ContentVariation`**; env `AI_PROVIDER_*`, rate limit, timeout, cost config; no key → job FAILED (never a fake success) | Keep and reuse the configuration and the honesty rule. The Studio must produce **reviewable suggestions**, not overwrite content. No grounding in brief/identity/text library exists. |
| **Jobs** | `ContentGenerationJob`, `VideoRenderJob`: status, attempts, timestamps, error. **No progress; nothing reports it** (`updateProgress` unused). | Progress must be persisted by the workers (survives refresh and restart) — see D6. |
| **Queues / health** | 11 BullMQ queues in one worker; `/api/health` has database, Redis, queue counts; worker `/health` on a separate port; **no worker liveness visible to the API** | Add queues; implement the heartbeat proposed in `LIVE_OPERATIONS_ARCHITECTURE.md` §5. |
| **CI** | `verify` runs lint, typecheck, unit, MySQL/Redis integration; **does not install FFmpeg** | Add an FFmpeg + font step; real FFmpeg tests must fail in CI if FFmpeg is missing (no silent skip). |
| **Worker image** | installs `ffmpeg` (includes ffprobe); no fonts | Add a font package. |

## 2. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | **New table family for the library** (`media_packs`, `media_assets`, `media_derivatives`, tags, campaign/page-group assignment tables); `ContentAsset` stays per-content and untouched | `ContentAsset` is the publishing attachment (per content, URL-based). The library is the source catalogue; a render or "use in content" *creates* a `ContentAsset` that points back to the library asset. |
| D2 | **Originals are immutable and private**; derivatives (thumbnails, previews, renders) are separate rows and objects; exact duplicates are recorded as `DUPLICATE` rows pointing at the first asset, with no second copy stored | "Never overwrite originals", "store derivatives separately", duplicate detection without disk waste |
| D3 | **Streaming everywhere**: upload → disk (multer disk storage) → storage by stream; ZIP read entry by entry with `yauzl`; hashing and size counting on the stream; FFmpeg works on files, not buffers. R2 uses multipart streaming upload. | No whole-file memory use |
| D4 | **ZIP safety is enforced on bytes actually inflated**, not on header claims: path sanitation (no `..`, absolute, drive, UNC, backslash tricks, NUL, symlinks, reserved names), entry / per-file / total / ratio / depth limits, nested archives never recursed, extraction to server-generated storage keys (the archive's folder path is kept as *metadata*, never used as a filesystem path) | zip-slip and zip bombs |
| D5 | **Type validation = extension allow-list + magic-byte signature + client MIME cross-check**; disagreement rejects the file with a reason | MIME and extension are attacker-controlled |
| D6 | **One progress ledger, not a second job engine**: BullMQ stays the executor; a persisted `operation_tasks` row per unit of work (type, stage, completed, total, unit, status, last update, error with remedy) is written by the workers (throttled) and read by the UI. `percentage = completed / total × 100`, computed on read, only when `total` is known; otherwise the task is indeterminate. Redis pub/sub carries updates to an SSE stream; polling is the fallback. Resumable work (ZIP entries) is idempotent so a restarted job continues from persisted state. | Implements `LIVE_OPERATIONS_ARCHITECTURE.md`; satisfies persistence across refresh and restart |
| D7 | **Recipes** are validated JSON configs with an inheritance chain: page recipe → category recipe → the page/category *editorial identity* (Phase 4) → built-in format default, resolved per field with sources (same mechanism as the editorial identity) | "Page-level settings override category defaults"; integrates the Phase 4 profile |
| D8 | **Text rendering uses `drawtext` with `textfile=` and `expansion=none`**, never text interpolated into the filter string | FFmpeg filter injection (`%{…}`, quotes, colons) |
| D9 | **Fonts come from a registry of real files** (configured directory + known system locations); an unavailable font is an error or an explicitly recorded substitution, never silent | honesty; reproducibility |
| D10 | **AI is grounded and never simulated**: prompts are built only from supplied context (brief, page category, effective identity, media facts, approved texts, track metadata) with explicit no-invention rules; outputs are validated and flagged (quotes attributed to people, numbers/claims, page-rule and originality issues); with no key the AI actions fail with `CONFIGURATION_ERROR` while manual entry and **clearly labelled deterministic templates** keep working | brief; existing honesty rule |
| D11 | **Generated content enters the Publishing Center as `DRAFT`** through the existing workflow service; nothing is submitted, approved or scheduled automatically; full provenance is kept on the render row and the content asset | no approval bypass |
| D12 | **Platform presets**: built-in geometry presets (9:16, 1:1, 4:5, 16:9) plus configurable limits each marked `ASSUMED`/`VERIFIED` with a source note; org-level overrides in a table | "do not apply arbitrary platform limits as facts" |
| D13 | **Legacy `VideoRenderJob` and `ContentGenerationJob` are not changed** and keep working; the new pipeline has its own rows and queues | "preserve all existing functionality" |

## 3. New dependencies (all small, widely used; versions pinned by the lockfile)

`yauzl` (streaming ZIP reader), `fast-xml-parser` (XLSX parts), `@aws-sdk/lib-storage` (streaming multipart upload to S3/R2). CSV is parsed by a small purpose-written RFC 4180 reader (tested) rather than a dependency. No SheetJS (`xlsx`): its npm releases carry known security advisories.

## 4. Risks and how they are contained

| Risk | Containment |
|---|---|
| ZIP bomb / zip-slip | D4; dedicated tests (traversal variants, ratio bomb, entry flood, nested archive) |
| FFmpeg unavailable or different build (libass/freetype) | `assertFfmpegAvailable` + a capability probe; actionable error; CI installs FFmpeg and **fails** (not skips) without it |
| Fonts differ per machine | registry + recorded resolution; tests use the same registry |
| AI hallucination of lyrics/facts | D10 grounding, output flags, mandatory human approval before anything is published |
| Large uploads exhaust disk | configurable limits, temp files removed in `finally`, quota messages |
| Worker killed mid-job | BullMQ stall recovery + idempotent steps + persisted progress; tested by interrupting a job |
| R2 not verified live | adapter verified against an S3-compatible service and unit-tested; **real R2 is not exercised** (needs the owner's bucket) |
| Scope | six sub-phases, each committed and tested before the next; anything not finished is listed in `PHASE5_CHECKPOINT.md`, never presented as done |

## 5. Unchanged by design

Publishing approval rules, scheduling, Upload-Post, Page Network behaviour, `ContentAsset`, `VideoRenderJob`, `ContentGenerationJob`, existing migrations, `main`.
