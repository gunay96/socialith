# Phase 3 — audit of the existing publishing implementation

Written before any Phase 3 code (branch `phase3-publishing-center`, base `main` @ `12959f6`). Everything below was read from the repository, not assumed. Evidence tags: **[code]** read in source, **[test]** covered by an existing automated test, **[doc]** stated in a repository document.

## 0. Phase 2 verification (Step 0)

| Check | Result |
|---|---|
| `phase2-uploadpost` merged into `main` | **Yes** — PR #3, merge commit `12959f6`; `52d319d` (last Phase 2 commit) is an ancestor of `origin/main`; the merged tree is byte-identical to the Phase 2 tip (`git rev-parse HEAD^{tree}` equal) |
| GitHub Actions on the Phase 2 tip `52d319d` | `hygiene`, `verify`, `images` all **success** (checked through the GitHub API) |
| GitHub Actions on the merge commit `12959f6` | `hygiene` and `images` **success**; `verify` was **still running** when Phase 3 started (see the report for the final result). The merged content equals the already-green tip, so this was not treated as a blocker |
| Local `main` | fast-forwarded to `origin/main` (no merge commit created locally); work happens on `phase3-publishing-center` only |

## 1. What already exists (do not recreate)

| Area | What exists | Evidence |
|---|---|---|
| Publication unit | `ContentTarget` = Content × SocialAccount (unique pair), own `status` (PENDING/SCHEDULED/PUBLISHING/PUBLISHED/FAILED), `scheduledAt`, `publishedAt`, `externalPostId/Url`, `errorMessage`, `deliveryNote`, `attemptCount` | [code] `schema.prisma` |
| Attempt trail | `PublishAttempt` (immutable row per attempt: error code, retryable, HTTP status, rate-limit reset, safe response metadata) | [code][test] |
| Provider row | `UploadPostPublication` 1:1 with a target: mode `IMMEDIATE`/`PROVIDER_SCHEDULED`, status, `externalId`, `requestId`, `providerJobId`, generation, `scheduledFor`, `tiktokMusicId`, `notes` | [code][test] |
| Publishing destination | `SocialAccount.publishingProvider` (`NATIVE`/`UPLOAD_POST`) + `UploadPostConnectedAccount` link (the "destination"); enable/disable API, capability derivation (`GET /api/upload-post/capabilities`) | [code][test] |
| Content scheduling | `POST /content/:id/schedule`, `publish-now`, retry; transaction sets content + PENDING targets SCHEDULED, then one delayed BullMQ job per **content** (`content-scheduling`) | [code][test] |
| Workers | `content-scheduling` → `publishing` (one job per target, deterministic job id) → `publish-status-poll`; `upload-post` queue (`sync`/`sweep`/`reconcile`) | [code][test] |
| Duplicate protection | job id = target id; `external_id`/`request_id`/`Idempotency-Key` per generation; ask-the-provider-before-resend after timeout | [code][test] |
| Ownership (one owner per target) | `scheduling/ownership.ts` `PROVIDER_OWNED` / `SOCIALITH_OWNED`, used by the scheduling job, the stale hold and the reconciler | [code][test] |
| Hybrid hand-off | sweep: hand-off inside a window, drift (edit/cancel at the provider), unknown-outcome resolution, status reconciliation, unconfirmed-after-6 h | [code][test] |
| Recovery | `reconcileScheduling` recreates missing scheduling/publishing/poll jobs from the database, holds stale content, finalizes content | [code][test] (Redis-loss scenarios in `scheduling.integration.test.ts`) |
| Webhook | `POST /api/webhooks/upload-post`: HMAC over the raw body, 5-min tolerance, rotation, delivery de-duplication, enqueues `reconcile` | [code][test] |
| Error classification | `PublishError` codes; Upload-Post errors mapped; rate limit honours `Retry-After`; permanent errors not retried | [code][test] |
| Dashboard | `/content` (list/detail with targets), `/campaigns`, `/sounds`, `/accounts`, `/upload-post/*` (8 pages incl. Publishing history and Scheduled jobs) | [code] |
| RBAC | roles `OWNER > ADMIN > EDITOR > VIEWER`; `requireMinimumRole`; org isolation returns 404 | [code][test] |
| Audit log | `AuditLog` (action, target, metadata) | [code] |

## 2. Gaps found (what Phase 3 must add)

| # | Gap | Consequence today | Plan |
|---|---|---|---|
| G1 | **No approval workflow at all** (no states, history, approver, rejection reason). RBAC has no Approver role (TD-11) | anything assigned to a target can be scheduled and published by an EDITOR | per-target approval state + append-only event log; approve/reject need ADMIN; org setting `requireApproval` enforced **inside the scheduling query**, so legacy endpoints cannot bypass it |
| G2 | **Scheduling is per content, not per target.** One job fires every SCHEDULED target of a content at `content.scheduledAt`; the stale hold fails *all* SCHEDULED targets; the sweep hands off by `content.scheduledAt` | a destination cannot be rescheduled, cancelled or held on its own; staggered posting across pages is impossible | make the existing processor/hold/reconciler/sweep **target-time aware** (fire only due targets, re-arm the job for the next one). No second scheduler |
| G3 | No per-target cancel / hold / reschedule; no `CANCELLED`/`HELD` representation | cancel only by deleting a target | `exception` marker (`HELD`/`CANCELLED`/`STALE`) on the target, status returns to `PENDING` so no mechanism fires it |
| G4 | **One caption per platform, not per destination** (`ContentVariation` is per platform) | N destinations of one platform necessarily get identical text — the exact "repetitive distribution" the guardrails forbid | per-target `captionOverride`/`titleOverride`; duplicate/similarity guard; per-destination daily cap and minimum spacing |
| G5 | No content **revision tracking**; an approved item can be edited afterwards unnoticed | what was approved ≠ what is published | `ContentRevision` snapshots + per-target `approvedPayload`; schedule **and** fire time compare the current payload with the approved one, mismatch → not published |
| G6 | No pre-schedule **platform validation** (only partial checks at publish time) | failures surface minutes/hours later | pure validation module (account/provider status, capability, media type, caption limits, hashtags, music + rights, scheduled-time validity, caps), run on create/submit/schedule and as a dry-run endpoint |
| G7 | No unified publication lifecycle (`QUEUED`, `STALE`, `HELD`, `CANCELLED`, `REJECTED` do not exist; stale hold is just `FAILED` + message) | operators cannot tell a missed slot from a platform failure | one pure `derivePublicationState()`; stored markers only where the old enums cannot express it; old enums unchanged |
| G8 | No Publishing Center API (calendar feed, queue, failed inbox, filters by artist/campaign/platform/creator/page/state/date, destination picker, publication detail) | the only views are per content or per provider row | `/api/publishing/*` read model over the existing tables |
| G9 | No org-level publishing settings (timezone, approval, caps) | timezone is only an `Organization` field | `PublishingSettings` (one row per organization, lazily created) |
| G10 | Campaign has no automatic-scheduling setting | "automatic scheduling after approval according to campaign settings" impossible | nullable `Campaign.autoScheduleOnApproval` (null = inherit organization setting) |
| G11 | **No Artist entity** (Artist/Music/Campaign is Phase 7) | the "artist" filter and "artist and track" selection of the brief have nothing to point at | **not built here** (Phase 7). Track = the existing `Sound`; "artist" filter = `Sound.artist` text; both clearly labelled in the UI. Needs owner awareness (see §5) |
| G12 | Webhook/poll/reconcile are complete for Upload-Post, but nothing makes the *calendar* reflect them in near-real time after an operator change | a cancelled/rescheduled provider job waits for the next sweep (≤ 1 min) | after an operator action the API enqueues a sweep (same BullMQ queue) instead of waiting |

Not gaps (verified working, only reused): webhook signature validation, polling fallback, `Retry-After` handling, ambiguous-outcome check before resend, `external_id` correlation, Redis-loss recovery of scheduling jobs, destination capability and music-rights gates.

## 3. Design decisions

1. **Publication = `ContentTarget`.** No new "publication" table. Everything new is an additive column or table; **no existing enum value is changed or removed**, no migration is rewritten.
2. **Approval is per target** (each destination is approved on its own — the API has no bulk-approve endpoint, the UI loops one call per destination). States stored as `approvalStatus` (`DRAFT`, `READY_FOR_REVIEW`, `APPROVED`, `REJECTED`); execution states stay in the existing `status`.
3. **The brief's lifecycle is derived**, not stored twice: `DRAFT → READY_FOR_REVIEW → APPROVED → SCHEDULED → QUEUED → PUBLISHING → PUBLISHED`, plus `REJECTED`, `FAILED`, `CANCELLED`, `STALE`, `HELD`. `QUEUED` = target is `PUBLISHING`, no attempt made yet, no provider row yet (i.e. a publishing job is waiting); once an attempt exists it is `PUBLISHING`. `STALE` = the existing stale-hold (missed its slot by more than the window), now explicit. `CANCELLED`/`HELD` = operator actions.
4. **Approval gate lives in the data layer, default = legacy behaviour.** `PublishingSettings.requireApproval` is read inside the scheduling repository query. An organization without a settings row behaves exactly as before (approval not required) so nothing existing changes silently; the settings page recommends turning it on. *Owner decision: whether new organizations should default to "required" (guardrail 5 of the PRD says approval is the default).*
5. **Scheduling stays on the existing engine.** The content-scheduling job fires only the targets that are due (`scheduledAt ≤ now`), then re-arms itself for the next due target of that content; the stale hold only touches targets that are individually stale; the sweep uses the target's own time. `content.scheduledAt` is kept as "earliest scheduled target" for display and for the existing queries. Ownership guards are unchanged and reused. With identical target times the behaviour is identical to today (the 18 + 21 existing scheduling/sweep integration tests must stay green unchanged).
6. **"Preserve the previously selected automatic publishing model"** — interpreted as the model recorded in `UPLOAD_POST_INTEGRATION.md` §6: *Socialith's database owns the schedule; Upload-Post executes only after a bounded, optional hand-off; hand-off is OFF by default; nothing publishes without a human approving it when approval is required.* No setting in this phase switches that model; "automatic scheduling after approval" only schedules **at the time a human already proposed**, never invents a time. *If you meant a different model, say so before merge.*
7. **No engagement automation, ever.** Nothing in this phase touches comments, DMs, likes, follows, reposts or boosts (they are out of scope per the PRD and are not wired).
8. **Platform limits are data, not code.** Caption/title/hashtag limits that are well documented are hard errors; duration/size/aspect rules are only enforced where the limit is certain and otherwise raised as warnings ("could not verify") — see `PUBLISHING_WORKFLOW.md` for the table and which values are unverified live.
9. **New pure package `@socialith/publishing`** holds the state derivation, transition rules, validation, similarity guard and timezone helpers (no I/O, shared by API, worker and web) so the rules are unit-testable and cannot drift between processes.
10. **Timezone:** instants are stored in UTC (`DateTime`); the organization timezone (default `Europe/Istanbul`) is used for input and display, and the zone a time was scheduled in is stored per target. Istanbul has had a fixed UTC+3 since 2016; the helpers still use the IANA database through `Intl`, so other zones and DST are handled.

## 4. Explicitly not in scope (Phase 3)

Page Network, AI Studio, the Artist/Music/Campaign model (Phase 7), the creator portal (Phase 8), analytics (Phase 9), any real publication, TikTok/Meta native review work, new provider integrations, any engagement feature.

## 5. Open points for the owner

1. **Artist** does not exist as an entity until Phase 7 — the Publishing Center filters by the free-text `Sound.artist`. Acceptable for now?
2. **Default for `requireApproval`** on organizations that have never opened Publishing Settings (see decision 4).
3. **Self-approval:** the setting `allowSelfApproval` defaults to **true** so a one-person agency can operate; turn it off to force a second person. Every approval records who approved.
4. Confirm the interpretation in decision 6.

## 6. Findings during implementation (added after the build)

The audit above was written before any code. Building and testing found four things worth recording; they are fixed and covered by tests (`PUBLISHING_TESTING.md` §3):

1. A SQL three-valued-logic trap: negating a condition on the nullable `exception` column silently dropped rows with no exception (repetition guard, calendar). All such conditions now handle NULL explicitly.
2. An approval withdrawn at reschedule time left a publication "scheduled"; it now returns to the plan state with its approval.
3. An unreadable HTTP 200 answer to a publish left the provider row `PENDING`; it is now an explicit unknown outcome (no double-publish risk ever existed — the retry already asked the provider first).
4. The blanket API rate limit (300 requests/minute/IP) is a production protection and was left untouched; the test suite starts one app per describe block instead.
## 7. Owner decisions taken after the report (Phase 3 final)

The open points of §5 were answered; the implementation follows them (PHASE3_IMPLEMENTATION.md §7): approval **required by default** (incl. organizations that never saved a preference; explicit preferences preserved); **Artist** stays free text until Phase 7; the **automatic publishing model** is confirmed (database = source of truth, Socialith owns the primary schedule, approved content submitted at its time, Upload-Post primary provider, hand-off off by default and only after separate live verification + explicit owner approval, never two scheduling owners); **self-approval by role** (owner yes, admin configurable and off by default, creator never, always audited); **media metadata** gaps are displayed as unknown and never reported as validated.
