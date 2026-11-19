# Socialith — Implementation Roadmap

Principle: **extend and repair; never recreate.** Every phase is additive (new tables/
columns/routes), keeps all 262 existing tests green, and ends in something verifiable on a
real system. **Nothing here starts until the owner approves** (PROJECT_AUDIT, PRD, this file).

## Recommended development order

| Phase | Goal | Exit criterion (real-world, not unit-test only) |
|---|---|---|
| **0 Foundations** | Make the project safe to change | Git repo with baseline; one DB engine decided and migrations regenerated; compose/CI match; worker healthy; real email; secrets rotated |
| **1 Provider layer + Upload-Post core** | First-class provider | A real Upload-Post sandbox/test profile publishes one video via Socialith and the status returns to the dashboard |
| **2 Page Network** | ManagedPage / categories / groups / account authorization | Football page + 2 authorized accounts created; only they are selectable |
| **3 Publishing Center v1** | Approval → schedule → publish → sync, with reconciliation | 20 targets scheduled across 3 platforms all reach a terminal state, no duplicates after a worker kill |
| **4 Artist/Music + Campaign + Media Packs** | Catalog and assets | 500 MB pack asset uploaded direct-to-R2; campaign ties artist/release/track/pack |
| **5 Text Library + Format Engine + AI Studio + Recipes** | Original per-page variations | Recipe run yields N distinct approved-queue drafts |
| **6 Creators & Portal** | External creators | Creator signs in, sees only own work, submits content |
| **7 Analytics Center** | Aggregation | Campaign/page/artist trends from cached provider analytics |
| **8 Native providers & approvals (parallel track)** | Optional alternatives | TikTok `video.upload`/Meta review decisions executed or dropped |

Phases 0→3 are the critical path to "Socialith publishes a real post". 4–7 can partially overlap
after 3 (4 and 5 are mostly independent of each other).

---

## Per-feature plan

### F0.1 Version control & baseline
- **Existing:** none. **Change:** `git init`, commit tree, tag gen-1/gen-2, `.gitignore` already covers env/dist.
- **Missing:** remote, branch policy. **Deps:** none. **Risks:** accidentally committing `.env`/`.env.tunnel` (verify ignore first).
- **Tests:** `git status` shows no secrets; CI later. **Order:** very first.

### F0.2 Database engine decision & migration regeneration
- **Existing:** PG migrations in images; one MySQL baseline in repo (unapplied). **Change:** per owner decision — recommended PostgreSQL: revert provider, regenerate a single baseline from the current schema, restore `mode:"insensitive"` in 6 filters, regenerate compose/CI. **Missing:** DB integration tests.
- **Deps:** F0.1, owner decision. **Risks:** silent search-semantics change; baseline drift vs. images (irrelevant — seed-only data). 
- **Tests:** apply baseline to empty DB in CI; repository tests against real DB (add); search-case tests. **Order:** after F0.1.

### F0.3 Restore the worker (config-only)
- **Existing:** worker code complete; container crash-loops. **Change:** worker env overrides (`NEXT_PUBLIC_APP_URL`, `API_PUBLIC_URL`); boot assertion that rejects localhost URLs in production with a clear structured log.
- **Missing:** worker readiness probe in compose. **Deps:** none (works on gen-1 image). **Risks:** starting consumers with stale seed rows (see DEPLOYMENT_PLAN §4). **Tests:** `/health` 200, all 10 workers ready, smoke job processed. **Order:** may run in parallel with F0.1–F0.2.

### F0.4 Scheduling reconciliation sweeper (fixes TD-05)
- **Existing:** delayed BullMQ job only. **Change:** repeatable sweeper that re-enqueues/flags due `SCHEDULED` targets lacking a live job. **Deps:** F0.3. **Risks:** double-enqueue (mitigated by deterministic job ids already used). **Tests:** unit + "delete Redis state, restart, overdue target still publishes". **Order:** before Phase 3.

### F0.5 Real email delivery
- **Existing:** `EmailService` interface + `console` impl. **Change:** add provider (Resend/SES/SMTP) behind the interface, config enum extended. **Deps:** domain/DNS (SPF/DKIM) — owner. **Risks:** deliverability. **Tests:** provider unit tests with fake transport; manual invite + reset E2E. **Order:** Phase 0 (needed for Phase 6).

### F0.6 Secrets & storage
- Rotate TikTok secret; configure R2; generate complete `.env.example` from the zod schema (TD-19). **Tests:** boot with only `.env.example` placeholders fails with clear messages.

### F1 Provider abstraction (no behavior change)
- **Existing:** `PublishingProvider` keyed by platform, token-based input, `PublishError` taxonomy, `pendingConfirmation` async pattern, `resolveAssetUrl`.
- **Change:** registry keyed by `(provider, platform)`; credential resolution moves inside providers; `ContentTarget` gains additive `provider` (default `NATIVE`), `providerAccountId`, `providerRequestId`, `providerJobId`, `externalCorrelationId`.
- **Missing:** provider column on accounts; new target states (`PROVIDER_PROCESSING`, `PROVIDER_SCHEDULED`). **Deps:** F0.2.
- **Risks:** regressions in native publish path → keep all native provider tests; add contract tests every provider must pass. **Order:** first of Phase 1.

### F1.1 Upload-Post provider & credential vault
- Design in UPLOAD_POST_INTEGRATION.md. **Existing reusable:** AES vault, error taxonomy, attempt table. **Missing:** everything provider-specific. **Deps:** F1, Upload-Post key, discovery step 0. **Risks:** [UNVERIFIED] API details → fixtures from real calls first; vendor dependence. **Tests:** HTTP-mocked contract tests from recorded fixtures; one live smoke test gated by env key.

### F1.2 Profile sync + provider settings UI
- **Missing:** `ProviderProfile/ProviderAccount`, sync job, settings page with capacity meter. **Deps:** F1.1. **Risks:** capacity unknown from API → admin-entered value. **Tests:** sync idempotency/drift, capacity warnings at 80/100 %.

### F2 Page Network (ManagedPage, Category, Group, authorization)
- **Existing:** `SocialAccount` (platform account) — left untouched. **Change:** additive `ManagedPage(type THEMATIC|CREATOR)`, `PageCategory` (seeded Motivation/Football/Humor-Memes/Relationships + custom), `PageGroup`, `PageGroupMember`, `PageAccountAuthorization`, style profile + content requirements (JSON with schema validation).
- **Missing:** UI (pages list/detail, groups), RBAC scoping. **Deps:** F0.2, F1.2. **Risks:** conflating pages and creators → enforced type + tests; JSON style-profile drift → versioned schema. **Tests:** org isolation, authorization checks block unauthorized publishing, group assignment cascade.

### F3 Publishing Center v1 (approval, calendar, scheduling, sync)
- **Existing:** content list/detail, schedule, publish-now, retry, publish attempts. **Change:** approval states and Approver role; publishing calendar view; hand-off dispatcher (UPLOAD_POST §6); webhook endpoint + reconcile; failure inbox; per-page/day caps and variation-distance guard (PRD guardrails).
- **Missing:** `Approval` model, webhook tables, calendar UI. **Deps:** F0.4, F1.1, F2. **Risks:** double scheduling, webhook spoofing/replay, timezone errors → compare-and-set transitions, HMAC verify, UTC+IANA storage. **Tests:** kill-worker-mid-submit chaos test, webhook replay/dup tests, timezone boundary tests, E2E happy path with sandbox profile.

### F4.1 Artist & Music Catalog
- **Existing:** `Sound` (string artist). **Change:** additive `Artist`, `Release`, `Track`; `Sound` becomes per-platform sound reference linked to `Track` (backfill none needed — 0 rows). **Deps:** F0.2. **Risks:** naming clash with `Sound` → keep route compatibility. **Tests:** CRUD, org scope, link integrity.

### F4.2 Campaign Manager extension
- **Existing:** lightweight `Campaign`. **Change:** link artist/release/track, goals, brief, deliverables, target groups, roll-up views. **Deps:** F4.1, F2. **Tests:** roll-up queries, status workflow.

### F4.3 Media Pack Manager
- **Existing:** `ContentAsset`, multer memory upload (200 MB), R2 abstraction (unconfigured). **Change:** `MediaPack`/`MediaPackItem` (versioned, rights/expiry), direct-to-R2 presigned/resumable upload, ffprobe validation, thumbnails via existing op. **Deps:** F0.6. **Risks:** large uploads, rights enforcement. **Tests:** upload >200 MB without API memory growth, rights-expired blocked at publish.

### F5.1 Text Library
- **Missing:** `TextLibrary/TextItem` with tags/lang/cool-down/usage counters; search (PG full-text if PostgreSQL). **Deps:** F2 (group assignment). **Tests:** cool-down enforcement, search relevance.

### F5.2 Content Format Engine
- **Existing:** FFmpeg thumbnail op; unused TikTok/Reels/Shorts export presets; `VIDEO_OPERATIONS` registry. **Change:** add operations (aspect conversion via presets, trim, text overlay, simple compositions) as registry entries; `ContentFormat` definitions; previews. **Deps:** F4.3, worker (F0.3). **Risks:** FFmpeg CPU/disk, font licensing. **Tests:** golden-file frame checks, preset conformance, timeout/cleanup.

### F5.3 AI Content Studio
- **Existing:** `content-generation` job + provider adapter. **Change:** prompt templates with artist/track/page style context, N candidates, moderation filter, provenance, `is_ai_generated` flag, approval hand-off. **Deps:** F2, F5.1, valid AI key. **Risks:** brand safety, cost → budget caps already partly present. **Tests:** prompt assembly, moderation rejection, cost accounting.

### F5.4 Content Recipe Builder
- **Missing:** `ContentRecipe` (versioned) + runner producing drafts only. **Deps:** F5.1–F5.3, F2. **Risks:** accidental auto-publish → runner has no publish permission. **Tests:** reproducibility from recipe version, no-publish invariant.

### F6 Creator management & portal
- **Existing:** Invitation flow, roles, sessions. **Change:** `Creator` entity, `CREATOR` role + scoped authorization, portal routes (briefs, packs, submissions), connection/consent management. **Deps:** F0.5 (email), F2, F3. **Risks:** data leakage across creators → scope tests on every query. **Tests:** isolation matrix, invitation E2E.

### F7 Analytics Center
- **Existing:** `PostMetricsSnapshot`, analytics-sync queues, dashboard tiles. **Change:** cached-analytics sync from Upload-Post, per-page snapshots, aggregation endpoints, UI. **Deps:** F1.1, F3. **Risks:** provider rate limits (use cached endpoint). **Tests:** aggregation correctness, null-vs-zero, freshness labels.

### F8 Native providers (parallel, optional)
- Complete TikTok/Meta/Google approvals only if Upload-Post cannot cover a needed capability. Existing code retained dormant behind the provider registry. **Tests:** existing native suites remain green.

---

## Cross-phase quality gates
Every phase: typecheck clean, all prior tests green, new tests for each new route/service/repository (org-isolation test mandatory), migration applied to a clean DB in CI, audit-log coverage for state changes, no secrets in logs, documentation updated here and in INTEGRATION_STATUS.
