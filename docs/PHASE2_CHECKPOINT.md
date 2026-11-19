# Phase 2 (Upload-Post) — checkpoint

Branch `phase2-uploadpost` (base `main` @ `f061229`, the merged Phase 1). **Not merged. Not pushed as complete.**
This file is updated after every significant milestone so a session can always resume from it.

## 1. Where the work stands (milestone 3 — API and webhook complete; dashboard next)

| # | Unit | Status |
|---|---|---|
| 1 | Provider client package `@socialith/upload-post` (client, errors, normalization, webhook verification, contract double) | **done**, 39 tests |
| 2 | Data model + configuration (additive migrations) | **done** |
| 3 | Worker: profile/account synchronization | **done**, 14 real-MySQL tests |
| 4 | Worker: status synchronization, immediate video/photo publishing, correlation, duplicate protection, error classification, retries | **done**, wired into the existing publishing/poll processors, 23 tests |
| 5 | Worker: hybrid scheduling (hand-off, drift, status sweep, one-owner guards) + BullMQ queue/repeatables | **done**, 21 tests |
| 6 | API endpoints (overview, health, plan, profiles, accounts, mapping, destinations, publications, scheduled, ManagedPage/Creator, TikTok music + mappings) | **done**, real express app + MySQL + Redis tests |
| 7 | Webhook endpoint (raw-body signature verification, dedupe, enqueue reconcile) | **done**, 7 tests |
| 8 | ManagedPage / Creator mapping (API) | **done** |
| 9 | Dashboard pages (8) | pending |
| 10 | API integration tests, docs (`UPLOAD_POST_INTEGRATION/API_MAPPING/SETUP/TESTING.md`), CI/Docker re-validation, final report | pending |

## 2. Git state

- Commits on the branch (after `f061229`): `e0106f0` client package · `24fd62e` schema/migration/config · `a707d38` `notes` migration ·
  `b35ea3f` worker sync/status/publish modules · *(this milestone's commit: worker wiring, sweep, ownership guards, tests)*.
- Uncommitted: none after the milestone commit (check `git status`).
- Migrations (all additive, none rewritten): `20260922000000_init_mysql`, `20261119120000_upload_post_provider`,
  `20261119130000_upload_post_publication_notes`. Verified on a fresh MySQL 8.4: applies, second run no-op, drift = none.

## 3. Design decisions that matter (and why)

- **Five concepts kept apart:** `UploadPostProfile` (provider container) · `UploadPostConnectedAccount` (one platform account;
  stable provider id + changeable public handle) · `ManagedPage` · `Creator` · **Publishing Destination** = a `SocialAccount`
  with `publishingProvider = UPLOAD_POST`, linked 1:1 to a connected account. Native accounts are untouched (`NATIVE` default).
- **Sync is read-only towards the provider and never deletes.** Upstream disappearances become `REMOVED` / `DISCONNECTED`;
  mappings survive. A failed or suspiciously empty provider answer changes nothing.
- **Identity safety:** if the stable account id behind a (profile, platform) changes, the destination link is **cleared**, the
  destination is flagged `ERROR`, an audit row is written, history is kept, and nothing re-attaches automatically (a second sync
  cannot re-enable it; a human re-links).
- **Duplicate protection:** one `UploadPostPublication` row per ContentTarget (unique), created before the provider is called;
  `external_id`/`request_id`/`Idempotency-Key` fixed per *generation*; after a timeout or any retry the provider is **asked**
  (status by request_id, or the schedule list by external_id) before anything is resent; always `async_upload=true`.
- **Hybrid scheduling:** Socialith owns the schedule. Hand-off is **off by default** (`UPLOAD_POST_SCHEDULE_HANDOFF_ENABLED`). A
  provider-owned target (`PROVIDER_SCHEDULED` + PENDING/UNKNOWN_OUTCOME/SCHEDULED_AT_PROVIDER) is skipped by the content-scheduling
  job, the stale hold and the reconciler (`scheduling/ownership.ts`). Drift (reschedule/cancel/leaves window) is pushed to the
  provider by the sweep; any doubt resolves to Socialith ownership, never to a double publish. Presigned (short-lived) media URLs are
  never handed to the provider's scheduler.
- **TikTok music** is attached only when a mapping is `VERIFIED_AVAILABLE`, rights-confirmed by a person, verified ≤ 30 days ago and
  the account has the `music` capability; otherwise the post goes out *without* music and `notes` says why.

## 4. Known issues / unverified assumptions

- **Nothing here has touched the live Upload-Post service.** No `UPLOAD_POST_API_KEY` exists on this machine. All behaviour is built
  from the documented contract and proven against the in-repo contract double. The first live checks must be read-only
  (`GET /api/uploadposts/me`, `GET /api/uploadposts/users`), after the owner puts the key in the local env file.
- Unverified until live: the exact `upload_completed` webhook payload (ids are read tolerantly and only used as a hint), whether the
  provider fetches media at schedule time or run time (hence the durable-URL rule), behaviour of `GET /status?request_id=` for jobs
  created with a schedule, per-platform field names beyond `tiktok_title`/`youtube_title`/`tiktok_music_id`.
- `UploadPostClient.createProfile` exists and is mock-tested but is deliberately not exposed (read-only sync comes first).
- `prisma format` reflowed whitespace in untouched parts of `schema.prisma` (cosmetic).

## 5. Tests executed (milestone 2)

- `@socialith/upload-post` unit: 39 passed · `@socialith/config`: 21 passed · worker unit: 75 passed.
- Worker real-MySQL 8.4 + Redis integration: **76 passed** (18 scheduling + 14 sync + 23 publishing + 21 hybrid scheduling),
  typecheck clean, lint 0 errors.
- Not yet re-run after this milestone: api unit/integration, web, Docker build, CI (do before the final report).

## 6. Next exact task (superseded: API/webhook are done - see section 1; the next unit is the dashboard)

### Original description of milestone 3 (done)

Milestone 3: **API** under `/api/upload-post/*` (RBAC: ADMIN+ to change, VIEWER+ to read): overview, health (`ping`, cached), profiles,
accounts (search/filter), mapping (profile→ManagedPage, account→Creator), enable/disable Publishing Destination, publications,
scheduled jobs, plan/capacity, manual sync enqueue (`UPLOAD_POST_MANUAL_SYNC_JOB_ID`), ManagedPage/Creator minimal CRUD, TikTok
music search/trending + `SoundMusicMapping` CRUD; then the **webhook route** (raw body, `verifyWebhookSignature`, dedupe on
`X-Upload-Post-Delivery`, enqueue `reconcile`). Then dashboard, API integration tests, docs, validation.

## 7. Resume checklist

```powershell
git status; git log --oneline -8; git branch --show-current          # expect phase2-uploadpost
docker compose -f docker-compose.mysql-test.yml up -d --wait mysql84 redis
$env:MYSQL_INTEGRATION_URL="mysql://socialith:it-app-throwaway@127.0.0.1:3384/socialith_it"; $env:REDIS_INTEGRATION_URL="redis://127.0.0.1:6390"
npx --yes pnpm@9.0.0 --filter "@socialith/worker" test:integration   # expect 76 passed
```
