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
- **Not verified live (needs the key):** every provider response shape; pagination of `/users`; the `upload_completed` payload; `status` for scheduled jobs by `request_id`; media fetch timing for scheduled jobs; the platform-specific publish behaviour; actual plan limits.

## 4. Read-only live verification (owner)

```powershell
node scripts/upload-post-live-check.mjs      # key from the environment or the git-ignored .env; exactly two GETs; prints a redacted summary
```

Record here after running (date, plan reported, profile limit reported, profile count, accounts per platform, any shape that differed from the mapping document):

| Date | Result | Notes |
|---|---|---|
| — | not run yet (no key on the development machine) | — |

If a shape differs from `UPLOAD_POST_API_MAPPING.md`, fix `normalize.ts` and add the real (redacted) shape as a test fixture **before** relying on it.

## 5. Real publication tests (explicit approval required — not part of Phase 2)

Prerequisites, all of them: a dedicated Upload-Post test profile with a throwaway social account you own; the owner's explicit go-ahead naming that account; a harmless private/draft-style post where the platform allows it (TikTok `fallback_to_inbox` drafts, YouTube `private`).
Checklist: (1) publish one video through a destination → expect `PROCESSING` then `COMPLETED`, with `external_id` visible in Upload-Post history; (2) redeliver the job → still one provider job; (3) with hand-off on: schedule 20 min ahead → job appears with the right `external_id`; reschedule → job edited; unschedule → job cancelled; let one run → exactly one post; (4) webhook arrives and is accepted; (5) revoke the account's authorization → destination turns `REAUTH REQUIRED` after the next sync and a publish fails with the reconnect message; (6) TikTok music: only with a mapping that is verified and rights-confirmed.
Record outcomes here, with dates; do not mark anything "verified" that was not actually observed.
