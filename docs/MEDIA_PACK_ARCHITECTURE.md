# Media Pack architecture (Phase 5A)

How Socialith receives, protects, unpacks, measures and serves media. Decisions D1–D13 are in `PHASE5_AUDIT.md`; this file describes what was built.

## 1. What a user can do

* Upload ZIP packs and single files: ZIP, MP4, MOV, JPG, JPEG, PNG, WEBP, MP3, WAV, TXT, CSV, XLSX (drag and drop or file picker, real byte progress).
* Browse the **Media Library**: search (name, folder, tag), filter (type, shape, tag, pack, status), sort, preview, download the original.
* Open a **pack** (counts, refused files with reasons, campaign and page-group assignment, archive/restore) or an **asset** (preview, measured facts, tags, notes, usage rights, campaign and page-group assignment, re-analyze, archive/restore).
* Follow every background job in the **Processing Queue** with real progress (see §7).

Roles: everyone can read and stream; EDITOR can upload, tag, assign, archive, re-analyze; ADMIN confirms usage rights.

## 2. Components

| Piece | Where |
|---|---|
| Pure ZIP/path/signature/limit logic | `packages/media-pack` (no Prisma, no Express) |
| Probe, thumbnails, storage adapters | `packages/video-engine` (`probe.ts`, `thumbnails.ts`, `storage.ts`) |
| Progress maths (percentage, stall, elapsed) | `packages/studio` (pure, shared by API and web) |
| Upload, library and task routes | `apps/api` (`/api/media/*`, `/api/operations/tasks`) |
| ZIP extraction, analysis, progress writes | `apps/worker/src/media` and `tasks/reporter.ts`, queue `media-processing` |
| Screens | `apps/web/src/app/(app)/studio/*` |

Database (additive migration `20261122100000_media_pack_and_operation_tasks`): `media_packs`, `media_assets`, `media_derivatives`, `media_asset_tags`, `media_pack_campaigns`, `media_pack_page_groups`, `media_asset_campaigns`, `media_asset_page_groups`, `operation_tasks`. The legacy `ContentAsset`, `VideoRenderJob` and `ContentGenerationJob` are untouched.

## 3. Upload path

1. `multer` writes the request to a temp file in `UPLOAD_TMP_DIR` (disk storage; never a whole file in memory). The file filter checks the extension before any byte is accepted.
2. `validateUpload(fileName, declaredMime, head)` reads the first 4 KiB: extension allow-list, **magic-byte signature**, declared MIME cross-check, empty file, UTF-16 text. A file whose content does not match its extension is refused ("the content of fake.jpg is a text file, not a .jpg; the extension was not trusted").
3. SHA-256 is computed by streaming. The file is then stored **by stream** under a server-generated key (`libraryKeys`; no user-supplied name ever becomes part of a path) and the temp file is deleted in `finally`.
4. A ZIP creates a `MediaPack` (status PROCESSING) and an `operation_task`, and enqueues one BullMQ job. A single file creates a `MediaAsset` (ANALYZING) and a task. If the queue is unavailable the API answers 503 instead of accepting work it cannot do.
5. The same ZIP uploaded twice answers 409 unless `force=true` ("Process it again anyway" in the UI).

Size limits: `MEDIA_MAX_FILE_BYTES` (1 GiB) and `MEDIA_MAX_ARCHIVE_BYTES` (2 GiB), answered with 413 and a plain message.

## 4. ZIP processing (worker)

Two passes, one entry at a time:

1. **`scanZip`** reads only the central directory and refuses the whole archive for: not a ZIP, archive too large, too many entries (`MEDIA_ZIP_MAX_ENTRIES`, 2000), declared total too large (`MEDIA_ZIP_MAX_TOTAL_BYTES`, 4 GiB), declared compression ratio over `MEDIA_ZIP_MAX_RATIO` (100), path unsafe. Each entry gets a verdict: extract / ignore (`__MACOSX`, `.DS_Store`, `Thumbs.db`, hidden) / directory / reject (unsupported type, encrypted, too large…).
2. **`extractZip`** inflates each accepted entry to one temp file through a counting, hashing, bounded stream. **Limits are enforced on the bytes actually inflated**, not on the sizes the header claims, so a lying header is stopped mid-entry (`BOMB_DETECTED`/`RATIO_EXCEEDED`).

Path safety (`sanitizeEntryPath`): rejects `..` segments, absolute paths, drive letters, backslash tricks, NUL and control characters, over-long paths and excessive depth. Nothing is ever extracted to the file system by path; each entry is stored under a generated key and the sanitised path is only metadata (folder structure).

Per entry: re-validate the extracted content with `validateUpload`, hash, detect duplicates, store the original (never overwritten), create the asset, queue/perform analysis.

Pack outcome: **READY** (all usable), **PARTIAL** (some entries refused or failed; they are listed with reasons), **FAILED** (nothing usable or an archive-level refusal; the reason and a remedy are stored and the job is not retried).

Resume: `(packId, entryPath)` is unique and extraction skips entries already stored, so a worker killed mid-pack continues where it stopped and never creates duplicates. Progress is monotonic across restarts.

## 5. Analysis

`analyzeLocalAsset` runs `ffprobe` (JSON, parsed by the pure `parseProbe`): width, height (rotation-aware), aspect ratio (labelled only when within 1 % of a standard ratio, otherwise a decimal), duration, frame rate, codecs, audio presence, bitrate, container, sample rate, channels. A thumbnail (JPEG, fit in a box) is stored as a **derivative**, separate from the original.

Honesty rules: a value that was not measured is `null` and shown as "not measured"; a file whose kind does not match its content (`KIND_MISMATCH`) or that FFmpeg cannot decode (`NOT_DECODABLE`) becomes FAILED with a reason and a Re-analyze action. A thumbnail failure is a warning, not a failure. If FFmpeg is not installed the task fails with `CONFIGURATION_ERROR` and an administrator-facing remedy; nothing is faked.

## 6. Duplicates

An identical SHA-256 inside the organisation is recorded as a `DUPLICATE` row pointing at the first file; **no second copy is stored**. The pack page and the library show duplicates separately. Duplicates are exact-content only (perceptual matching is out of scope).

## 7. Progress and live tasks

One ledger, `operation_tasks`, written by the worker through `TaskReporter` (throttled, serialised, never resurrects a finished task). BullMQ remains the only executor (queue `media-processing`, deterministic job id `media-task-<taskId>`, 3 attempts, exponential backoff).

* Percentage is **computed on read** as `completed / total × 100`, and **only when the total is known**. Otherwise the API reports `indeterminate` and the UI shows an animation without a number. A running task that has been silent for `DEFAULT_STALL_AFTER_MS` is shown as stalled.
* Persisted in MySQL: a refresh or a worker restart does not lose it.
* The web app polls (2 s for active tasks, 6 s for finished ones), pauses while the tab is hidden, and shows an amber "stale" chip when a refresh fails. Server-sent events over Redis pub/sub arrive in 5E; polling stays as the fallback.

## 8. Storage and access control

* Library files live in `MEDIA_LIBRARY_DIR` (default: a temp directory), **outside** `LOCAL_STORAGE_DIR`, which is served publicly on `/media`. With R2 the library uses `R2_LIBRARY_BUCKET_NAME` (falling back to the main bucket, with the library's own key layout), and **no public URL is ever produced** for it. `R2_ENDPOINT` allows any S3-compatible store.
* Files are only reachable through `GET /api/media/assets/:id/content|thumbnail`: authenticated, organisation-checked, `Range` supported (206/416), `X-Content-Type-Options: nosniff`, private cache, `Cross-Origin-Resource-Policy: same-site`; text and spreadsheets are served as attachments. Storage keys are never exposed in any response.
* Originals are immutable. `putFile` refuses to overwrite (`StorageKeyExistsError`); local writes are atomic renames.

## 9. Configuration

`MEDIA_LIBRARY_DIR`, `R2_LIBRARY_BUCKET_NAME`, `R2_ENDPOINT`, `FFPROBE_PATH`, `MEDIA_MAX_FILE_BYTES`, `MEDIA_MAX_ARCHIVE_BYTES`, `MEDIA_ZIP_MAX_ENTRIES`, `MEDIA_ZIP_MAX_TOTAL_BYTES`, `MEDIA_ZIP_MAX_RATIO`, `MEDIA_ZIP_MAX_DEPTH`, `MEDIA_ZIP_MAX_PATH_LENGTH`, `TEXT_IMPORT_MAX_ROWS`, `TEXT_IMPORT_MAX_BYTES`. The worker image installs FFmpeg and fonts; CI installs them too and real-FFmpeg tests **fail** (not skip) when `CI=true` and FFmpeg is missing.

## 10. Tests

| Suite | What it proves |
|---|---|
| `media-pack` (63) | path sanitising, signatures/MIME, ZIP scan and extraction incl. traversal, bombs, encrypted, lying headers, entry limits; 160 MB archive in flat memory |
| `studio` (11) | percentage only with a known total, stall, indeterminate, elapsed |
| `video-engine` (48) | `parseProbe` (rotation, aspect labels), real `ffprobe`/thumbnails, S3 adapter against a real `S3Client` |
| worker integration (20 for media) | mixed archive, cross-pack/org duplicates, bomb, traversal, crash-resume, half-processed asset, missing FFmpeg, reporter semantics — real MySQL 8.4 + Redis |
| API integration (31 for media) | upload validation, 409/413/503, RBAC, org isolation, Range, search/filter, assignment, rights |

Browser check (manual, throwaway database, real API + worker + FFmpeg): a ZIP containing two videos, a PNG and its copy, a WAV, a TXT, a text file renamed `.jpg`, an `.exe` and a `__MACOSX` entry produced 5 ready, 2 refused (with reasons), 1 duplicate, 1 ignored; the bar moved from 1 of 8 (12.5 %) to 7 of 8 (87.5 %) with real worker counts; the video played with seeking (206), an unauthenticated request got 401 and the refused file's content 404.

## 11. Known limitations

* **Single-request uploads** (TD-60): a proxy such as Cloudflare caps a request body near 100 MB, and Node's `requestTimeout` (300 s) bounds slow connections. Chunked or direct-to-R2 upload is future work.
* **Real R2 is not verified** (TD-61); the adapter is verified against a real S3 client and an in-process S3 server.
* The **original archive is retained** (TD-63).
* A ZIP whose header lies about sizes fails mid-extraction; entries already extracted stay in the pack (TD-64).
* Browsers cannot play every container/codec (e.g. some MOV/HEVC files); the file is measured and downloadable, and a browser-friendly preview is produced by the renderer in 5C.
* Duplicate detection is exact-content only.
