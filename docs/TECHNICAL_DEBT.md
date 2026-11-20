# Socialith — Technical Debt Register

Companion to PROJECT_AUDIT.md (same evidence tags: [live] [code] [test] [inferred]).
Severity: **S1** blocks real use or risks data/credential loss · **S2** blocks a
roadmap phase · **S3** quality/efficiency.

| ID | Sev | Debt | Evidence | Consequence | Fix direction |
|---|---|---|---|---|---|
| TD-01 | S1 | **No version control** (no Git repo, Git not installed) | [live] | No history, no rollback, no review, CI can never run, two code generations coexist unlabeled | `git init`, commit current tree as baseline, tag generation-1 (Docker) vs generation-2 (repo) |
| TD-02 | S1 | **Two divergent generations** (Postgres/argon2/Redis-required images vs MySQL/scrypt/Redis-optional source) | [live][code] | Rebuilding from compose gives the wrong schema; running both against one volume corrupts migration state | Decide DB engine (PROJECT_AUDIT §1.4), regenerate compose/CI/migrations from source |
| TD-03 | S1 | **Unapplied, untested MySQL baseline migration** | [code] | If MySQL is kept, first real `migrate deploy` is the first test | Run baseline against a throwaway MySQL in CI before any deploy; or revert to Postgres |
| TD-04 | S1 | **Worker deployed but crash-looping**; config-only cause | [live] | Entire async pipeline (render, generate, publish, analytics, token refresh) is down | See PROJECT_AUDIT §3.1; add worker env overrides |
| TD-05 | S1 | **Scheduling has no reconciliation**: only a BullMQ delayed job moves SCHEDULED→PUBLISHING; seed row 58 days overdue with no job | [live][code] | Lost Redis state or a DB-only write = post silently never fires | Periodic sweeper (due & SCHEDULED & no live job → re-enqueue/flag); make scheduling idempotent by state, not by queue presence |
| TD-06 | S1 | **No email delivery** (`EMAIL_PROVIDER=console` only) | [code] | Invitations and password resets never reach users → no real onboarding, creator portal impossible | Add Resend/SES/SMTP implementation behind existing `EmailService` |
| TD-07 | S1 | **TikTok client secret exposed in chat history; rotation pending** | [conversation] | Credential may be compromised | Rotate in TikTok portal, update secret store, never paste in chat |
| TD-08 | S2 | **No real-platform validation anywhere**: no completed OAuth callback, no real publish, no real analytics | [live] | All provider code is unit-tested against mocked HTTP only | Upload-Post path (UPLOAD_POST_INTEGRATION) and a sandbox account; record real responses as fixtures |
| TD-09 | S2 | **Publishing abstraction is platform-keyed**, assumes per-account OAuth token (`PublishInput.accessToken`) | [code] | Cannot express "same platform via different providers" or token-less provider accounts (Upload-Post) | Provider-keyed `PublishingProvider` registry; move credential resolution inside providers |
| TD-10 | S2 | **Data model is single-tenant-flat**: no Artist, MediaPack, ManagedPage, PageGroup, Creator, TextLibrary, Recipe, Approval | [code] | Product vision unbuildable without schema work | Additive migrations (see roadmap); never alter existing columns destructively |
| TD-11 | S2 | **RBAC lacks CREATOR role, approval role, per-page/group scoping** | [code] | Creator portal and page-level permissions impossible | Extend `UserRole` + scoped grants; keep existing hierarchy tests green |
| TD-12 | S2 | **`SocialAccount` conflates "a platform account" with "a managed page/creator"** | [code] | Cannot model thematic pages vs creators, groups, editorial identity | Add `ManagedPage`/`Creator` that *reference* `SocialAccount`/provider accounts; do not repurpose SocialAccount |
| TD-13 | S2 | **FFmpeg engine is thumbnail-only; export presets unused** | [code] | Content Format Engine has no media backend | Implement operations incrementally on top of existing `VIDEO_OPERATIONS` registry |
| TD-14 | S2 | **Upload path buffers up to 200 MB in process memory** (multer memoryStorage) | [code] | OOM/latency under concurrent uploads; blocks large media packs | Direct-to-R2 presigned/resumable upload; keep API as signer |
| TD-15 | S2 | **Media storage: local disk, unauthenticated `/media`, R2 unconfigured** | [code] | Not multi-instance safe; public URL guessing risk; platforms need stable public URLs | R2 with signed URLs; per-asset access policy |
| TD-16 | S2 | **Worker lacks `API_PUBLIC_URL`** → localhost asset URLs | [live][code] | Publishing/Upload-Post would receive unreachable media URLs | Same env override as TD-04; add boot-time assertion in production |
| TD-17 | S3 | CI/compose/Dockerfiles stale vs. schema | [code] | Red CI the moment Git exists | Regenerate with chosen engine |
| TD-18 | S3 | No integration/E2E tests (DB, HTTP, browser) | [test] | Regressions in SQL/Prisma/serialization undetected; MySQL-vs-Postgres drift invisible | Testcontainers-style DB tests; Playwright smoke for login/dashboard/connect |
| TD-19 | S3 | `.env.example` incomplete vs. config schema; `.env` carries stray host values (Windows `FFMPEG_PATH`) | [code][live] | Misconfiguration on every new machine | Generate `.env.example` from the zod schema; split dev/prod env files |
| TD-20 | S3 | `QUEUE_NAMES.NOTIFICATIONS` declared, no processor; `cleanup` queue is a smoke-test stub | [code] | Dead surface | Implement or remove when Notifications are scoped |
| TD-21 | S3 | Quick-tunnel URL is ephemeral; nginx caches upstream IPs (stale after api recreate) | [live] | Repeated manual recovery (hit twice) | Named tunnel or real domain; nginx `resolver` + variable upstream |
| TD-22 | S3 | MySQL-compat residue if Postgres is chosen: six filters lost `mode:"insensitive"`; `scopes` stored as Json | [code] | Case-sensitive search regression on Postgres | Restore `mode`, keep Json or revert to `String[]` |
| TD-23 | S3 | Worker boot imports run `loadEnv()` at module scope (`publishing/enqueue.ts`, `scheduled/producers.ts`, API `lib/queue.ts`) | [code] | Config errors surface as import-time crashes with no structured log | Lazy init + a single validated bootstrap |
| TD-24 | S3 | No observability beyond pino logs + `/health`; `SENTRY_DSN` unused | [code] | Cannot see publish failure rates | Metrics + error tracking once provider layer lands |

## Status updates — after Phase 0 (2026-11-19)

| ID | New status |
|---|---|
| TD-01 | **Resolved locally**: Git installed, repository initialised, baseline tag `baseline-gen2`, 4 commits. **Open:** private GitHub repo not yet created/pushed (owner action, `SOURCE_CONTROL_AND_INFRA_CHECKLIST.md` §F). |
| TD-02 | **Decided**: MySQL is canonical; the Postgres/argon2 generation is retained only as rollback/reference (images tagged `:gen1`, volume and logical dump preserved, untouched). Compose/CI/Dockerfiles still Postgres-era → Phase 1. |
| TD-03 | **Resolved**: baseline applied to real MySQL 8.0.46 and 8.4.13, no drift, 18/18 integration tests. (Not yet on the VPS.) |
| TD-04, TD-05, TD-16 | Open — Phase 1 (worker env, reconciliation sweeper, stale-content guard, `API_PUBLIC_URL`). |
| TD-06, TD-07 | Open — e-mail provider (Phase 1/8); TikTok secret rotation (owner). |
| TD-17 | Open, narrowed: CI still Postgres → rewrite with the MySQL suite in Phase 1. |
| TD-18 | **Partly resolved**: a real-database integration suite now exists (API repositories/services on MySQL). Still no HTTP E2E or browser tests. |
| TD-22 | **Obsolete** under the MySQL decision (nothing to restore). |

New items found by the real MySQL run:

| ID | Sev | Debt | Evidence | Consequence | Fix direction |
|---|---|---|---|---|---|
| TD-25 | S3 | `%` and `_` in search text act as LIKE wildcards (Prisma `contains` does not escape them) | [test] pinned by a characterization test | `100%` also finds `100 organic`; no isolation impact (parameterized, org-scoped) | Escape wildcards in the six filters via one shared helper; update the pinned test deliberately |
| TD-26 | S2 | **Concurrent upserts can lose a race on MySQL** (no native Prisma upsert): 2–3 of 6 parallel `upsertSocialAccount` calls failed with `P2002` (never a duplicate row) | [test] | Double-clicked/duplicated OAuth callback → intermittent 500 | Catch `P2002` and retry once (or use `INSERT … ON DUPLICATE KEY UPDATE` via raw SQL) in `upsertSocialAccount`/`upsertPlatformConnection`; keep the test as the regression guard |
| TD-27 | S1 (fixed) | **UTF-8 BOM in `migration_lock.toml`/`migration.sql`** (PowerShell 5.1 `-Encoding utf8`) broke `prisma migrate deploy` (P3019) | [test] | Would have failed the first real deployment; unit tests could not detect it | Fixed in `85b98b3`. Guard: never write repo files with PowerShell 5.1 `Out-File/Set-Content -Encoding utf8`; the integration suite and a CI "no BOM" check catch regressions |
| TD-28 | S3 | Line endings: Windows checkouts could turn `migration.sql` into CRLF and change its Prisma checksum | [code] | Checksum mismatch vs. a Linux-applied migration | Fixed: `.gitattributes` `* text=auto eol=lf` (`68e484d`) |
| TD-29 | S3 | Superseded cPanel ZIPs (contain the BOM defect) still exist in `deploy-clean/` and the private backup | [live] | Someone could upload a broken package | Marked superseded in `DEPLOYMENT_PLAN.md`; folder is git-ignored; delete after the VPS is verified |
| TD-30 | S3 | Turkish dotless `ı` ≠ `i` under `utf8mb4_unicode_ci` search | [test] | `kapi` does not find `Kapı` | Accept for now; evaluate a Turkish collation or normalized search column when the Text Library/search is built (Phase 5) |

## Status updates — after Phase 1 (2026-11-19, branch `phase1-infrastructure`)

| ID | New status |
|---|---|
| TD-04 | **Resolved for the canonical stack**: the worker boots healthy (all 11 BullMQ workers ready) in the new VPS compose. The **legacy** worker is intentionally *not* repaired (legacy stack untouched by instruction); its root cause is documented. |
| TD-05 | **Resolved**: DB→Redis reconciler (boot + every minute), stale-content hold, stuck-PUBLISHING recovery. Drilled on a real stack incl. a total Redis wipe. |
| TD-16 | **Resolved**: production config refuses a missing/localhost `API_PUBLIC_URL`; one URL set feeds api, worker and migrate. |
| TD-23 | **Mitigated**: `bootstrap.ts` entry points validate config first and emit one structured fatal line; module-scope `loadEnv()` calls still exist but can no longer crash unreadably. |
| TD-26 | **Resolved**: `connectAccount` retries the lost upsert race. Before: 9 of 10 simultaneous callbacks failed; after: 10/10 succeed on MySQL 8.0 and 8.4. |
| TD-17 | Narrowed: a MySQL-based compose exists; **CI is still PostgreSQL-era** (no repo workflow runs the MySQL/Redis integration suites yet). |
| TD-18 | Improved: real-database suites for api (22 tests) and worker (18 tests). No automated HTTP/browser E2E in the repo (the E2E run was manual, documented in `VPS_DEPLOYMENT.md` §7). |
| TD-25, TD-30 | Open (unchanged). |

New items found in Phase 1:

| ID | Sev | Debt | Evidence | Consequence | Fix direction |
|---|---|---|---|---|---|
| TD-31 | S3 | Test files are excluded from `tsc` (`tsconfig.base.json` excludes `**/*.test.ts`) | [live] a missing `vi` import in an integration test was not caught by typecheck | Type errors in tests surface only at runtime | Add a test tsconfig / `typecheck:tests` step to CI |
| TD-32 | **S1** | **No production bootstrap-owner command**: the only way to create the first OWNER is `seed.ts`, which also creates demo accounts and a known dev password | [code] | Nobody can log in on a real deployment without running the dev seed (must never run in production) | Add a one-off, non-seed `create-owner` command (needs approval; Phase 8 e-mail not required) |
| TD-33 | S3 | A held (stale) item cannot be re-scheduled from the UI — only `PENDING` targets are re-scheduled; Retry (publish now) is the supported path | [code] | Awkward recovery for held items | Let `scheduleContent` re-arm FAILED/held targets, or add a "Reschedule held" action |
| TD-34 | **S1** | **No off-site backup** (dump stays on the VPS disk); binlog PITR not drilled | [code] | VPS loss = data loss | rclone/`aws s3` sync to R2/other region with write-only credentials; drill PITR |
| TD-35 | S2 | No monitoring/alerting stack; only health endpoints and container healthchecks | [code] | Outages and backlogs go unnoticed | External uptime check + log/metric shipping (`OPERATIONS_RUNBOOK.md` §4) |
| TD-36 | S3 | `content` has no index on `(status, scheduled_at)`; the reconciler's per-minute `status = 'SCHEDULED'` scan relies on `(organization_id, status)` which cannot serve it | [code] | Full-table scan each minute — fine at thousands of rows, not at hundreds of thousands | Additive migration adding the index when volume warrants |
| TD-37 | S3 | Legacy Docker stack's worker is still crash-looping (deliberately left untouched) | [live] | Confusing if someone reads its logs | Remove the legacy stack once the VPS deployment is verified |

## Status updates — Phase 1 final hardening (2026-11-19, branch `phase1-infrastructure`)

| ID | New status |
|---|---|
| TD-32 | **Resolved**: `apps/api/src/cli/bootstrap-owner.ts` (procedure: `VPS_DEPLOYMENT.md` §4a). Production-only, `--confirm-domain`, refuses if any user or the dev seed exists, idempotent for the identical owner, SERIALIZABLE transaction (8-way race: exactly one owner, 10 rounds × 2 runs on MySQL 8.0 and 8.4), password only via hidden prompt / stdin / file, never logged. Drilled in the real api image against MySQL 8.4 with the DML-only account, incl. a real pseudo-terminal and a successful login through the production-mode API. |
| TD-17 | **Resolved**: `.github/workflows/ci.yml` rewritten for MySQL 8.4 + Redis (jobs `hygiene`, `verify`, `images`; `docs/CI.md`). Every step replayed locally. **Owner action:** require the three checks in branch protection. First real GitHub run still pending (no push yet). |
| TD-07 | Documented, **still open (owner)**: `SECURITY_CREDENTIAL_ROTATION.md` — the secret was found only in local git-ignored files and the legacy containers, never in Git; rotation at TikTok is the only fix. |
| TD-27 | Guarded: the CI `hygiene` job fails on a BOM in Prisma migrations / shell / YAML / TOML and on CRLF in migrations/shell. |
| TD-31 | Still open (test files not typechecked). |

New items found in the hardening pass:

| ID | Sev | Debt | Evidence | Consequence | Fix direction |
|---|---|---|---|---|---|
| TD-38 | S3 | Windows PowerShell 5.1 prepends a UTF-8 BOM to text piped to native programs | [live] caught by the bootstrap drill: the owner's stored password began with U+FEFF and login returned 401 | Any tool that takes a secret on stdin from PowerShell 5.1 can silently store a different secret than typed | Fixed for the bootstrap command (one leading BOM is stripped from stdin/file input). Keep in mind for any future stdin-fed tool |
| TD-39 | S3 | A GET_LOCK-based "single owner" guard is **not** safe with pooled connections: the lock is released before the transaction commits | [test] two owners created in 1 of 3 racing rounds on MySQL 8.0 | — | Replaced by a SERIALIZABLE transaction + retry; the race test (10 rounds × 8 racers) stays as the regression guard |
| TD-40 | S3 | CI runs MySQL 8.4 only; MySQL 8.0 compatibility is verified manually | [code] | An 8.0-only regression would not be caught on push | Add a matrix entry if 8.0 support is still wanted (it reaches end of life in April 2026) |
| TD-41 | S3 | Deadlock-victim retries make Prisma log `prisma:error` lines during the concurrency tests | [test] | Noisy test output only; the retry is the intended behaviour | Accept |

## Status updates — Phase 2 (Upload-Post, branch `phase2-uploadpost`)

| ID | New status |
|---|---|
| TD-12 | **Partly resolved**: `ManagedPage` and `Creator` exist as minimal mapping targets that *reference* provider accounts (SocialAccount is untouched). The Page Network proper is Phase 4. |
| TD-15, TD-14 | Unchanged. New consequence: presigned (≈ 1 h) R2 URLs are never handed to a provider scheduler (`assetUrlsAreDurable`). |

New items found in Phase 2:

| ID | Sev | Debt | Evidence | Consequence | Fix direction |
|---|---|---|---|---|---|
| TD-42 | S3 | Synchronization reads `GET /users` as one full list (the provider documents no pagination) | [doc] | Fine at the documented scale (≤ ~225 profiles); a provider change to pagination would truncate silently | Verify LIVE (UPLOAD_POST_API_MAPPING §6.1); add cursor handling if it paginates |
| TD-43 | S3 | No profile-creation flow (client method exists and is mock-tested, not exposed) | [code] | Profiles must be created in Upload-Post | Add after read-only sync is verified LIVE; respect the reported profile limit |
| TD-44 | S3 | Provider-side history is not imported; "Publishing history" shows publications Socialith originated | [code] | Posts made directly in Upload-Post are invisible here | Optional import via `GET /history` when needed |
| TD-45 | S2 | Every provider response shape is documented-but-unverified (no live key during development) | [test] | A real difference would only show on first live use | Run `scripts/upload-post-live-check.mjs`, then reconcile `normalize.ts` with redacted fixtures |
| TD-46 | S3 | Malformed JSON used to answer 500 on every route | [test] found by the webhook tests | Misleading errors | Fixed: body-parser errors now answer 400/413 |
| TD-47 | S2 | **No Artist entity** (Phase 7): the Publishing Center filters by the free-text `Sound.artist` and the "track" is the existing `Sound` | [code] | Artist-level reporting and selection are approximate (typos split artists) | Phase 7 Artist/Music/Campaign model; then replace the text filter |
| TD-48 | S3 | **No Page Group / category concept** (Phase 4): the destination picker filters by Managed Page and Creator only | [code] | "Page Group" and "category" filters of the brief do not exist yet | Phase 4 Page Network |
| TD-49 | S2 | **Media duration / dimensions are not extracted** (only `sizeBytes` is recorded on upload; renders record none). Aspect-ratio, duration and dimension checks therefore cannot run; the system reports the media as **UNVERIFIED / PARTIAL and the publication as not fully validated**, naming the unknown facts, and never as validated | [code][test] | Platform validation of the media itself is weaker than it can be; an approver sees "NOT FULLY VALIDATED" on most uploads; the platform may still refuse a file | Media Pack processing (Phase 5): probe with FFmpeg/ffprobe at upload and on render (the video engine already ships FFmpeg) and store the facts on the asset. Until then nothing may present the media as verified (enforced by `assessMedia` + the dashboard). Provider/platform capability validation stays active |
| TD-50 | S2 | Platform duration / file-size / aspect thresholds are **assumptions, not live-verified** (`PLATFORM_RULES`) | [doc] | A valid post could be blocked, or an invalid one allowed | Verify per platform during the first real tests (`PUBLISHING_TESTING.md` §6); the TikTok per-account `max_video_post_duration_sec` from Upload-Post can replace the static value |
| TD-51 | — | ~~Organizations that never saved Publishing Settings did not require approval~~ **CLOSED (owner decision, Phase 3 final)**: approval is required by default for new organizations and for organizations with no saved preference; explicit preferences are preserved | [code][test] | — | Done |
| TD-52 | S3 | Calendar has no drag-and-drop rescheduling and no automated browser tests for the Publishing Center | [code] | Rescheduling is a button + date field; UI regressions are caught by hand | Add drag-and-drop and a Playwright smoke suite |
| TD-53 | S3 | Manual Upload-Post sweep after an operator change is best-effort and deduplicated; the provider job is edited within seconds when the queue is up, otherwise on the next minute tick | [code][test] | Brief delay in provider-side cancel/edit | Acceptable; the database is the master either way |

## Status updates — Phase 4 (Page Network, branch `phase4-page-network`)

| ID | New status |
|---|---|
| TD-10 | **Partly resolved**: `ManagedPage` (extended), `PageCategory`, `PageGroup` and the campaign-page links now exist; Artist, MediaPack, TextLibrary, Recipe remain (Phases 5-7). |
| TD-12 | **Resolved**: thematic pages, creators, publishing destinations and Upload-Post profiles are four separate records; a page *references* its destination (`managed_pages.social_account_id`), `SocialAccount` was not repurposed. |
| TD-48 | **Resolved for the Page Network** (category, group and platform filters on pages and groups; pages by category on campaigns). The Publishing Center's own list still filters by page, not by category or group (see TD-56). |

| ID | Sev | Debt | Evidence | Consequence | Fix direction |
|---|---|---|---|---|---|
| TD-54 | — | ~~`GET /api/analytics/campaigns/:id` answered 500 on MySQL~~ **RESOLVED (Phase 4 final fix)**. Root cause: `analytics.repository.ts` used PostgreSQL-only `DISTINCT ON`; the same pattern, plus `::int`, a double-quoted alias (a string literal in MySQL, which would have silently broken the ordering) and `JOIN LATERAL … ON true`, was in the dashboard top-content / top-sounds queries, and the dashboard overview shares the rollup, so the content, sound, account and campaign analytics endpoints and the dashboard all failed. Fixed in place (no new analytics layer): the rollup uses `ROW_NUMBER() OVER (PARTITION BY content_target_id ORDER BY fetched_at DESC, id DESC)` in chunks of 1,000 targets; the dashboard queries use a MySQL `LATERAL` derived table with the same tie-break, backtick aliases and a numeric conversion of the `BIGINT` result. Semantics are unchanged (latest snapshot per target only; NULL counters add 0; a NULL newest snapshot does not fall back to an older one); ties are now deterministic (they were arbitrary). 12 MySQL integration tests (`analytics.integration.test.ts`); against the old code 10 of the first 11 fail with error 1064 | [live][test] | — | Done |
| TD-55 | S3 | Group-level content preferences are applied only when a group is named (identity preview, text check). A page in several groups would otherwise have an ambiguous group layer, so the Publishing Center's page rules use page over category only | [code] | A group preference never silently changes what a page is checked against | Decide a precedence (e.g. the campaign's group) in Phase 6 when the Format Engine starts consuming the profile |
| TD-56 | S3 | Two page mappings coexist: the Phase 2 profile mapping (`upload_post_profiles.managed_page_id`, brand level) and the Phase 4 destination link (`managed_pages.social_account_id`, per platform). A direct link wins in the Publishing Center; a mismatch is flagged on the page, never changed automatically | [code] | An administrator may see "profile mapped to another page" until they tidy the Phase 2 mapping | Optional clean-up tool; the Publishing Center category/group filters belong here too |
| TD-57 | S3 | The "account has a problem" page filter is computed in memory after loading the matching pages (the state is derived from live provider rows, no column holds it) | [code] | Fine for tens to low hundreds of pages; slow if a network grows to thousands | Materialize the state on sync if the network grows |
| TD-58 | S3 | The Creator role does not exist yet (Phase 8). Privacy is enforced by never putting creator data into page responses and by refusing creator-owned accounts as page destinations; the role gate (`canSeeInternal`) is ready for a role below VIEWER | [code][test] | None today (no creator logins) | Phase 8: add the role and tests through the API |## Phase 5A — Media Pack (status of earlier items, new items)

| ID | Status |
|---|---|
| TD-10 | **Partly resolved**: `MediaPack`/`MediaAsset` and the `operation_tasks` progress ledger exist. TextLibrary and Recipe follow in 5B; Artist remains Phase 7. |
| TD-14 | **Resolved for the media library**: uploads stream to disk (multer `diskStorage`), hash and store by stream, and never buffer a file in memory (a 160 MB ZIP is processed in flat memory in the tests). The legacy `ContentAsset` upload path is unchanged. |
| TD-15 | **Resolved for the media library**: the library lives in a private directory/bucket and is served only through authenticated, organisation-checked routes (Range supported). The legacy public `/media` route still serves the legacy assets. Real R2 is not verified (no bucket): the S3 adapter is tested against a real `S3Client` with an in-process S3 handler. |

| ID | Sev | Item | Impact | Remedy |
|---|---|---|---|---|
| TD-60 | S2 | **OPEN (owner decision at 5A acceptance: stays open until the implementation AND the real-R2 verification are complete). Single-request uploads.** A file is sent in one HTTP request. Behind Cloudflare a request body is capped at about 100 MB on the free/pro plans, and Node's `requestTimeout` (300 s) bounds slow uploads. Server-side limits (`MEDIA_MAX_FILE_BYTES` 1 GiB, `MEDIA_MAX_ARCHIVE_BYTES` 2 GiB) are higher than what the proxy accepts. | Large packs uploaded through the public tunnel fail at the proxy, not in the application | **Decided: direct-to-R2 multipart upload** with backend-created sessions, short-lived presigned part URLs, chunk-level progress, server-side completion verification, checksums, expired-upload cleanup and worker processing: designed in DIRECT_UPLOAD_ARCHITECTURE.md, not yet built. The single-request path stays for development and small files only; until the new path exists, upload large packs on the LAN or split them |
| TD-61 | S2 | **Mandatory before production deployment (owner decision; it does not block development).** Real R2 / MinIO is not exercised in CI. Nothing may claim real R2 connectivity until the actual bucket has been tested. The S3 adapter is verified against a real AWS SDK client with an in-process S3 handler (put, ranged get, multipart, no-overwrite, delete). | A provider-specific difference would show on first use | Run the adapter test suite against a MinIO container in CI, and once against the owner's real bucket |
| TD-62 | S3 | Several older `AI_*` variables use `emptyStringAsUndefined(x).default(y)`: an **empty string** (as written in `.env.example`) yields `undefined` instead of the default | The default is silently not applied when the variable is present but empty | Apply the default after the empty-string transform (found in Phase 5; not changed there to keep behaviour stable) |
| TD-63 | S3 | **Owner decision: originals are preserved by default and never deleted automatically; administrators can reach them; a configurable retention policy is designed but deletion will not be implemented until the owner approves a policy (MEDIA_PACK_ARCHITECTURE.md §12).** The original ZIP archive is retained next to its extracted files (immutable originals) | Roughly doubles storage for ZIP packs (archive + extracted files, about 4 GiB for a 2 GiB archive) | Optional retention policy (delete the archive after a successful extraction) once the owner decides |
| TD-64 | S3 | A ZIP whose header lies about sizes is stopped at the first entry that exceeds its limit **during** extraction; the entries extracted before that stay in the pack, which is marked FAILED with the reason (the task is not retried) | A partly extracted pack must be reviewed or archived by hand | Accept; documented in `MEDIA_PACK_ARCHITECTURE.md` |

## Phase 5B — Text Library and Content Recipes

| ID | Sev | Item | Impact | Remedy |
|---|---|---|---|---|
| TD-30 | — | **Resolved for the Text Library:** search uses a diacritic-folded copy of the text (search_text), so guzel finds Güzel; duplicate detection folds the Turkish i. The Media Library's name search still uses the database collation. | Media names with Turkish letters are searched exactly as typed | Add the same folded column to media assets if it is wanted there |
| TD-65 | S3 | The application shell's sidebar does not collapse on phones (pre-existing, all screens). The new pages have no horizontal overflow of their own at phone width | Every screen is cramped below about 700 px | Responsive shell: collapsible sidebar (separate task, affects all areas) |
| TD-66 | S2 | **RESOLVED in 5C.** Recipe motion (typewriter, line by line, slide, zoom, fade in/out) is now rendered by FFmpeg from the same timeline the preview plays, and each animation is verified by reading frames back (see `MEDIA_RENDERING.md` section 3). A still image cannot animate: the job says so and renders the text complete | - | - |
| TD-67 | S3 | No near-duplicate detection in the Text Library (only the same text after folding case, spacing, punctuation and the Turkish i) | Reworded copies of a text are separate texts | Use the Phase 3 similarity function against recent texts, as a warning, if wanted |
| TD-68 | S3 | **Partly resolved in 5C.** A successful render writes one `RENDER` usage entry (text, page, campaign, recipe, output file), exactly once even after a re-delivery. Publishing (5F) will write its own. Previews never count | A published text is not yet logged automatically | 5F |
| TD-69 | S3 | `text_usages.*`, `text_entries.import_batch_id`, content_recipes.required_text_category_id and duplicated_from_id are plain ids, not foreign keys (MySQL cannot cascade an organization delete through SET NULL links on the same cascade path). Integrity is kept by the services, and a reference whose target is gone is shown as removed | A dangling id is possible after a hard delete of a page, recipe or file (the app archives instead of deleting) | Accept; revisit if hard deletes are added |
| TD-70 | S3 | Text import is processed in the API request (limits: 5 MiB, 5000 rows, bounded XLSX inflation), with a dry run first; there is no background import task | A very large import must be split into files | Move to the worker with real row progress if volumes grow |
| TD-71 | S3 | The recipe font list is the five families the renderer image installs (regular and bold). Other fonts require adding font files to the image, the catalogue (`packages/studio/src/fonts.ts`) **and** the metrics table (`packages/video-engine/scripts/generate-font-metrics.ts`). A page asking for another typeface falls back with a warning, and the render report names the fallback | Unlicensed or unknown fonts are never guessed at | Extend the catalogue with licensed font files when the owner chooses them (5C kept the five families) |
| TD-72 | S2 | **Safe areas are ASSUMED.** The margins that keep text clear of platform overlays (`packages/studio/src/safe-area.ts`) were chosen for common vertical-video layouts, not measured from any platform's current interface | Text may still sit under an overlay on a platform whose layout differs; the interface labels the guide as an assumption | Measure against each platform's current guidance before relying on them for a platform; change one file |
| TD-73 | S3 | Line breaking uses **advance widths without kerning**, from a table generated from the worker's font files (`font-metrics.data.ts`). Three characters whose width or presence differs between `fonts-liberation` 1.07.4 (Debian 12, the worker image) and 2.1.5 (Ubuntu 24.04, the CI runner) are refused instead of drawn: U+00B7 (middle dot), U+040D, U+2011 (non-breaking hyphen). **A font package update can move line breaks**: the test `font-metrics.test.ts` compares the table with the installed fonts and fails, and the table must be regenerated | A text with one of those characters is refused as unsupported | Regenerate with the script when the image's fonts change; accept the limit |
| TD-74 | S3 | **Right-to-left text, emoji and characters outside Latin (incl. Turkish and Azerbaijani), Greek and Cyrillic are refused** (`UNSUPPORTED_TEXT`), never drawn as boxes. No text shaping (ligatures, complex scripts) | Arabic, Hebrew, Hindi, CJK and emoji captions cannot be rendered yet | Needs a shaping layer (for example drawtext with `text_shaping` and the right fonts) and a larger metrics table |
| TD-75 | S3 | **Visual regression is structural plus layout fixtures, not golden images.** Tests read decoded frames back and compare ink position, width, brightness over time and line bands with the plan; `plans.json` pins line breaks and positions. Nothing compares pixels with a stored screenshot, because glyph rasterization differs between FreeType and FFmpeg versions | A change that only alters glyph shapes or colours subtly would pass | Add SSIM goldens per FFmpeg version if shape-level regressions become a risk |
| TD-76 | S2 | **FFmpeg version support.** Real-FFmpeg tests pass on 5.1.9 (Debian 12, the worker image), 6.1 (Ubuntu 24.04, CI), 8.0.1 (Ubuntu 26.04) and 9.0.1 (Windows development). `drawbox replace=1` crashes 5.1.9 with a segmentation fault and is not used. Other FFmpeg builds are not tested | A different FFmpeg may behave differently | Keep the worker image's FFmpeg pinned by its Debian release; re-run the suite when it changes |
| TD-77 | S3 | The Rendering Studio lists the 20 most recent finished renders and 50 active ones; there is no bulk render, no scheduling of renders and no per-render preview before the file exists beyond the plan-based preview | Large batches are Phase 5D/5E work | 5D |
| TD-78 | S2 | **The Publishing Center cannot select a rendered file.** The output is a READY Media Library file tagged `rendered` (with full provenance on the render job), but publishing reads `ContentAsset.url` from the older asset store and never reads `media_assets`; library files are private and a platform needs a fetchable URL | A rendered video has to be attached to a publication by hand (download, upload through the existing path) until 5F; a published video does not link back to its render | 5F, after the owner decides how a private library file becomes a provider-fetchable URL (signed, short-lived or copied) and real R2 is verified |

## Debt that is **not** debt (preserve)
| TD-59 | S2 | **Native-OAuth token refresh in the worker is PostgreSQL-only**: `apps/worker/src/publishing/token.ts` `refreshAndPersist` takes `pg_advisory_xact_lock(hashtext(...)::bigint)`, which does not exist in MySQL. Found while sweeping for the TD-54 pattern; the unit test mocks the call, so no MySQL test covers it. **Production restriction: native OAuth token refresh must not be enabled on MySQL until this is fixed and verified** - leave `TIKTOK_/META_/GOOGLE_` OAuth credentials empty and publish through Upload-Post only | [code] | Refreshing an expiring token of a *natively* connected account (TikTok/Instagram/YouTube OAuth) fails on the MySQL stack: publishing, status polling and analytics sync for that account stop at the token step. Upload-Post destinations do not use this path, so the Upload-Post flow is not affected | Separate task, **prepared and not started**: `TD59_REMEDIATION_TASK.md` (row lock `SELECT … FOR UPDATE` on the connection row, MySQL integration tests, conditions for lifting the restriction). Not part of Phase 4 |

Layered architecture (routes → controllers → services → repositories), org-scoped
repositories, immutable `PublishAttempt` audit trail, retry/backoff classification
(`PublishError`), AES-256-GCM credential vault separated from account queries,
`PLATFORM_CAPABILITIES` honesty matrix, per-queue rate limits, graceful worker
shutdown. These are the reasons the roadmap extends rather than rewrites.
