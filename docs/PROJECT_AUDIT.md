# Socialith — Project Audit (Phase 0)

Audit date: 2026-11-19. **Read-only**: no code, env var, container, or database
was modified. Evidence level is stated per finding:
**[live]** observed on a running system today, **[code]** read from source,
**[test]** covered by an automated test that passed today, **[inferred]**
reasoned from the above and not directly observed.

Secrets (API keys, passwords, tokens) are never reproduced here; where an env
var matters only its *name* and whether it is set are given.

---

## 1. Source of truth — version comparison

### 1.1 What exists

| Source | Built / modified | Database | Password hashing | Redis | Health route | Notes |
|---|---|---|---|---|---|---|
| **Repo working tree** (`apps/`, `packages/`) | latest edit 2026-09-22 07:07 | **MySQL** provider; 1 baseline migration (`20260922000000_init_mysql`), generated offline, **never applied to any real MySQL server** | **scrypt** (`scrypt$v1$N$r$p$salt$hash`, `node:crypto`) | optional (`REDIS_URL` may be unset) | `/api/health` | `output: "standalone"`; 262 tests pass **[test]**; typecheck clean in all 9 packages **[test]** |
| **cPanel ZIPs** (`deploy-clean/*.zip`) | api 2026-09-22 07:09, web 2026-09-22 05:38 | MySQL (schema + baseline migration inside the API zip) **[code]** | scrypt, no `argon2` import **[code]** | optional | `/api/health` | Packaged from the repo tree above; **never deployed anywhere** (see 1.3). Web ZIP predates the scrypt change but web does not touch auth/DB, so it is equivalent. |
| **Docker images** (`socialith-prod-api/worker/web`) | api+worker 2026-09-22 00:22, web 00:32 | **PostgreSQL**; 11 migrations applied **[live]** | **argon2id** (seed user hash is `$argon2id$…`) **[live]** | **required** (`REDIS_URL` mandatory) **[live]** | `/health` (root) **[live]** | Generation 1. Predates every change made on 2026-09-22 after ~00:30 (MySQL pivot, scrypt, Redis-optional, health move). |
| **Docker volumes** | — | Postgres data = seed data only (see 1.2) | argon2id | Redis holds only repeatable-scan keys | — | — |
| **docker-compose files** (`docker-compose.yml`, `.prod.yml`, `.tunnel.yml`, `.prod.local-test.yml`) | 2026-09-21/22 | Postgres service + `postgresql://` URLs | — | Redis | — | **Incompatible with the current schema** (provider is `mysql`). |
| **CI** (`.github/workflows/ci.yml`) | 2026-09-21 | Postgres service + `postgresql://` | — | Redis | — | Stale vs. schema; moot today because the project is not under version control. |

### 1.2 Data actually present (Docker Postgres, read-only SELECTs) **[live]**

1 organization, 1 user (`owner@socialith.local`, OWNER, the dev seed account), 5 social
accounts + 5 connections (seed rows with fake tokens), 2 campaigns, 2 content
items, 5 content targets, 0 sounds, 0 publish attempts, 7 audit-log rows.
**There is no real production data in any database.** Therefore any engine
choice or migration rewrite is data-loss-free; only schema/code fidelity matters.

### 1.3 Version control and deployment reality

- **No Git repository exists** (`git` is not even installed on this machine; no
  `.git`). There is no branch, no commit history, no remote. The file system is
  the only record. This is the single largest process risk (see TECHNICAL_DEBT TD-01).
- **No production deployment has ever succeeded.** `https://socialith.co` serves an
  unrelated third-party site (checked 2026-09-22; not re-checked today — **[inferred]**
  unchanged). The Güzel Hosting SSH path was never reachable; the cPanel ZIPs were
  never uploaded **[inferred from conversation history, not observable from here]**.
- The only runnable system is the local Docker stack + temporary Cloudflare quick
  tunnel (URL changes on every restart).

### 1.4 Verdict — canonical source

**The repo working tree is the canonical source of code.** It is a strict superset
of the Docker images: same features plus the MySQL-compat fixes, scrypt,
Redis-optional boot, `/api/health`, standalone web output and a handful of extra tests (scrypt, health-without-Redis).
Docker images are disposable generation-1 build artifacts and must be rebuilt, not
used as a base.

**The database engine is a separate decision and is NOT silently chosen here.**
Facts that bear on it:

| Question | PostgreSQL line (Docker/CI) | MySQL line (repo/ZIPs) |
|---|---|---|
| Why it exists | Original design | Forced by a shared cPanel host that has no Postgres |
| Verified against a real server | Yes — runs today, 11 migrations applied | **No** — migration SQL never executed against MySQL |
| Code divergences already introduced | none | `scopes` String[]→Json; 13 columns `@db.Text`; 6 `mode:"insensitive"` filters removed (search becomes collation-dependent) |
| Needed by the new product | JSONB querying (style profiles, recipes), arrays, full-text search for the Text Library, partial indexes, case-insensitive search | Possible but weaker for these |
| Compatible with a worker host | Yes (any VPS) | Yes |

**Recommendation (owner decision required):** the new product requires a persistent
worker + Redis + FFmpeg (see DEPLOYMENT_PLAN), which cannot run on the shared host
that forced MySQL. Once production is a VPS, the reason for MySQL disappears. Recommend
**PostgreSQL as the production engine**, reverting the provider while keeping the
harmless portability work (`Json` scopes, `@db.Text`) and re-adding
`mode:"insensitive"` to the six search filters. Rewriting the baseline migration is
free because no data exists. If the owner instead insists on keeping the shared
host for the web/API tier, MySQL stays and the first roadmap task becomes an integration
test run against a real MySQL instance.

---

## 2. Application audit (18 areas)

Legend: **WORKING** · **PARTIAL** · **BROKEN** · **MISSING**.

| # | Area | Status | Evidence / notes |
|---|---|---|---|
| 1 | Frontend pages | WORKING / PARTIAL | 16 routes: Dashboard, Accounts (+detail), Campaigns (+detail), Content (+detail), Sounds (+detail), Team, Login, Forgot/Reset password, Accept invitation, Terms, Privacy. Login page returns 200 through the live tunnel **[live]**; page rendering with seed data was verified on 2026-09-22. **No pages exist** for artists, media packs, page network, text library, content studio, creators/portal, publishing calendar, analytics center, provider settings. ~3.9k lines. |
| 2 | Login & authentication | WORKING | Session cookie (express-session, sameSite=lax, secure in prod), invitation-only accounts, 4 roles (OWNER/ADMIN/EDITOR/VIEWER) with `requireMinimumRole`, password reset, `sessionVersion` invalidation, org-scoped queries **[code][test]**. **Gap:** `EMAIL_PROVIDER` only supports `console` — invitation and reset emails are logged, never delivered, so no real user can be onboarded. |
| 3 | Dashboard | WORKING | KPI counts from DB; "Top content/sounds by views" empty until analytics sync runs **[live 09-22]**. |
| 4 | Account management | PARTIAL | List/filter/detail/disconnect **[test]**. Real OAuth connect: TikTok start reaches TikTok's authorize page with correct PKCE/scopes **[live 09-22]**; **callback never completed end-to-end** (redirect URI not registered for any stable domain; TikTok app still Draft with an unexplained "client_key" error). Instagram/YouTube connect code exists, no credentials configured. |
| 5 | Artist & music modules | MISSING / PARTIAL | Only `Sound` (reference metadata: title, artist string, platform, external id, URLs). No Artist entity, tracks, releases, ISRC, audio storage, lyrics, or catalogue UI beyond a list. |
| 6 | Video upload | PARTIAL | `POST /api/content/:id/assets/upload` (multer **memory** storage, 200 MB cap) + URL-only assets **[code]**. Memory buffering of 200 MB per request is a scaling risk; no resumable/direct-to-R2 upload; no media validation (codec/duration/aspect). |
| 7 | FFmpeg / media processing | PARTIAL | Only `THUMBNAIL` operation exists (`VideoRenderOperation` enum has one value). Platform export presets (TikTok/Reels/Shorts) are defined in `packages/video-engine/src/presets.ts` but **consumed by nothing** in `apps/` **[code]**. No text overlays, trimming, aspect conversion, audio mixing. |
| 8 | Redis & BullMQ | WORKING (infra) | 11 queue names; API is a producer, worker the consumer; Redis healthy, queues all zero **[live]**. API now boots without Redis (repo only). |
| 9 | Worker startup/shutdown | BROKEN (deployed) / WORKING (code) | Deployed worker crash-loops — see §3. Code: 10 BullMQ workers, readiness flags, `/health` on 4100, graceful SIGTERM shutdown **[code]**. |
| 10 | Publishing pipeline | PARTIAL | `content-scheduling` → `publishing` → optional `publish-status-poll`; immutable `PublishAttempt` rows; retry/backoff; permanent-vs-retryable classification; org-scoped **[code][test]**. **Never exercised against a real platform with real credentials.** Scheduling relies solely on a BullMQ *delayed job*; see §3.3. |
| 11 | TikTok | PARTIAL | OAuth+PKCE, Upload/Inbox publish, status poll, analytics provider, token refresh **[test]**. Not live-verified; needs `video.upload` approval; delivery lands in user's inbox, not public. |
| 12 | Instagram | PARTIAL | Facebook-Login OAuth + Graph container/publish + basic analytics **[test]**; no credentials; `instagram_content_publish` needs Meta App Review. |
| 13 | YouTube | PARTIAL | Google OAuth + resumable upload + analytics **[test]**; no credentials; `youtube.upload` is a restricted scope needing verification. Not in the user-visible "Connect" priorities. |
| 14 | AI integrations | PARTIAL | Worker `content-generation` calls an OpenAI-compatible chat endpoint; timeout, rate-limit, cost metadata **[code]**. Whether `AI_PROVIDER_API_KEY` holds a real key is **not verified** (the variable exists in the container env; its value was deliberately not inspected, and `.env` conventionally uses empty strings for "unconfigured"). No prompt library, no style-profile conditioning, no moderation, no approval step. |
| 15 | Media storage | PARTIAL | Local disk (shared Docker volume) or Cloudflare R2 abstraction. R2 not configured. Local storage served unauthenticated at `/media` (obscure keys). Not usable behind a multi-instance deployment. |
| 16 | API auth & permissions | WORKING | Every `/api` route behind `requireAuth`; mutating routes need EDITOR/ADMIN; org isolation in repositories; per-IP and per-endpoint rate limits **[code][test]**. **Gaps:** no CREATOR role/portal scoping, no per-page/per-group permissions, no approval-role. |
| 17 | Deployment & infra | PARTIAL / BROKEN | Local Docker + quick tunnel works for demo (stale generation). Production: none. Compose/CI/Dockerfiles target Postgres. cPanel ZIP path exists but is untested and cannot host the worker. |
| 18 | Existing tests | WORKING | 29 test files, 262 tests pass today (auth 37, api 165, worker 51, web 2, video-engine 7). **No integration tests against a real DB, no HTTP E2E, no MySQL run, no browser tests.** |

Code size (non-test, non-dist): api 77 files / 5.4k lines · worker 27 / 2.5k · web 22 / 3.9k ·
auth 281 · config 260 · types 243 · video-engine 368.

---

## 3. Worker investigation

### 3.1 Root cause of the crash loop **[live]**

Container `socialith-prod-worker-1` exits at import time with:
`NEXT_PUBLIC_APP_URL must not point to localhost in production`
(thrown from `@socialith/config` `loadEnv()` via `publishing/enqueue.js`).

- The worker gets `NEXT_PUBLIC_APP_URL=http://localhost:3000` from `.env` (via `env_file`).
- `NODE_ENV=production` is forced in compose, so the safety check rejects it — correct behavior.
- `docker-compose.tunnel.yml` overrides `NEXT_PUBLIC_APP_URL`/`API_PUBLIC_URL` **only for `api`**,
  not for `worker`. The api container shows the tunnel URL; the worker does not.
- **Not** the cause: Redis (healthy, reachable by service name), Postgres, Docker network,
  the tunnel itself, or missing secrets. It is a config-only defect.

### 3.2 Latent second defect (would appear right after the first is fixed)

The worker has no `API_PUBLIC_URL`, so `resolveApiPublicUrl()` falls back to
`http://localhost:4000`. Any asset URL the worker builds for rendered media would point at
localhost, which no platform (TikTok `PULL_FROM_URL`, Instagram, Upload-Post) can fetch.

### 3.3 Latent third defect — scheduling has no reconciliation **[live]**

The seeded content "Our new single is out now…" is `SCHEDULED` for 2026-09-23 with 5
`SCHEDULED` targets — **58 days overdue today** — and Redis contains **no
`content-scheduling` delayed job** (only repeatable scan keys). The seed wrote DB rows
directly; nothing enqueued the job, and nothing sweeps overdue `SCHEDULED` rows. The same
orphaning happens whenever Redis state is lost. Scheduled posts therefore silently never fire.
(When the worker is eventually restored these 5 rows will *not* be processed by themselves;
they must be handled deliberately, not by accident.)

### 3.4 Other observations

- API container carries a Windows `FFMPEG_PATH` leaked from `.env` (harmless: API never calls ffmpeg;
  worker overrides to `ffmpeg`).
- Health checks: API `/health` healthy; worker health endpoint exists on 4100 but the container
  never reaches readiness.
- `restart: unless-stopped` turns the config defect into an endless noisy restart loop.

---

## 4. Environment & secret hygiene (names only)

- `.env` (gitignored by pattern, but there is no git) holds real values for TikTok client
  key/secret, Meta ids, R2, AI provider, session/JWT/token-encryption secrets.
  The TikTok client secret was pasted into chat earlier in the project; the owner asked for
  rotation. **Rotation is not done** (no new secret was ever provided) — still open.
- `TOKEN_ENCRYPTION_KEY` encrypts OAuth tokens (AES-256-GCM); losing or rotating it without a
  re-encrypt migration makes every stored credential unreadable.
- `.env.example` is incomplete relative to `@socialith/config`'s schema (several AI/rate-limit/R2 vars undocumented).

---

## 5. Summary

Socialith today is a **solid, tested single-organization operations core** (auth, RBAC, accounts,
campaigns, content, sounds, queue-based publishing/analytics scaffolding) with **no real-world
validation**: nothing has published a post, no real OAuth round-trip completed, no production
host, no email delivery, no version control. The product vision (artists, media packs, page
network, studio, creators, calendar, Upload-Post) is **almost entirely unbuilt**, but the existing
Campaign/Content/ContentVariation/ContentAsset/ContentTarget/PublishAttempt/Sound models and the
queue pipeline are the right foundations to extend (see IMPLEMENTATION_ROADMAP).
