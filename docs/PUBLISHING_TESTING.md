# Publishing Center — testing

Three tiers, kept apart so one is never mistaken for another:

1. **Automated tests with a mocked provider** — every push, CI. They prove *our* logic against the documented Upload-Post contract (the in-repo contract double). No provider, no social platform is ever contacted.
2. **Read-only live verification** (Phase 2, owner's key): two GETs, plus a live sync into a throwaway database. Nothing in Phase 3 changed that.
3. **Real publication tests** — need a designated test account **and a separate, explicit owner approval**. None was performed in Phase 3. Checklist in §6.

## 1. Counts (last full run)

| Suite | Tests | Needs |
|---|---|---|
| `@socialith/publishing` (pure rules, incl. approver policy and media verification) | **87** | nothing |
| `@socialith/config` (incl. the hand-off owner-approval guard) | 22 | nothing |
| `@socialith/web` (date/time + error helpers) | 8 | nothing |
| API unit | 237 (+1 POSIX-only skip) | nothing |
| Worker unit | 75 | nothing |
| API integration — `publishing-center.integration.test.ts` | **51** | MySQL + Redis |
| Worker integration — `publishing-center.integration.test.ts` | **15** | MySQL + Redis |
| Worker integration — additions to `upload-post-publish` (gate, own text, required track, invalid responses) / `upload-post-sweep` (per-target hand-off, drift, cancel, gate, mandatory track) | 11 / 5 | MySQL |
| Whole monorepo, integration (MySQL 8.4.13 + Redis) | api **131**, worker **112** | |

Phase 1 / Phase 2 suites (scheduling reconciler, sweep, publish, sync, API) keep **every assertion**. Two fixture changes only, both explained in the files: a helper that moves a content's *and* its targets' times (a real reschedule does both since Phase 3), and — because approval is now required by default — the organizations in tests about scheduling *mechanics* explicitly save the opt-out; the defaults themselves have their own tests (below).

## 2. The requested test areas → where they are proven

| Requested | Proof |
|---|---|
| Scheduling | API: full lifecycle (job at the right delay, one job per content), time validity (past / too soon / too far), organization-timezone day cap and spacing; worker: only due targets fire, the job moves to the next target |
| Rescheduling | API: reschedule moves the *same* job; from HELD/STALE; legacy `/content/:id/schedule` moves already-scheduled targets; worker sweep: rescheduling ONE target edits only its provider job |
| Cancellation | API: cancel/hold/unschedule re-arm or remove the job; sweep: cancelling ONE target cancels only its provider job, siblings untouched |
| Approval transitions | API: every allowed transition, every illegal one (409, nothing changes), nothing possible in flight/published, withdraw rules, self-approval switch, rejection needs a reason; `state.test.ts` enumerates all stored combinations; the list-by-state ≡ derived-state equivalence test |
| Approval pinned to content | API: edit after approval withdraws it; content edited behind its back refuses scheduling *and* un-schedules a scheduled item; worker: scheduler holds, publisher refuses, hand-off skips |
| Duplicate prevention | Phase 2 job-id / external-id / idempotency protection (unchanged, passing); new: one publication per destination per content, 40-combination state test, **repetitive-text guard** (block / warn / off, other platforms and cancelled siblings do not count), unreadable provider answers never double-send |
| Provider handoff | sweep: by each target's own time, never unapproved, never with an unattachable mandatory track, ownership guards (processor, reconciler) |
| Provider schedule cancellation | sweep (above); API: cancel/reschedule queue an immediate sweep, and are refused while the provider is about to run the job |
| Redis data loss recovery | worker: an empty Redis → the job is re-created at the *earliest remaining* target's time, exactly once; an earlier stale target is held and the job re-created for the later one, nothing published; provider-owned content gets no Socialith job |
| Webhook signature validation | Phase 2 (`webhook.test.ts`, API integration: wrong secret, tampered body, stale timestamp, missing/garbled headers, rotation, raw-bytes) — unchanged and passing |
| Invalid provider responses | worker: HTTP 200 with an HTML page / empty body / JSON without an id → `UNKNOWN_OUTCOME`, not published, retry asks first and re-sends with the same Idempotency-Key; "provider did create it" → adopted, no second POST; unreadable status answer never marks anything published |
| Timeout behaviour | Phase 2: timeout → unknown outcome → the provider is asked before any resend (passing) |
| Status reconciliation | Phase 2 poll/sweep/webhook paths (passing) + new: held/cancelled targets do not keep a content open (reconciler roll-up, `finalize`) |
| Platform validation | 26 unit tests (every rule, per platform, boundaries, multiple problems at once) + API: structured 422 list, account/provider problems, music (warning vs required), limits |
| **Approval required by default** | API: a brand-new organization (no row saved, nothing saved by the test) cannot schedule from draft — through the Publishing Center **or** the older content API; overview/settings report the default; worker: an organization with no row is gated exactly like one that requires approval (held, nothing reaches a provider), and goes out once approved; an explicitly saved opt-out is honoured and a later unrelated settings change never re-enables or disables it |
| **Role-based self-approval + audit** | unit (`policy.test.ts`, 9): every role × self/other × both switches, CREATOR never, unknown submitter; API: OWNER self-approves and a `PUBLICATION_SELF_APPROVED` audit row + `selfApproval` event metadata exist; ADMIN refused by default (403, `PUBLICATION_APPROVAL_DENIED` audited, state unchanged) and a different approver's approval is not a self-approval; both switches are configurable and each approval is attributed; EDITOR refused |
| **Automatic publishing only after approval** | API: with auto-schedule on, submitting schedules nothing and no job exists until the approval; the approval schedules at the planned time; worker: unapproved/changed targets are held, never fired |
| **Media validation never pretends** | unit (7): VERIFIED / PARTIAL / UNVERIFIED / NONE, unknown facts named, `fullyValidated` false while anything is unknown, a known violation still an error, account checks still active; API: unknown metadata → `fullyValidated: false` with the unknown facts, known metadata → VERIFIED, the detail page returns null facts as "unknown", a disconnected account still blocks |
| **Hand-off needs the owner switch** | config: `…_HANDOFF_ENABLED=true` alone refuses to boot (variable named, reason given); the confirmation alone enables nothing; both together are accepted; empty strings are the safe default |
| Multi-account destination isolation | API: one content → three destinations with independent states and approvals; org B cannot read, act on, or use org A's publications and destinations (404); worker: the gate is per destination |

## 3. Bugs the tests found (and the fixes)

| Found by | Defect | Fix |
|---|---|---|
| API integration | `NOT (exception = 'X')` is NULL for rows with no exception → the repetition guard saw no siblings and the calendar would have hidden uncancelled rows | explicit `OR [exception null, exception not X]` everywhere a negation touches a nullable column |
| Browser verification | a publication whose approval was withdrawn at reschedule time stayed "Scheduled" | it returns to the plan state with its approval; job removed; provider swept |
| Test-plan review ("invalid provider responses") | HTTP 200 with an unreadable body left the publication row `PENDING` with no record that the outcome was unknown | marked `UNKNOWN_OUTCOME / INVALID_RESPONSE`; retry asks the provider first (it already did — no double-publish risk existed) |
| API integration | the blanket API rate limit (300/min/IP) throttled a 45-test suite | each describe block starts its own app (own counter); the production limit was **not** loosened |

## 4. What is NOT verified

- **Nothing was published to any real account.** Every provider response is the contract double's reading of the documentation; a green suite proves our handling of the documented contract, not live behaviour.
- **Platform thresholds** for video duration, file size and aspect ratio are assumptions (see `PUBLISHING_WORKFLOW.md` §7); caption/title/hashtag limits come from the Phase 2 mapping of the provider documentation. No Instagram, YouTube or TikTok publication has been observed live.
- **Media facts**: dimensions and duration are not extracted from uploads (only `sizeBytes` is recorded). The system says so — media is shown as UNVERIFIED / PARTIAL and a publication is never reported fully validated — until Media Pack processing records them (TD-49).
- **The CREATOR role does not exist yet** (Phase 8): "a creator can never approve" is enforced and unit-tested in the policy function, but there is no creator user to test through the API.
- **Hand-off against the live provider** (job edit/cancel semantics, media fetch timing for scheduled jobs) is still unverified live (`UPLOAD_POST_API_MAPPING.md` §6).
- The browser check was done once, by hand, against the real API + MySQL + Redis with seeded data; there is no automated browser test.

## 5. Run it

```powershell
docker compose -f docker-compose.mysql-test.yml up -d --wait mysql84 redis
$env:MYSQL_INTEGRATION_URL = "mysql://socialith:it-app-throwaway@127.0.0.1:3384/socialith_it"
$env:REDIS_INTEGRATION_URL = "redis://127.0.0.1:6390"
npx --yes pnpm@9.0.0 test                      # all unit tests (no infrastructure)
npx --yes pnpm@9.0.0 test:integration          # api, then worker (MySQL + Redis)
docker compose -f docker-compose.mysql-test.yml down -v
```

## 6. First real publication (needs explicit owner approval)

Prerequisites, all of them: a dedicated Upload-Post test profile with a **throwaway** social account you own (Instagram or YouTube first; TikTok only when the provider reports it); the owner's explicit go-ahead naming that account; approval switched on; a harmless private/draft-style post where the platform allows it (YouTube `private`).
Checklist: (1) create → submit → approve → schedule 20 minutes ahead → the post appears in Upload-Post only if hand-off is on, otherwise at the time in Socialith's queue; (2) the result arrives (webhook or poll) and `Published URL` is filled; (3) reschedule once and cancel once and confirm in the Upload-Post dashboard; (4) with hand-off on: the provider job id is stored and edited/cancelled; (5) kill the worker for longer than the stale window and confirm the post is `Stale`, not published late. Record outcomes with dates; do not mark anything verified that was not observed.
