# Publishing workflow — rules of the Publishing Center

The rules the system enforces, in one place. Code: `packages/publishing` (pure rules shared by API, worker and web), `apps/api/src/services/publishing-*.ts`, `apps/worker/src/{processors,scheduling,publishing,upload-post}`.

## 1. The unit: one publication = one content item for ONE destination

A publication is a `ContentTarget` (unique per content × destination). Every destination is independent: its own text, its own approval, its own time, its own status, its own provider job. There is **no bulk approval** endpoint and approving one destination never touches another.

## 2. Lifecycle (derived from stored columns)

Stored: `status` (PENDING · SCHEDULED · PUBLISHING · PUBLISHED · FAILED — unchanged since Phase 5), `approvalStatus` (DRAFT · READY_FOR_REVIEW · APPROVED · REJECTED), `exception` (HELD · CANCELLED · STALE · none), `attemptCount`, and whether an Upload-Post publication row exists. `derivePublicationState()` maps them to the twelve states an operator sees:

| State | Stored as | Meaning |
|---|---|---|
| `DRAFT` | PENDING + DRAFT | being prepared; may carry a *planned* time |
| `READY_FOR_REVIEW` | PENDING + READY_FOR_REVIEW | submitted, waiting for an admin |
| `APPROVED` | PENDING + APPROVED | approved, not scheduled yet |
| `REJECTED` | PENDING + REJECTED | an admin refused it, with a reason |
| `SCHEDULED` | SCHEDULED | has a time; either Socialith's queue or the Upload-Post scheduler holds the clock |
| `QUEUED` | PUBLISHING, 0 attempts, no provider row | its time came; a publishing job waits for the worker |
| `PUBLISHING` | PUBLISHING with an attempt or a provider row | a provider request exists; the result comes by webhook, polling is the fallback |
| `PUBLISHED` | PUBLISHED | done |
| `FAILED` | FAILED | the platform/provider refused it (or it timed out unconfirmed) |
| `STALE` | FAILED + STALE | it **missed its slot** by more than the stale window and was held, never published late |
| `HELD` | PENDING + HELD | parked by an operator, or by the approval gate (unapproved / changed after approval) |
| `CANCELLED` | PENDING + CANCELLED | cancelled by an operator; history is kept |

The twelve are exhaustive and reachable (a unit test enumerates every combination of the stored columns; an integration test checks that listing by a state returns exactly the publications that derive to it).

## 3. Who may do what

| Action | Role | Allowed in state |
|---|---|---|
| create / edit / submit / withdraw / schedule / reschedule / unschedule / hold / release / cancel / reopen / retry | EDITOR+ | see below |
| approve / reject | **OWNER or ADMIN** (reject needs a reason; self-approval rules in §4) — never EDITOR, VIEWER or CREATOR | READY_FOR_REVIEW |
| change Publishing Settings, campaign auto-schedule | ADMIN+ | — |
| read everything | any role | — |

Allowed actions per state (same table in the API and the dashboard — the UI shows only what the server allows):
DRAFT: edit, submit, cancel (+ schedule when approval is not required) · READY_FOR_REVIEW: approve, reject, withdraw, edit, cancel · APPROVED: schedule, edit, cancel · REJECTED: edit, submit, cancel · SCHEDULED: reschedule, unschedule, hold, cancel · HELD: release, reschedule, cancel · FAILED: retry, cancel · STALE: retry (= publish now), reschedule, cancel · CANCELLED: reopen · QUEUED / PUBLISHING / PUBLISHED: nothing.
Every transition is a **compare-and-set** against the state it was decided on; a concurrent change yields a 409 instead of an overwrite.

## 4. Approval

- **Default: approval is REQUIRED** — for new organizations and for organizations that never saved a preference (nothing needs to be saved for it to apply). An **explicitly saved** preference is always honoured and never silently changed: switching approval off is a deliberate, audited setting in Publishing Settings, and later unrelated changes do not re-enable it. It is enforced for *every* way a publication can reach a provider: the Publishing Center, the older `/content/:id/schedule` and publish-now (only APPROVED destinations are scheduled; none approved → 409), the scheduler, manual retry, and the hand-off to Upload-Post's scheduler.
- **History:** append-only `publication_events` — type, from/to state, actor (null = the system), reason, metadata, time — plus audit-log rows. The detail page shows submitter, approver, timestamps, rejection reason, and the content revisions reviewed.
- **Pinned to what was reviewed.** Approving stores a canonical payload (platform, effective text, title, asset ids, track). If any of it differs when scheduling or when the worker is about to call a provider, the approval is withdrawn (`INVALIDATED` event; an already-scheduled publication goes back to the plan state with it) and nothing is published. Editing the destination's text through the Publishing Center does the same immediately.
- **Who may approve, and may they approve their own submission** (`evaluateApprover`, one pure function, unit-tested):

  | Role | Approve others' work | Approve their own submission |
  |---|---|---|
  | **OWNER** | yes | **yes by default** (`ownerSelfApproval`, configurable per organization) |
  | **ADMIN** | yes | **no by default** (`adminSelfApproval`, configurable per organization) |
  | **CREATOR** (Phase 8 role — rule already enforced) | never | **never**, whatever the switches say |
  | EDITOR, VIEWER | never | never |

  **A self-approval always creates an audit event**, independent of the policy: an audit-log row `PUBLICATION_SELF_APPROVED` (plus `PUBLICATION_APPROVED`) and the publication-history `APPROVED` event carries `selfApproval: true` and the approver's role. A refused attempt is audited as `PUBLICATION_APPROVAL_DENIED`.
- **Review validates the content** (account, media, text, track, repetition), not the time: a plan that has since gone stale never blocks a review. The time, daily cap and spacing are checked when scheduling.

### Automatic scheduling after approval

Campaign setting (`Campaign.autoScheduleOnApproval`: inherit / on / off) over the organization setting. When on, approving schedules the publication **at the time a person already planned for it** — never an invented time — and only if it passes the full scheduling validation; otherwise it stays APPROVED and the reasons are returned and shown. **Automatic publishing never means publishing unapproved content**: the scheduler holds an unapproved or changed publication instead of firing it.

### The confirmed publishing architecture (owner decision)

- Socialith's **database is the source of truth** and Socialith **owns the primary publishing schedule**.
- **Approved** content is submitted automatically **at its scheduled time** by Socialith's own queue.
- **Upload-Post is the primary external publishing provider.**
- **Upload-Post scheduling hand-off is disabled by default.** It may be enabled only after a **separate live verification** and the **owner's explicit approval** — enforced in configuration: `UPLOAD_POST_SCHEDULE_HANDOFF_ENABLED=true` alone refuses to boot; the deliberate second switch `UPLOAD_POST_HANDOFF_OWNER_APPROVED=true` must be set as well (`UPLOAD_POST_SETUP.md` §8).
- **A publication target never has two scheduling owners** (ownership guards, §5).

## 5. Scheduling — one owner per target, on the existing engine

There is no second scheduler. Per content there is still **one deterministic BullMQ job**, set to the **earliest** scheduled target; `Content.status`/`scheduledAt` are derived from the targets (`computeContentRollup`).

- When the job fires it fires only the targets whose **own** time has come, holds only the ones that are individually **stale**, leaves the rest SCHEDULED and moves *the same job* to the next due time (`moveToDelayed`).
- **Ownership** (`scheduling/ownership.ts`, unchanged): a target is either Socialith's or — after a hand-off — the provider's; every Socialith mechanism (job, stale hold, reconciler) skips provider-owned targets, and every doubt resolves in Socialith's favour. The dashboard shows the owner on every scheduled item (**Socialith queue** vs **Upload-Post scheduler**, `P` on the calendar).
- **Hand-off** (Upload-Post, `UPLOAD_POST_SCHEDULE_HANDOFF_ENABLED`, default off): the sweep gives a target to the provider's scheduler when its own time is inside the window (default 48 h) and ≥ 10 min away, and never an unapproved/changed one, never one with a non-durable media URL, never one whose mandatory track cannot be attached. The provider job id is stored.
- **Reschedule / unschedule / hold / cancel** change the database first; an immediate Upload-Post sweep is queued so the provider job is **edited or cancelled** within seconds (the repeatable sweep would do the same within a minute). A provider job that is about to run (< 2 minutes) can no longer be edited at the provider, so the API refuses (409) instead of pretending.
- **Recovery:** the reconciler re-creates a missing job from the database at the earliest remaining target's time (Redis loss, restored snapshot, rows written elsewhere), holds stale targets, restores missing publishing/poll jobs and finalizes contents. Held/cancelled targets never keep a content open.
- **No double publication:** job id = target id; `external_id`/`request_id`/`Idempotency-Key` per generation; after a timeout **or an unreadable answer** the provider is asked by `request_id` before anything is re-sent; a manual retry of a failed target is a new generation.
- **Timezone:** instants are stored in UTC; entry and display use the organization's timezone (default **Europe/Istanbul**, IANA, DST-correct via `Intl`); the zone a time was entered in is stored per publication; "the same day" for the daily cap is the organization's local day.

## 6. Retry policy and monitoring

Unchanged from Phase 2, now visible per publication (attempts with classification, HTTP status, retryable/permanent, `Retry-After`): permanent errors (configuration, content, auth) are **not** retried; network/server errors retry with exponential backoff; rate limits wait for `Retry-After`; an ambiguous outcome (timeout, unreadable answer) is resolved against the provider's status/history before any retry. Results arrive by the signed Upload-Post webhook (HMAC over the raw body, tolerance, rotation, delivery de-duplication), with status polling and the sweep as the fallback. `deliveryNote` explains results that are not live (TikTok inbox).

## 7. Platform validation (before scheduling)

Run on create (as a hint), submit, approve, schedule, retry, and as a dry-run. Every problem is returned at once as a structured list (`422 VALIDATION_FAILED`, `error.details.issues[]` with `code`, `severity`, `field`, `message`). **ERROR** blocks, **WARNING** is allowed but explained, **INFO** informs. Platforms are never treated as interchangeable.

| Check | Rule | Severity | Evidence |
|---|---|---|---|
| Account | not a demo/seed account; account status CONNECTED; right platform | ERROR | code |
| Provider (Upload-Post) | destination linked; account not REAUTH_REQUIRED / DISCONNECTED; profile ACTIVE and not blocked; identity unchanged | ERROR | code + live check (profile `blocked`) |
| Media type | needs a video or image the platform accepts; **YouTube: video only**; audio/thumbnail alone is not publishable; mixed → video wins (warning) | ERROR / WARNING | `UPLOAD_POST_API_MAPPING.md` §2 |
| Caption | TikTok ≤ 2200, Instagram ≤ 2200 and ≤ 30 hashtags, YouTube description ≤ 5000 (characters, not UTF-16 units) | ERROR | documented platform limits (as mapped in Phase 2) |
| Title | YouTube ≤ 100; missing title falls back to the first caption line (info / warning when truncated or absent) | ERROR / WARNING | Phase 2 mapping |
| Aspect ratio | Instagram feed images 4:5 … 1.91:1 → ERROR; vertical 9:16 recommended for short video → WARNING | ERROR / WARNING | **not verified live** |
| Duration | Instagram 3 s … 900 s (ERROR), > 90 s Reels eligibility (WARNING); TikTok ≤ 3600 s (ERROR); YouTube Shorts note | ERROR / WARNING | **assumed — not verified live; adjust in `PLATFORM_RULES`** |
| File size | TikTok ≤ 4 GB (ERROR); Instagram > 300 MB (WARNING) | ERROR / WARNING | **assumed — not verified live** |
| Unknown media facts | dimensions / duration / size not recorded on the asset → one WARNING naming exactly what was **not** checked; the result is `ok` (nothing known to be wrong) but **never `fullyValidated`**, and the media is reported `PARTIAL` / `UNVERIFIED` | WARNING | TD-49 |
| Music | only TikTok attaches a track; needs a mapping that is VERIFIED_AVAILABLE, **rights confirmed by a person**, verified ≤ 30 days, and an account with the `music` capability. Missing → WARNING (the post goes out without it). **"Require the track"** makes each condition an ERROR and the worker fails the publication before any provider call. Other platforms: INFO | WARNING / ERROR | Phase 2 rules |
| Scheduled time | present when scheduling; not in the past; ≥ minimum lead (default 10 min); ≤ 365 days (provider limit) | ERROR | provider docs |
| Limits per destination | daily cap (default 3, organization-local day) and minimum spacing (default 60 min), counted over scheduled, in-flight and published | ERROR | organization policy |
| Repetition | the same asset with ≥ 85 % similar text (word 3-grams) on more than 1 destination of one platform: the first created keeps its text, each later one is blocked (or warned / off) until it has its own caption | ERROR / WARNING | PRD guardrail 2 |

### Media is never reported as validated while its metadata is unknown

Every validation returns `ok` (no error), `media` (`VERIFIED` / `PARTIAL` / `UNVERIFIED` / `NONE`, with the `known` and `unknown` facts) and `fullyValidated` (= `ok` **and** media `VERIFIED`). The dashboard shows **NOT FULLY VALIDATED · media UNVERIFIED** with the missing facts (approval cards, new-publication results, publication detail; each file on the detail page lists its known facts and marks the unknown ones "unknown — not verified"). What *is* known is always enforced (a known 2-second Reel is refused even if the dimensions are unknown), and the account, provider and platform-capability checks stay fully active. Until Media Pack processing extracts dimensions and duration (Phase 5, TD-49) most uploads will honestly show as not fully validated; approval is still possible — the approver sees this plainly.

**What is and is not verified:** the rules above are unit-tested exhaustively (`packages/publishing`), the API behaviour is integration-tested, and the Phase 2 mapping of caption/title limits was read from the provider documentation. Duration, file-size and aspect thresholds are **conservative assumptions, not live-verified**; none of Instagram/YouTube/TikTok publishing has been observed live (the owner's Upload-Post trial account has no connected social account yet). Treat a green validation as "passes Socialith's checks", not as a guarantee that a platform will accept the post.

## 8. Guardrails (non-negotiable, from the PRD)

No fake likes, comments, follows, views, pods, auto-DM/auto-comment or reposting-to-boost — none of it is wired anywhere. The same asset is not sent unchanged to many pages (§7 repetition guard, per-destination caps). Only authorized accounts of the organization are destinations. Approval before publish is available as an enforced organization policy and is recommended.
