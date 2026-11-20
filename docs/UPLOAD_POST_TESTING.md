# Upload-Post — testing

Three tiers, kept strictly separate so that nobody mistakes one for another:

1. **Automated tests against the contract double** — run on every push (CI). Prove *our* logic against the documented API contract.
2. **Read-only live verification** — run by the owner, needs `UPLOAD_POST_API_KEY`. Proves the contract matches reality for two GET calls.
3. **Real publication tests** — need a dedicated test account **and separate explicit owner approval**. Never run automatically, never part of CI, not performed in Phase 2.

## 1. The contract double

`packages/upload-post/src/mock-server.ts`: a local HTTP server implementing the response shapes the official docs describe (me, users, TikTok settings/music, upload, upload_photos, status, history, schedule list/get/edit/cancel, idempotency keys, external_id echo). It can be told to answer 401/429/5xx, delay a request (not yet handled) or delay only the *response* (provider processed it, answer lost), and records requests without ever recording the Authorization value. Because it encodes our reading of the docs, **a green suite proves handling of the documented contract, not live behaviour** — see `UPLOAD_POST_API_MAPPING.md` §6 for what only LIVE can confirm.

## 2. Automated tests (what each proves)

| Suite | Where | Needs | Covers |
|---|---|---|---|
| Client unit/contract tests (39) | `packages/upload-post/src/*.test.ts` | nothing | API authentication; invalid credentials (`AUTH`, no retry, key never in message or logs); current user + plan; profile normalization (stable id vs handle, reauth flag, capabilities, pending platforms, both date formats, capacity from the response); timeouts (reads retried, writes not, `outcomeUnknown`); rate limit (`Retry-After` header/body, short waits retried, long waits surfaced, quota ≠ rate limit); 5xx retry; network error; `external_id`/`request_id`/`Idempotency-Key` correlation and duplicate-job protection; status/history by `external_id`; schedule/edit/cancel incl. 409 in-progress; TikTok settings/music + capability gating; **webhook signatures** (valid, tampered, wrong secret, re-serialized body, stale/future timestamp, missing/garbled headers, rotation, case, event parsing) |
| Config tests | `packages/config/src/index.test.ts` | nothing | optional key, defaults, https-only base URL in production, bounds, secrets never echoed |
| Worker sync (14) | `apps/worker/src/integration/upload-post-sync.integration.test.ts` | MySQL | profile synchronization; **no duplicate profiles/accounts** (repeat and 3 simultaneous syncs); mappings never touched; **identity unchanged / changed / missing / repeated / reconnected**; disappearance flagged not deleted, restored on return; reauth; failed or suspiciously empty answer changes nothing; concurrent run guard |
| Worker publishing (23) | `…/upload-post-publish.integration.test.ts` | MySQL | async video + photo publish, `external_id` correlation, poll → PUBLISHED; **duplicate protection** (redelivery; timeout then adopt; never-arrived resend with same key); provider failure; retry = new generation; error classification (key → configuration, reauth → account flagged, rate limit retryable with `Retry-After`, quota/5xx/validation); destination safety without any provider call; demo guard; **TikTok music** rules (6 negative cases + positive + capability); webhook-style reconcile; not-configured |
| Worker hybrid scheduling (21) | `…/upload-post-sweep.integration.test.ts` | MySQL | hand-off (idempotent; window/lead/native/disabled/non-durable/not-ready skipped; refusal degrades to Socialith); unknown outcome adopted or released; **one owner at a time** (scheduling job, reconciler, stale hold, mixed content); drift (reschedule edits, unschedule cancels, leaving the window releases, already-gone, 409 deferred); status sync, failure, unconfirmed after 6 h |
| API (35) | `apps/api/src/integration/upload-post.integration.test.ts` | MySQL + Redis | through the **real express app**: RBAC; org isolation (404 not 403); key/secret never in any response; health (cached probe, e-mail admin-only, rejected key as data); status derivation incl. `LIMIT REACHED`; plan/capacity from provider/sync; manual sync queued once; profiles/accounts search & filters; mappings + audit; destination enable/disable rules; publications/scheduled listing (no idempotency keys/raw payloads); music search/mapping lifecycle/rights; **webhook** (signed ok, dedupe, rotation, 6 rejection cases, unparsable 400, ignored event, account events → sync, raw-byte signature) |
| Trial plan / empty profiles (worker sync, +5) | `…/upload-post-sync.integration.test.ts` | MySQL | the **live trial shape** (plan default, limit 2, one profile, `tiktok: ""`) imports one profile and zero accounts and is idempotent; every flavour of "no account" (`""`, `null`, `{}`, missing key) creates no account and no pending platform; an account connected later appears once and, when removed, is flagged while the profile stays; an empty provider list with nothing known is a successful answer (plan and limit still recorded); `blocked` follows the provider both ways |
| Trial plan / platform availability (API, +6) | `…/upload-post.integration.test.ts` | MySQL + Redis | nothing synchronized → every platform UNAVAILABLE with a reason and no invented plan figures; the live trial state shows plan/limit/remaining from the provider and `CONNECTED` (1 of 2 is not "limit reached"); limit reached only at the provider's own limit; Instagram/YouTube available and enableable while TikTok stays UNAVAILABLE with no account row and no destination; blocked profile → unavailable + destination refused; organization isolation, no key in responses |
| Platform availability rules (API unit, 6) | `apps/api/src/services/upload-post-capabilities.test.ts` | nothing | the pure derivation: empty/never-synced, live trial state, IG+YT connected, TikTok music only with the `music` capability, reauth/pending/disconnected/removed/blocked never available, sync-only platforms |
| Live response shapes (package, 6) | `packages/upload-post/src/live-shape.test.ts` | nothing | sanitized live `/me` and `/users` fixtures, empty-account variants, `blocked` parsing |
| Blocked profile at publish (worker, +1) | `…/upload-post-publish.integration.test.ts` | MySQL | fails as CONFIGURATION_ERROR with zero provider calls |
| Error handler, bootstrap, validation | `apps/api/src/**` | nothing | malformed JSON → 400, etc. |

Counts at the last full run are in `PHASE2_CHECKPOINT.md`.

### Run locally

```powershell
docker compose -f docker-compose.mysql-test.yml up -d --wait mysql84 redis
$env:MYSQL_INTEGRATION_URL = "mysql://socialith:it-app-throwaway@127.0.0.1:3384/socialith_it"
$env:REDIS_INTEGRATION_URL = "redis://127.0.0.1:6390"
npx --yes pnpm@9.0.0 test                                                  # all unit tests
npx --yes pnpm@9.0.0 test:integration                                      # api (MySQL+Redis) then worker (MySQL+Redis)
docker compose -f docker-compose.mysql-test.yml down -v
```

The API integration config pins `UPLOAD_POST_BASE_URL=http://127.0.0.1:39870/api` (the double, fixed loopback port) and throwaway keys; nothing in any test can reach the live service.

## 3. Verified vs. not verified (summary)

- **Verified (against the double):** every behaviour in the table above.
- **Verified (real stack, manual):** the dashboard against the real API + MySQL + the double — login, all eight pages, enabling a destination — no console errors.
- **Verified LIVE (2026-11-20, read-only, trial account):** authentication; `GET /me` and `GET /users` shapes for an account with an empty profile; plan and profile limit reported dynamically; profile synchronization writing exactly what the provider returned (see §4).
- **Not verified live (needs a connected account and/or approval):** the shape of a *connected* account object; pagination of `/users`; capabilities and `reauth_required`; the `upload_completed` payload; `status` for scheduled jobs by `request_id`; media fetch timing for scheduled jobs; the platform-specific publish behaviour; plan limits other than the profile limit; whether the trial plan can connect Instagram/YouTube/TikTok at all (the API does not say — see `UPLOAD_POST_API_MAPPING.md` §7).

## 4. Read-only live verification (owner)

```powershell
node scripts/upload-post-live-check.mjs      # key from the environment or the git-ignored .env; exactly two GETs; prints a redacted summary
```

Record here after running (date, plan reported, profile limit reported, profile count, accounts per platform, any shape that differed from the mapping document):

| Date | Result | Notes |
|---|---|---|
| 2026-11-20 | **PASS** — `GET /uploadposts/me` → 200 (≈280 ms), `GET /uploadposts/users` → 200 (≈150 ms) | Owner's **trial account**: plan `Default` (`/me`) / `default` (`/users`, lower-case), **profile limit 2**, **1 profile**, **0 connected social accounts**, 0 needing reauthorization, 0 pending platforms. AI Shorts quota 0/10, no window running. TikTok **not** connected and not available. Read-only; nothing was created or published. |
| 2026-11-20 | **PASS** — read-only live synchronization (`pnpm --filter @socialith/worker test:live-readonly`, 1 test) | Real client + real sync code into a throwaway organization of a local MySQL 8.4: profiles written = provider's count (1), accounts written = provider's count (**0** — none invented), plan/limit recorded from the provider (`default` / 2), a second run changed nothing, no publishing destination was created. Sanitized report only (no usernames/handles/e-mail). |
| 2026-11-20 | **PASS** — dashboard against the real provider probe | Real API + local MySQL seeded with the live state; **Plan & usage** showed plan `Default`, limit 2, 1 used, 1 remaining (source: live); every platform UNAVAILABLE with a reason; no console errors. |

**Shape differences found by the live check (all handled, with sanitized fixtures in `packages/upload-post/src/live-shape.test.ts`):**

1. A platform with nothing connected appears as an **empty string** (`"social_accounts": {"tiktok": ""}`), not as an absent key or object. Already treated as "not connected" (not pending); now pinned by tests. Only the `tiktok` key was present on this account — the provider does **not** list every platform for an empty profile.
2. Every profile carries a **`blocked`** boolean (`false` here) that the documentation does not mention. It is now stored (`upload_post_profiles.blocked`, additive migration), shown as a BLOCKED chip, makes the profile's platforms UNAVAILABLE, refuses enabling a destination and fails a publish **before any provider call**. What `blocked: true` means at the provider is unknown — Socialith treats it conservatively.
3. `plan` is capitalised on `/me` (`Default`) and lower-case on `/users` (`default`); the dashboard normalises the display, the stored value is the provider's.
4. `/me` also returns `x_links{entitled,source,monthly_cap,used,remaining}` and `attribution` (ignored).
5. `/users` returned a single array with `limit` and `plan` at the top level, as documented. Pagination of `/users` is still **unverified** (one profile cannot show it).

Still **not** verified live: anything involving a connected account (capabilities, `reauth_required`, account objects), publishing, scheduling, webhooks, TikTok music. These need an account that is actually connected (Instagram or YouTube first) and, for publishing, your explicit approval (§5).

If a shape differs from `UPLOAD_POST_API_MAPPING.md`, fix `normalize.ts` and add the real (redacted) shape as a test fixture **before** relying on it.

### Re-running the live checks (read-only)

```powershell
node scripts/upload-post-live-check.mjs        # two GETs, redacted summary
```
The synchronization check needs a throwaway MySQL and your key in the **environment** (never typed into chat):
```powershell
docker compose -f docker-compose.mysql-test.yml up -d --wait mysql84
$env:MYSQL_INTEGRATION_URL = "mysql://socialith:it-app-throwaway@127.0.0.1:3384/socialith_it"
$env:UPLOAD_POST_LIVE_TEST = "1"      # explicit opt-in; the key is read from UPLOAD_POST_API_KEY
npx --yes pnpm@9.0.0 --filter @socialith/worker test:live-readonly
```
It is not part of CI or of any other test command (different file suffix and its own vitest config) and it can only call `getMe` and `listProfiles`.

## 5. Real publication tests (explicit approval required — not part of Phase 2)

Prerequisites, all of them: a dedicated Upload-Post test profile with a throwaway social account you own; the owner's explicit go-ahead naming that account; a harmless private/draft-style post where the platform allows it (TikTok `fallback_to_inbox` drafts, YouTube `private`).
Checklist: (1) publish one video through a destination → expect `PROCESSING` then `COMPLETED`, with `external_id` visible in Upload-Post history; (2) redeliver the job → still one provider job; (3) with hand-off on: schedule 20 min ahead → job appears with the right `external_id`; reschedule → job edited; unschedule → job cancelled; let one run → exactly one post; (4) webhook arrives and is accepted; (5) revoke the account's authorization → destination turns `REAUTH REQUIRED` after the next sync and a publish fails with the reconnect message; (6) TikTok music: only with a mapping that is verified and rights-confirmed.
Record outcomes here, with dates; do not mark anything "verified" that was not actually observed.
