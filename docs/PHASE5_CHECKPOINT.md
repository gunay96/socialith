# Phase 5 checkpoint

Branch `phase5-media-pack-ai-studio` (from main `a5f2470`). One sub-phase at a time; each ends with tests, documentation, commits and a report. Main is never modified; nothing is merged.

| Sub-phase | Scope | Status |
|---|---|---|
| **5A** | Media Pack manager, private storage, ZIP workers, analysis, library UI, progress ledger | **Complete** (this checkpoint) |
| 5B | Text Library, Content Format Engine (recipes) | Not started |
| 5C | Rendering engine on FFmpeg | Not started |
| 5D | AI Content Studio | Not started |
| 5E | Live operations: real-time updates, worker heartbeat, Live Task Center | Not started (the progress ledger and polling exist from 5A) |
| 5F | Publishing Center integration with provenance | Not started |

## 5A — what is in place

* Additive migration `20261122100000_media_pack_and_operation_tasks` (9 tables).
* New packages `@socialith/media-pack` and `@socialith/studio`; probe, thumbnails and streaming S3/local storage in `@socialith/video-engine`; 14 new environment variables in `@socialith/config`.
* Queue `media-processing` (12th BullMQ worker), `TaskReporter`, ZIP extraction, analysis.
* API: upload, library, packs, tasks (RBAC, organisation isolation, audit log).
* Web: Content Studio — Media Library, Upload, Processing Queue, asset and pack pages.
* CI installs FFmpeg and fonts; the worker image installs FFmpeg and fonts.
* Documentation: `PHASE5_AUDIT.md`, `MEDIA_PACK_ARCHITECTURE.md`, `TECHNICAL_DEBT.md` (TD-60 … TD-64), `OPERATIONS_RUNBOOK.md` (12 workers).

## 5A — verification (local, 2026-11-20)

| Check | Result |
|---|---|
| `pnpm lint` | 13/13 packages, 0 errors, no `eslint-disable` added |
| `pnpm typecheck` | 13/13 |
| `pnpm test` (unit) | 10/10 packages green (media-pack 63, studio 11, video-engine 48, config 30, api 237, worker 75, web 13, …) |
| API integration, MySQL 8.4 + Redis | 221 passed (31 media) |
| Worker integration, MySQL 8.4 + Redis | 132 passed (20 media) |
| Browser run on a throwaway database | upload, real progress, refused/duplicate handling, preview with Range, 401 without session |
| Docker images api/worker/web | see the 5A report |
| GitHub Actions (3 checks) | see the 5A report |

## Decisions that need the owner later

* Upload limits beyond the proxy cap (TD-60): chunked or direct-to-R2 upload.
* Retention of the original archive (TD-63).
* A real R2 bucket to verify the S3 adapter (TD-61).
