# Phase 2 (Upload-Post) — checkpoint

Branch `phase2-uploadpost` (base `main` @ `f061229` = the merged Phase 1). **Not merged into `main`.** Updated after every significant milestone so a session can always resume from here.

## 1. Where the work stands — milestone 5: all planned units implemented and validated

| # | Unit | Status |
|---|---|---|
| 1 | Provider client package `@socialith/upload-post` (client, errors, normalization, webhook verification, contract double) | done, 39 tests |
| 2 | Data model + configuration (additive migrations) | done |
| 3 | Worker: read-only profile/account synchronization (stable identity, never destructive) | done, 14 real-MySQL tests |
| 4 | Worker: status sync, immediate video/photo publishing, `external_id` correlation, duplicate protection, error classification, retries | done, 23 tests |
| 5 | Worker: hybrid scheduling (hand-off, drift, status sweep, one-owner guards) + BullMQ queue/repeatables | done, 21 tests |
| 6 | API: overview, health, plan, sync, profiles, accounts, mappings, destinations, publications, scheduled, ManagedPage/Creator, TikTok music | done |
| 7 | Webhook endpoint (raw-body HMAC, tolerance, rotation, dedupe, enqueue reconcile) | done |
| 8 | ManagedPage / Creator mapping | done |
| 9 | Dashboard — 8 pages | done; checked in a browser against the real API + MySQL + the contract double |
| 10 | Documentation (`UPLOAD_POST_INTEGRATION/API_MAPPING/SETUP/TESTING.md`), read-only live-check script | done |

### Milestone 6 (2026-11-20) — live connection confirmed, trial-plan hardening

The owner's key works: **read-only live checks passed** (plan `Default`, profile limit 2, 1 profile, 0 connected accounts; TikTok not available). Done since: sanitized live shapes pinned as tests; undocumented profile `blocked` flag stored (additive migration `20261120100000_upload_post_profile_blocked`), shown, and enforced (destination refused, publish fails before any provider call); **platform availability** endpoint (`GET /api/upload-post/capabilities`) + dashboard card on Overview and Plan & usage (TikTok UNAVAILABLE until the provider returns a TikTok account, with reasons and free profile slots); guidance banners for empty / account-less profiles; plan name display normalised; tests for empty profiles and profiles without accounts (worker, API, unit); opt-in **read-only live sync test** (`pnpm --filter @socialith/worker test:live-readonly`, not in CI). No plan was purchased or changed; nothing was published.

**Not done / out of scope by design:** any live call (no API key on this machine), any real publication, profile creation (client method exists, not exposed), analytics sync, Page Network, AI Studio.

## 2. Git state

Commits after `f061229` (oldest first): `e0106f0` client package · `24fd62e` schema/migration/config · `a707d38` `notes` migration · `b35ea3f` worker sync/status/publish modules ·
`b3469fa` worker wiring, sweep, ownership guards · `ee163db` API + webhook · `c455e0f` dashboard · `6b6cbe3` docs + live-check script · *(this checkpoint update)*.
Uncommitted work: none expected (verify with `git status`). Migrations (all additive, none rewritten): `20260922000000_init_mysql`, `20261119120000_upload_post_provider`, `20261119130000_upload_post_publication_notes`.

## 3. Key design decisions (details: `UPLOAD_POST_INTEGRATION.md` §A)

Five concepts kept apart (Profile / Connected Account / ManagedPage / Creator / Publishing Destination) · sync never deletes and never touches mappings · an account identity change clears the destination link, flags it and keeps history ·
one publication row per target + `external_id`/`request_id`/`Idempotency-Key` per generation + ask-before-resend · hybrid scheduling off by default with strict one-owner guards · TikTok music only when verified + rights-confirmed + capable, otherwise published without music with a recorded reason · API key server-side only.

## 4. Known issues and unverified assumptions

- **Nothing has touched the live Upload-Post service.** First live checks must be read-only: `node scripts/upload-post-live-check.mjs` after the owner puts `UPLOAD_POST_API_KEY` in the local env file (never in chat, never committed).
- Unverified until live (full list: `UPLOAD_POST_API_MAPPING.md` §6): `/users` pagination; the `upload_completed` payload shape (parsed tolerantly, used only as a hint); `status` by `request_id` for scheduled jobs; when the provider fetches media for scheduled jobs; platform-specific fields beyond the title/music mapping; `reauth_required` latency.
- `prisma format` reflowed whitespace in untouched parts of `schema.prisma` (cosmetic).
- Windows-only: `next build` for the web app needs symlink permission (fine on Linux/CI/Docker).
- Hand-off is safe to leave off; turning it on needs the checklist in `UPLOAD_POST_SETUP.md` §8 and approval for a real test post.
- Technical debt added (see `TECHNICAL_DEBT.md`): TD-42 full-list sync per run, TD-43 no profile-creation UI, TD-44 provider-side history is not imported.

## 5. Tests executed (final run of this milestone)

| Check | Result |
|---|---|
| Lint / typecheck (10 workspaces) | 0 errors / clean |
| Unit (all) — after milestone 6 | upload-post 45 · config 21 · worker 75 · api 237 (+1 POSIX-only skip) · auth 37 · video-engine 7 · web 2 |
| MySQL **8.4.13** + Redis integration — after milestone 6 | api **80/80**, worker **82/82** (MySQL 8.0 and the clean-Linux CI replay below were last run at milestone 5 and must be re-run before merge) |
| MySQL 8.0.46 (compatibility) — milestone 5 | api 74/74, worker 76/76 |
| Schema drift (`migrate diff --exit-code`), all 4 migrations | none (re-checked at milestone 6) |
| **LIVE read-only** (2026-11-20): `/me`, `/users`, sync into a throwaway org | pass — see `UPLOAD_POST_TESTING.md` §4 |
| **CI `verify` replayed on a clean Linux checkout of HEAD** (no `dist/`): install, lint, typecheck, unit, migrate, drift, api + worker integration, `pnpm build` | all pass (build 10/10) |
| **CI `images` replayed:** compose config, shell syntax, api/worker/web image builds, new package loads inside the api and worker images, bootstrap CLI present | all pass |
| Repo hygiene incl. history | OK |
| Browser check (real API + MySQL + contract double) | login, 8 pages, enabling a destination: works, no console errors |
| **GitHub Actions on the pushed branch** | **not yet seen** — the owner confirms; CI is never declared green from here |

## 6. Next exact task

1. Owner reviews the branch and the report; decides whether to merge `phase2-uploadpost`. (No merge from this session.)
2. Owner configures `UPLOAD_POST_API_KEY` locally and runs `node scripts/upload-post-live-check.mjs`; record the result in `UPLOAD_POST_TESTING.md` §4 and reconcile any shape that differs (`normalize.ts` + a redacted fixture test) **before** trusting the contract.
3. Only then, with explicit approval and a dedicated test account: the real-publication checklist in `UPLOAD_POST_TESTING.md` §5.
4. Next product phase (Publishing Center) starts only after approval.

## 7. Resume checklist

```powershell
git status; git log --oneline -10; git branch --show-current            # expect phase2-uploadpost
docker compose -f docker-compose.mysql-test.yml up -d --wait mysql84 redis
$env:MYSQL_INTEGRATION_URL="mysql://socialith:it-app-throwaway@127.0.0.1:3384/socialith_it"; $env:REDIS_INTEGRATION_URL="redis://127.0.0.1:6390"
npx --yes pnpm@9.0.0 test:integration                                    # expect api 74 + worker 76 passed
```
