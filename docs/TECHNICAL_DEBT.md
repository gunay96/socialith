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

## Debt that is **not** debt (preserve)

Layered architecture (routes → controllers → services → repositories), org-scoped
repositories, immutable `PublishAttempt` audit trail, retry/backoff classification
(`PublishError`), AES-256-GCM credential vault separated from account queries,
`PLATFORM_CAPABILITIES` honesty matrix, per-queue rate limits, graceful worker
shutdown. These are the reasons the roadmap extends rather than rewrites.
