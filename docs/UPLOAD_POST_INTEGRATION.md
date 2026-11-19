# Upload-Post Integration

Upload-Post is a first-class publishing provider, owned and orchestrated by the Socialith backend.

> **Status (Phase 2, branch `phase2-uploadpost`): implemented and tested against the in-repo contract double — never yet run
> against the live service.** The first sections below are the original pre-implementation design (2026-11-19); where the
> implementation differs, **§A (as built)** is authoritative. Companion documents:
> `UPLOAD_POST_API_MAPPING.md` (every endpoint, field and its verification status), `UPLOAD_POST_SETUP.md` (how the owner
> configures it), `UPLOAD_POST_TESTING.md` (what is tested, how, and what only a live key can prove), `PHASE2_CHECKPOINT.md`.

## A. As built (Phase 2)

### A.1 Layers and where the code lives

| Layer | Code | Responsibility |
|---|---|---|
| Provider client | `packages/upload-post` | HTTP, auth, timeouts, retry of idempotent reads, rate-limit handling, structured errors, normalization, webhook signature verification, contract double. No DB, no framework. |
| Worker | `apps/worker/src/upload-post/*`, `processors/upload-post.processor.ts` | Read-only synchronization, publishing (`UPLOAD_POST` destinations), status reconciliation, hybrid-scheduling sweep. BullMQ queue `upload-post`. |
| API | `apps/api/src/{routes,controllers,services}/upload-post*`, `lib/upload-post.ts` | Dashboard endpoints, mappings, destinations, TikTok music mappings, the signed webhook. Enqueues work; never publishes itself. |
| Dashboard | `apps/web/src/app/(app)/upload-post/*` | Eight pages (Overview, Profiles, Accounts, Mapping, Publishing history, Scheduled jobs, Provider health, Plan & usage). |

The pre-existing publishing path is unchanged: native TikTok/Instagram/YouTube providers, `PlatformConnection` tokens, the
publishing/poll processors. A destination chooses its route with `SocialAccount.publishingProvider` (`NATIVE` default, `UPLOAD_POST`).

### A.2 The five concepts (never conflated)

1. **Upload-Post Profile** (`UploadPostProfile`): the provider's container (`username`, immutable). Holds at most one account per platform.
2. **Connected Platform Account** (`UploadPostConnectedAccount`): one platform account inside a profile. Keyed by the provider's **stable account id**
   (`social_accounts.<platform>.username`; for TikTok the app-scoped `open_id`). The public `handle` is display data and can change.
3. **ManagedPage** (`ManagedPage`): a Socialith thematic page. Minimal label here — the Page Network is Phase 4.
4. **Creator** (`Creator`): a Socialith creator/artist. Minimal here.
5. **Publishing Destination**: a `SocialAccount` with `publishingProvider = UPLOAD_POST`, linked 1:1 to a connected account. Created only by an
   explicit admin action, never by synchronization.

Mappings are Socialith-side (`UploadPostProfile.managedPageId`, `UploadPostConnectedAccount.creatorId`); synchronization never writes them.

### A.3 Synchronization (read-only, never destructive)

`GET /uploadposts/users` → profiles + accounts, every 30 min (configurable), on demand from the dashboard, and after a connection-change webhook.
Idempotent (unique `(organization, username)` and `(profile, platform)`; races tolerated). Upstream disappearance → `REMOVED` / `DISCONNECTED`, rows kept.
A failed or suspiciously empty answer (≥ 5 known profiles, none returned) changes nothing. If the stable id behind a (profile, platform) **changes**, the
destination link is cleared, the destination is flagged `ERROR`, an audit row is written, history is kept, and nothing re-attaches by itself.
Plan and profile limit are stored from what the provider reports at each sync — never a constant (the 225 of the Business plan is not in the code).

### A.4 Publishing and correlation

One `UploadPostPublication` per ContentTarget, created **before** the provider is called. It carries `external_id = socialith:target:<id>:g<generation>`,
`request_id`, and an `Idempotency-Key`, all fixed per generation. Always `async_upload=true`. Correlation is by `external_id` (the provider documents that
titles are editable and `external_id` is only a label — so it is never relied on for duplicate prevention). Duplicate prevention is: unique row +
Idempotency-Key (24 h at the provider) + **asking the provider by `request_id` before any resend** after a timeout or redelivery. A deliberate retry of a
failed target is a new generation = a new provider job. Results arrive via the status poll, the sweep, or a verified webhook (all converge on one function).

### A.5 Hybrid scheduling

Socialith's database owns the schedule. With `UPLOAD_POST_SCHEDULE_HANDOFF_ENABLED=true` (default **false**), a target due within the window (default 48 h, never
closer than 10 min) is given to the provider's scheduler (`scheduled_date` → `job_id`, stored). While provider-owned, every Socialith mechanism skips it
(`scheduling/ownership.ts`: the content-scheduling job, the stale hold, the reconciler) — **a target is never scheduled in both systems**. The sweep (every
minute) pushes Socialith-side changes: reschedule → `PATCH /schedule/{job_id}`; unschedule/leaves the window → `DELETE`; an unknown hand-off outcome is
resolved by `external_id` (adopt, or release back to Socialith). Presigned (short-lived) media URLs are never handed to a provider scheduler. Any doubt
resolves in favour of Socialith owning the target.

### A.6 TikTok music

`SoundMusicMapping` links a Socialith `Sound` to a provider `tiktok_music_id`. Lookup is capability-gated (`music`) and clearly labelled as Commercial Music
Library **chart** data, not the whole catalogue. A mapping is `UNVERIFIED` until checked against chart data; **rights are a separate human confirmation**.
At publish time music is attached only if the mapping is verified available, rights-confirmed, verified ≤ 30 days ago and the account has the capability;
otherwise the post goes out **without** music and the publication `notes` says why. The id actually sent is recorded (`tiktokMusicId`).

### A.7 What is NOT in this phase

Profile creation (client method exists, mock-tested, deliberately not exposed), analytics sync, comments/DMs, other platforms as destinations
(they are synchronized and shown, not publishable), Page Network, AI Studio, large-scale publishing, any real public publication.

---

## Original design (2026-11-19, pre-implementation)

Status of what follows: design; sections that were marked [UNVERIFIED] are re-evaluated in `UPLOAD_POST_API_MAPPING.md`.

## 0. Evidence and its limits (read first)

Source: the official reference page `https://docs.upload-post.com/api/reference`, fetched
2026-11-19 and summarized by an automated reader. It gave **endpoint paths, auth scheme,
rate-limit statements and a subset of parameters**. It did **not** show: the `platform[]` /
`user` / `scheduled_date` / `timezone` / title / description parameter names, response bodies,
scheduling endpoint paths ("various scheduling endpoints"), webhook payload schemas, or the
profiles-per-plan limit. Everything in this document marked **[UNVERIFIED]** must be confirmed against
the per-endpoint pages and a real sandbox call (step 0 of the roadmap) before code is written.
Nothing here was tested against a live Upload-Post account (no key available).

**MCP vs REST.** Upload-Post also exposes an MCP server (`https://mcp.upload-post.com/mcp`, API key
or OAuth 2.1/PKCE). That is a *development-time* tool for an AI assistant. The production
Socialith backend integrates through the **REST API** with a server-held API key. The MCP server is
never part of the runtime architecture.

## 1. API endpoint mapping

Base URL `https://api.upload-post.com/api`. Auth header: `Authorization: Apikey <key>`.

| Socialith capability | Upload-Post endpoint (documented) | Notes |
|---|---|---|
| Validate key, read plan | `GET /uploadposts/me` | Source for plan/capacity; **response shape [UNVERIFIED]** |
| List profiles | `GET /uploadposts/users` | Profile = `username`; connected platforms per profile **[shape UNVERIFIED]** |
| Create profile | `POST /uploadposts/users` | One profile per managed page/creator (see §4) |
| Rename profile | `PATCH /uploadposts/users/{username}` | `display_name` |
| Delete profile | `DELETE /uploadposts/users` | Destructive; admin-only, audited |
| Connect an account | `POST /uploadposts/users/generate-jwt` (hosted connect link) and `POST /uploadposts/oauth/{platform}/start` (returns authorize URL, `redirect_url`, `connect_status` on callback) | Used to let page owners/creators authorize accounts |
| Disconnect an account | `DELETE /uploadposts/users/social` | |
| Upload video | `POST /upload` | multipart or URL; params incl. `async_upload`, `external_id`, `is_ai_generated`, `tiktok_music_id`, `tiktok_location_id/_name`, `facebook_page_id`, `target_linkedin_page_id`, `gbp_*` |
| Upload photos/carousel | `POST /upload_photos` | |
| Upload text | `POST /upload_text` | Out of music-marketing v1 scope except where useful |
| Status | `GET /uploadposts/status` (`request_id` for async, `job_id` for scheduled) | |
| History / reconciliation | `GET /uploadposts/history` (filters `platform,status,profile_username,start,end,request_id,job_id,external_id`) | Key to duplicate prevention (§6) |
| Retry failed platforms | `POST /uploadposts/posts/retry` | |
| Unpublish | `POST /uploadposts/posts/unpublish` | **Not** supported for Instagram, TikTok, Threads |
| Edit published | `POST /uploadposts/posts/edit` | Only Facebook, LinkedIn, X, YouTube, Google Business |
| Scheduling | "various scheduling endpoints" **[paths UNVERIFIED]** + `scheduled_date` upload param **[name UNVERIFIED]** | Cancel/reschedule paths must be confirmed |
| Analytics (profile) | `GET /analytics/{profile_username}` | rate-limited |
| Analytics (post) | `GET /uploadposts/post-analytics/{request_id}`, `…/post-analytics?platform_post_id=` | rate-limited |
| Analytics (bulk, cached) | `GET /uploadposts/post-analytics/cached` (cursor, ≤200/page, `platform,since,until`) | **exempt from the analytics limit → preferred for sync** |
| Instagram quota | `GET /uploadposts/instagram/publishing_limit` | pre-flight check |
| TikTok helpers | `GET /uploadposts/tiktok/music/{trending,search}`, `/tiktok/locations`, `/tiktok/settings` | Potential sound-attachment path (see §11) |
| Webhooks | `GET/POST/DELETE /uploadposts/users/notifications`, `…/users/profile-webhook`, `POST …/users/webhook-secret`, `GET …/webhooks/deliveries[/id]`, `POST …/redeliver` | HMAC-SHA256 in `X-Upload-Post-Signature`, at-least-once, 7-day delivery log |

**Deliberately NOT integrated** (engagement mechanisms / out of scope per PRD guardrails):
comments, DMs, AutoDM monitors/rules, repost, ChatGPT Ads, Bluesky read APIs, Teams/approvals
endpoints (marked "not generally available" and Socialith owns approvals).

## 2. Authentication architecture

- One **ProviderCredential** per organization and provider (`UPLOAD_POST`), holding the API key
  **encrypted at rest with the existing AES-256-GCM vault** (`TOKEN_ENCRYPTION_KEY`,
  `packages/auth/src/token-crypto.ts`), stored in a table separate from any list-returning query
  (same discipline as `PlatformConnection`).
- The key is decrypted only inside the worker/API service that calls Upload-Post; never serialized
  to a response, never logged, never sent to the frontend. The dashboard shows only
  "connected / last validated / plan / capacity".
- Environment fallback for single-tenant bootstrap: `UPLOAD_POST_API_KEY` (server-only) — used to seed the
  credential row, then the DB row is authoritative.
- Settings UI (ADMIN+): enter key → backend calls `GET /me` → on success stores key + plan; "rotate key"
  and "disconnect" actions audited.
- HTTP client: single module with timeout, `Authorization: Apikey`, redaction of the header in logs,
  `PublishError`-compatible error mapping (§9).

## 3. Profile synchronization architecture

Direction: Upload-Post → Socialith (read-mostly), plus Socialith-initiated profile creation.

- **Sync job** (`provider-sync`, worker or cron-triggered): `GET /users` → upsert
  `ProviderProfile` rows (username, display name, last-seen, connected platforms) →
  upsert `ProviderAccount` rows per connected platform (platform, handle/id, status).
  Handles deletes by marking `MISSING_REMOTE` (never hard-deleting local history).
- Triggers: manual "Sync now", after connect callback, nightly, and on webhook
  `account connected/disconnected` events if the payload provides them **[UNVERIFIED]**.
- Idempotent; safe to run concurrently (MySQL `GET_LOCK` / unique keys on
  `(organizationId, provider, username)`).
- Drift report: profiles present remotely but unmapped; mappings pointing at remote-missing profiles.

## 4. Account-to-page mapping

```
Organization
 └─ ProviderCredential (UPLOAD_POST; apiKey enc; plan; capacity; webhookSecret enc)
     └─ ProviderProfile (username)                   ← 1 Upload-Post profile
         └─ ProviderAccount (platform, handle, status)  ← one connected social account
              ▲ N:1 / authorized for
ManagedPage (type: THEMATIC | CREATOR; category; groups; style profile)
Creator (person) ── owns 0..n ManagedPage(type=CREATOR)
```

- **Rule:** a ManagedPage is authorized to publish *only* through `ProviderAccount`s explicitly linked
  to it (`PageAccountAuthorization`); a creator's accounts are linked only after the creator's consent.
- Convention (configurable, not enforced by schema): 1 Upload-Post profile ↔ 1 ManagedPage or Creator,
  so profile count scales with pages/creators; schema allows many pages per profile if ever needed.
- **Capacity is data, not code:** `ProviderCredential.profileCapacity` (nullable int) is set from
  `GET /me` when the response exposes it, otherwise from an admin-entered value (initially the owner's
  stated 225 for the Business plan). The UI warns at ≥80% and blocks profile creation at 100%
  with an explanatory message; a plan upgrade only changes this value. No constant `225` anywhere in code.
- Existing `SocialAccount`/`PlatformConnection` remain for *native* providers; a native account and an
  Upload-Post account for the same real handle can coexist and are distinguished by provider.

## 5. Publishing workflow

1. Content passes **internal approval** (Socialith owns approval; Upload-Post's approval feature unused).
2. User/recipe selects targets = (ManagedPage → authorized ProviderAccount) pairs; the Publishing
   Center creates one `ContentTarget` per pair (existing model, extended with `provider`,
   `providerAccountId`, `providerRequestId`, `providerJobId`, `externalCorrelationId`).
3. Dispatcher builds the Upload-Post request: media by **fresh signed/public URL** (existing
   `resolveAssetUrl` logic) or multipart; per-platform caption/title from the page/platform
   `ContentVariation`; `external_id = ContentTarget.id`; `async_upload=true`;
   `is_ai_generated` from content provenance; platform extras (TikTok music/location,
   Facebook page id, etc.) from the account's settings.
4. Response → store `request_id` (or `job_id` if scheduled) on the target; target state → `PROVIDER_PROCESSING`
   (new state, additive) ; **no PUBLISHED until the provider reports success**.
5. Status arrives via webhook (primary) and poll/reconcile (fallback) → target `PUBLISHED`/`FAILED` with
   per-platform results, post URL/id when provided, immutable `PublishAttempt` rows as today.
6. Failures follow the retry policy (§9); `posts/retry` is used for per-platform failures where appropriate,
   but Socialith's own attempt counter and caps remain authoritative.

## 6. Scheduling architecture — decision

**Options evaluated**

| | A. Internal BullMQ executes at publish time, calls Upload-Post then | B. Delegate to Upload-Post's scheduler for everything |
|---|---|---|
| Reliability if worker is down at T | **Misses the post** | Post still fires |
| Cancel / reschedule | Trivial (remove job + state) | Depends on provider endpoints **[UNVERIFIED]** |
| Approval/edit flexibility until T | Full | Locked once handed off |
| Source of truth | One | Two (risk of drift/double scheduling) |
| Tracking | Own state machine | Provider job + our mirror |
| Observed current weakness | Delayed-job-only scheduling already orphaned a row with no recovery (TD-05) | — |

**Decision: hybrid with a single owner of "when" — *Socialith owns the schedule, Upload-Post owns the
execution after a bounded hand-off*.**

- `ContentTarget.scheduledAt` stays the source of truth. A target is in exactly one of two states:
  `INTERNAL_SCHEDULED` (Socialith holds it) or `PROVIDER_SCHEDULED` (handed off, `providerJobId` stored).
  A target can never be in both → **no double scheduling**.
- A **dispatcher** (repeatable job + a cron/sweeper fallback) hands off targets whose `scheduledAt` falls inside a
  configurable horizon (default proposal: 24–48 h): it submits with provider-side `scheduled_date` + timezone, `external_id`,
  stores `providerJobId`, flips the state. Beyond the horizon, nothing is sent, so edits/cancellations stay free.
- Because execution is provider-side after hand-off, **the worker only needs to be alive about once per horizon**, not at
  every publish instant — this removes the reliability weakness of option A while keeping option A's control.
- **Cancel/reschedule before hand-off:** local only. **After hand-off:** call the provider's cancel endpoint **[UNVERIFIED —
  must exist, else the feature degrades to "unpublish after the fact" which is unavailable on TikTok/Instagram/Threads]**; if the
  provider cannot cancel, the UI must say so and handing off becomes opt-in per account.
- **Reconciliation sweeper** (fixes TD-05 for both states): any target past due and neither handed off nor terminal is
  re-dispatched or flagged; any `PROVIDER_*` target without a webhook/terminal update beyond a timeout is polled via
  `status`/`history?external_id=`.
- Time zones: store UTC + the page's IANA timezone; send exactly what the provider documents **[UNVERIFIED]**.

**Duplicate-publication prevention**
- `external_id` = deterministic `ContentTarget.id` (+ `:<n>` only on a deliberate manual re-publish).
- Before any (re)submit of a target lacking a stored provider id (crash window between "request sent" and "id saved"),
  query `GET /history?external_id=…`; if found, adopt it instead of re-posting.
- Unique DB constraint `(provider, externalCorrelationId)`; state transitions guarded by compare-and-set.
- Webhook handler idempotent on delivery id (dedupe table).

## 7. Status synchronization

- **Primary: webhooks.** One public endpoint (`POST /api/webhooks/upload-post`): verify
  `X-Upload-Post-Signature` (HMAC-SHA256 over the **raw body** with the per-credential secret set via
  `users/webhook-secret`) with timing-safe compare; reject stale/replayed deliveries; persist the raw event;
  ack fast (2xx), process asynchronously; dedupe on delivery id; at-least-once safe. Payload schema **[UNVERIFIED]**.
- **Fallback: reconcile poll** for non-terminal targets (`status` by `request_id`/`job_id`) with backoff, plus periodic
  `history` windows to catch missed webhooks (`webhooks/deliveries` + `redeliver` available for recovery).
- Mapping to Socialith states: provider success → `PUBLISHED` (store post id/url per platform); provider
  failure → `FAILED` with the platform's reason in `errorMessage`; partial multi-platform results are tracked
  **per target (one platform account per target)** so a multi-platform request never hides a partial failure.
- Shared-hosting note: a webhook endpoint needs only the API process, so it works even where the worker cannot run.

## 8. Analytics synchronization

- Use **`post-analytics/cached`** (cursor paging, ≤200/page, `platform/since/until`) for bulk sync — exempt from
  the 100-requests/5-minutes cap that applies to live platform analytics.
- Live per-post analytics only on explicit "refresh now" and behind a client-side token bucket (≤100/5 min shared).
- Write into the existing `PostMetricsSnapshot` (append-only, `fetchedAt`), keyed by correlating
  provider post id → `ContentTarget`. Unavailable metrics stay `null`, never `0`.
- `GET /analytics/{profile_username}` for page-level totals into a new per-page snapshot table.
- TikTok `audience` data is TikTok-only; show only where returned.

## 9. Error handling and retry policy

Map Upload-Post HTTP/status results onto the **existing `PublishError` classification** so processors need no change:

| Condition | Code | Retryable | Action |
|---|---|---|---|
| 401/403 (bad/revoked key) | `AUTH_ERROR` | no | Mark credential `INVALID`, alert admin, pause dispatch |
| 400/422 (content rejected, unsupported media) | `CONTENT_ERROR` | no | Fail target with provider message |
| Account not connected / profile missing | `CONFIGURATION_ERROR` | no | Flag mapping drift; require reconnect |
| 429 | `RATE_LIMITED` | yes | Honor `Retry-After`, else exponential backoff with jitter; pause the provider queue |
| 5xx / timeout / network | `PLATFORM_ERROR` / `NETWORK_ERROR` | yes | Backoff; **verify via `history?external_id` before resubmitting** |
| Quota (e.g. Instagram `publishing_limit`, Threads 250/24 h, free tier 10/month) | `RATE_LIMITED` (long delay) | yes | Pre-flight check; reschedule rather than burn attempts |

Attempt caps and backoff reuse the current publishing queue settings (4 attempts, exponential 10 s base),
every attempt recorded as an immutable `PublishAttempt`. Circuit breaker: N consecutive provider-wide failures
opens the breaker for a cool-down and surfaces a banner.

## 10. Rate limits and plan capacity

Documented: platform analytics 100 requests / 5 min (cached analytics exempt); Threads 250 posts + 1000 replies / 24 h;
free tier 10 uploads/month; media list `limit` ≤ 100; AutoDM limits (unused). **Not documented:** general API rate
limit and profiles-per-plan. Therefore: configurable client-side token bucket per credential
(`UPLOAD_POST_RPS`, default conservative), adaptive slowdown on 429, and profile capacity as data (§4).
Per-page/day publish caps are a *Socialith guardrail* (PRD §2), independent of provider limits.

## 11. Platform-specific limitations (do not assume parity)

- Unpublish unsupported on Instagram, TikTok, Threads; edit only on Facebook, LinkedIn, X, YouTube, Google Business.
- Photo/carousel and text support differs per platform; the UI must derive allowed formats per platform from a
  capability table (extend `PLATFORM_CAPABILITIES` with a `provider` dimension), not from a global assumption.
- TikTok: parameters `tiktok_music_id`, `tiktok_location_id` and music search endpoints exist, which **may** enable
  sound attachment that the native API cannot (`NOT_SUPPORTED` today). **[UNVERIFIED]** — confirm direct-post vs inbox mode,
  allowed content settings, and platform/ToS acceptability before promising it.
- **Do not assume Upload-Post removes native platform review or authorization requirements.** Each account is still authorized
  through the platform's own OAuth under that platform's rules, and some requirements (app review, business verification,
  content-disclosure rules, posting limits) may still apply to the account owner or to Socialith. This is a Phase 2 verification
  item, answered from Upload-Post's per-platform documentation and a controlled test account — not from this page.
- Instagram requires Business/Creator accounts; Facebook requires `facebook_page_id`; LinkedIn page targeting; Pinterest boards;
  Google Business needs `gbp_location_id`/post type.
- Scheduling support listed for X, LinkedIn, Facebook, Instagram, TikTok, Bluesky, Threads, Pinterest, YouTube, Discord, Telegram.

## 12. Environment variables (server-side only)

| Variable | Purpose | Required |
|---|---|---|
| `UPLOAD_POST_API_KEY` | bootstrap key (then stored encrypted in DB) | optional if entered via UI |
| `UPLOAD_POST_BASE_URL` | default `https://api.upload-post.com/api` | no |
| `UPLOAD_POST_WEBHOOK_SECRET` | bootstrap HMAC secret (then stored encrypted) | if webhooks enabled |
| `UPLOAD_POST_PROFILE_CAPACITY` | fallback capacity if the API doesn't expose it | no |
| `UPLOAD_POST_RPS` | client-side request ceiling | no |
| `UPLOAD_POST_HANDOFF_HORIZON_HOURS` | scheduling hand-off window | no (default 24–48) |
| `API_PUBLIC_URL` | public base for webhook URL and media URLs (**must be correct in the worker too**) | yes |
| `TOKEN_ENCRYPTION_KEY` | existing vault key | yes |

Never exposed via `NEXT_PUBLIC_*`.

## 13. Implementation roadmap (provider layer only; full plan in IMPLEMENTATION_ROADMAP.md)

0. **Verification with a controlled test account (before any implementation).** Use one dedicated Upload-Post test profile with
   throwaway social accounts; record every real response as a fixture. Each item is closed only with captured evidence:

   | # | Verify | Closes |
   |---|---|---|
   | 1 | API authentication (`Apikey` header, `GET /me`, invalid-key behaviour) | §2 |
   | 2 | Profile sync (`GET /users` shape, pagination, create/delete/rename) | §3 |
   | 3 | Connected platform accounts per profile and how connect/disconnect works (JWT link, `oauth/{platform}/start`) | §3–4 |
   | 4 | **Actual account/profile capacity** (field in `/me`? enforced error when exceeded?) — never assume 225 | §4, §10 |
   | 5 | Video and image publishing (exact multipart/URL params, `platform[]`, titles/descriptions per platform, size limits) | §5 |
   | 6 | Scheduling **and cancellation/reschedule** (paths, `scheduled_date`/timezone semantics, max horizon) | §6 |
   | 7 | Publication history (`history` filters incl. `external_id`) | §6 duplicate protection |
   | 8 | Status synchronization (`status` by `request_id`/`job_id`, per-platform results) | §7 |
   | 9 | Webhooks (event types, payload, signature, retries, `redeliver`) | §7 |
   | 10 | TikTok music (`tiktok_music_id`, search/trending; direct-post vs inbox; policy) | §11 |
   | 11 | Platform-specific restrictions and which native review/authorization requirements still apply | §11 |

   Outcome: this document is updated, every **[UNVERIFIED]** tag is removed or turned into a documented limitation, and only then
   does provider code start.
1. **Provider layer refactor (no behavior change):** provider-keyed registry; move credential resolution into
   providers; keep native providers passing all existing tests.
2. **Data model (additive migrations):** `ProviderCredential`, `ProviderProfile`, `ProviderAccount`,
   `PageAccountAuthorization` (after ManagedPage exists), target provider fields, new target states, webhook event + dedupe tables.
3. **UploadPostProvider:** client, error mapping, upload video/photo, async status, history lookup, retry.
4. **Settings UI + profile sync + mapping UI** (capacity meter).
5. **Webhook endpoint + reconcile sweeper.**
6. **Scheduling dispatcher/hand-off + cancellation.**
7. **Analytics cached sync.**
8. **Hardening:** circuit breaker, quotas, duplicate-publication chaos tests (kill worker mid-submit), load test at 225 profiles.
