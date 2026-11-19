# Upload-Post — API mapping and verification status

How Socialith uses the Upload-Post REST API, field by field, and — separately — how much of each statement is actually proven.

**Evidence levels used below**

| Level | Meaning |
|---|---|
| **DOC** | Stated on the official documentation pages (`docs.upload-post.com`, read 2026-11-19/20 through an automated page reader, so wording is paraphrased and examples may be reconstructed). |
| **DOUBLE** | Exercised by the automated tests against the in-repo contract double (`packages/upload-post/src/mock-server.ts`), which implements the DOC contract. Proves our handling of the documented shapes, **not** that the live service matches them. |
| **LIVE** | Observed against the real service. **Nothing is LIVE yet** — no API key has been available on the development machine. The first LIVE checks are the two read-only calls in `UPLOAD_POST_TESTING.md`. |

Base URL `https://api.upload-post.com/api`; header `Authorization: Apikey <key>` on every call (DOC, DOUBLE). The key is read from the server environment only.

## 1. Endpoints used

| Purpose | Call | Client method | Evidence | Notes |
|---|---|---|---|---|
| Validate key, account, plan | `GET /uploadposts/me` | `getMe`, `ping` | DOC, DOUBLE | Response: `email`, `plan` (`Basic`/`Professional`/`Business`/`Default`), `analyze_shorts{limit,used,remaining,resets_at}`, `preferences`. 401 `{success:false,message:"Invalid or expired token"}`. |
| List profiles + accounts + plan limit | `GET /uploadposts/users` | `listProfiles` | DOC, DOUBLE | `{limit, plan, profiles[]}`. **No pagination documented** — assumed to return all (225 on Business is within one response; to be confirmed LIVE). |
| One profile | `GET /uploadposts/users/{username}` | `getProfile` | DOC, DOUBLE | 404 → `null`. |
| Create profile | `POST /uploadposts/users` | `createProfile` | DOC, DOUBLE | **Not exposed by Socialith in Phase 2** (read-only sync first). 403 `PROFILE_LIMIT_REACHED`, 409 username in use. |
| TikTok publishing settings | `GET /uploadposts/tiktok/settings?profile=` | `getTikTokSettings` | DOC, DOUBLE | `privacy_level_options`, `max_video_post_duration_sec`, `comment/duet/stitch_disabled`. |
| TikTok music — trending | `GET /uploadposts/tiktok/music/trending?profile=&genre=&country_code=&date_range=` | `trendingTikTokMusic` | DOC, DOUBLE | Needs the account capability `music`. Returns **Commercial Music Library charts** only. |
| TikTok music — search | `GET /uploadposts/tiktok/music/search?profile=&q=&…&limit=` | `searchTikTokMusic` | DOC, DOUBLE | `q` ≤ 80 chars. Searches cached chart snapshots, **not** the TikTok catalogue. |
| Publish video | `POST /upload` (multipart) | `publishVideo` | DOC, DOUBLE | See §2. |
| Publish photos | `POST /upload_photos` (multipart) | `publishPhotos` | DOC, DOUBLE | `photos[]` = public HTTPS URLs. |
| Status of a job | `GET /uploadposts/status?request_id=|job_id=` | `getStatus` | DOC, DOUBLE | 404 `not_found` is returned as a status, not thrown. |
| History (find by `external_id`) | `GET /uploadposts/history?external_id=…` | `getHistory` | DOC, DOUBLE | `page`/`limit` pagination (limit ∈ 10/20/50/100). Cursor pagination mentioned on the reference page is **not** on the endpoint page. |
| Scheduled jobs | `GET /uploadposts/schedule` | `listScheduled` | DOC, DOUBLE | Used to resolve an unknown hand-off by `external_id`. |
| Cancel a scheduled job | `DELETE /uploadposts/schedule/{job_id}` | `cancelScheduled` | DOC, DOUBLE | Credits refunded only if not started. 404 = already gone (treated as success). |
| Edit a scheduled job | `PATCH /uploadposts/schedule/{job_id}` | `editScheduled` | DOC, DOUBLE | `scheduled_date`/`timezone`/`title`/`caption`. Media/profile/platforms cannot change. 409 `scheduled_post_in_progress` when running or due in < 60 s. |

Endpoints that exist but are **deliberately unused** in Phase 2: analytics, comments/DMs/AutoDM, queue slots (`add_to_queue`), retry/unpublish/edit-post, notifications/webhook-subscription management, JWT connect links, team/approvals (documented as not generally available).

## 2. Publishing fields

Common (DOC for names/semantics; DOUBLE for our use): `user` = profile `username` · `platform[]` = exactly one platform key per Socialith target · `video` (URL) or `photos[]` (URLs) ·
`title` · `description` · `external_id` (≤ 255) · `request_id` · `async_upload=true` · `scheduled_date` (ISO-8601, future, ≤ 365 days) + `timezone` (we send UTC) · header `Idempotency-Key` (24 h dedupe) and `X-External-Id`.

| Socialith → provider | Rule | Evidence |
|---|---|---|
| Correlation | `external_id = socialith:target:<ContentTarget.id>:g<generation>`; never the title (the docs call the title editable) | DOC, DOUBLE |
| Timeout handling | provider's own advice: never resend after a timeout without checking → Socialith asks `GET /status?request_id=` first | DOC (advice), DOUBLE (behaviour) |
| TikTok | `tiktok_title` = caption (≤ 2200); `tiktok_music_id` only when mapping is usable (see Integration §A.6). Privacy/other TikTok fields are **not** sent → account defaults apply | DOC (names), DOUBLE |
| YouTube | `youtube_title` (≤ 100, falls back to first caption line, else "Untitled"); `description` = caption (≤ 5000) | DOC (names), DOUBLE |
| Instagram | `title` = caption; no extra fields | DOC (names), DOUBLE |
| Not sent (provider defaults apply) | privacy levels, covers, collaborators, location, `media_type`, first comment, AI-generated flags, etc. | — |

Responses (DOC, DOUBLE): sync `200 {results{platform{success,url,post_id,error}},usage}` · async `200 {request_id,total_platforms}` · scheduled `202 {job_id,scheduled_date}`.
A platform not connected to the profile is **skipped** (`results[platform].skipped=true`, `skip_reason`) and the request still succeeds; if none is connected → 400. Socialith treats a skipped result for its target as a failure.
TikTok may answer `fallback_to_inbox` (delivered to drafts, **not live**): Socialith marks the target PUBLISHED **with a `deliveryNote`** saying it is not live until published in the TikTok app.

## 3. Statuses

Top-level `status` ∈ `pending`, `queued`, `processing`, `in_progress`, `completed`, `failed`, `not_found`. Per-platform `status` ∈ `queued`, `processing`, `completed`, `failed`, `retryable`, `skipped` (DOC).
Mapping (`apps/worker/src/upload-post/status.ts`, DOUBLE): in-flight states keep the target PUBLISHING/SCHEDULED; `completed` + successful result for **our** platform → PUBLISHED; `failed`, or completed without a successful result for our platform, or `skipped` → FAILED (provider reason kept); `not_found` → unchanged (the caller decides). `retryable` is treated as in-flight (the provider retries by itself).
A job unresolved 6 h after it was due, or processing 6 h after submission, is failed as *unconfirmed* with an explicit message (never silently republished). The provider documents that it fails a job with no activity for > 1 h.

## 4. Errors → Socialith behaviour

| Provider signal | Client kind | Worker `PublishError` | Retry | Account flagged? |
|---|---|---|---|---|
| 401 | `AUTH` | `CONFIGURATION_ERROR` | no | no (our key, not the account) |
| 403 (plan, profile limit, blocked) / 429 with `usage` or `SCHEDULED_POSTS_LIMIT` | `FORBIDDEN_PLAN` / `QUOTA_EXCEEDED` | `CONFIGURATION_ERROR` | no | no |
| 400/409 with `tiktok_reconnect_required`, `reauth_required`, `account_reauth_required`, `facebook_reauth_required`, `account_checkpoint_required` or `reauth_required:true` | `REAUTH_REQUIRED` | `AUTH_ERROR` | no | **yes** (destination `ERROR`) |
| other 400 / 409 | `VALIDATION` / `CONFLICT` | `CONTENT_ERROR` | no | no |
| 404 | `NOT_FOUND` | `CONFIGURATION_ERROR` | no | no |
| 429 (no usage) | `RATE_LIMITED` (+`Retry-After` / `retry_after(_seconds)`) | `RATE_LIMITED` | yes, after the delay | no |
| timeout / connection error | `TIMEOUT` / `NETWORK` (`outcomeUnknown` for writes) | `NETWORK_ERROR` | yes, after asking the provider | no |
| 5xx | `SERVER` | `PLATFORM_ERROR` | yes | no |

Reads are retried inside the client (≤ 2 extra attempts, exponential back-off, `Retry-After` honoured when ≤ 10 s; longer waits are surfaced to the queue, never slept). Writes are **never** retried inside the client.
Error body shape `{success:false, message, error_code}` (DOC; some endpoints use `error`). Messages copied from a body are truncated to 300 chars and have the API key redacted.

## 5. Webhooks (DOC; verification logic DOUBLE-tested with generated signatures)

Headers: `X-Upload-Post-Signature: sha256=<hex>` (only when a secret exists), `X-Upload-Post-Timestamp` (unix s), `X-Upload-Post-Event`, `X-Upload-Post-Delivery` (same across retries), `X-Upload-Post-Attempt` (1–6).
Signed string `"<timestamp>.<raw body>"`, HMAC-SHA256 with the signing secret, hex, `sha256=` prefix. Socialith: verifies against the **raw bytes**, rejects timestamps > 5 min off, constant-time compare, accepts a current and a previous secret (rotation), de-duplicates on the delivery id, answers 5xx when it cannot queue (so the provider retries).
Events used: `upload_completed` (outcome is in the payload, no separate failure event), `social_account_connected|disconnected|reauth_required` → trigger a re-sync. Others are acknowledged and ignored.

## 6. Unverified assumptions and open questions (resolve LIVE before relying on them)

1. **`GET /users` returns every profile in one response** (no pagination documented). Check with the real profile count.
2. **The exact `upload_completed` payload.** Documented: `result.success`/`result.error`; not documented: where `request_id`/`job_id`/`external_id` sit. The parser looks at top level, `result` and `data`, and the payload is only a *hint* — the worker always re-reads `GET /status` — so a different shape degrades to "polling does the work", not to a wrong state.
3. **`GET /status?request_id=` for a job created with a schedule.** Socialith uses `job_id` for scheduled jobs and `request_id` for immediate ones; whether a `request_id` we supplied also resolves a scheduled job is undocumented.
4. **When the provider fetches media for a scheduled job** (at scheduling time or at run time). Until known, Socialith never hands a presigned (≈ 1 h) media URL to the provider scheduler.
5. **Instagram/YouTube field names beyond the title mapping** and per-platform behaviour of `description`. Only the fields in §2 are sent.
6. **`reauth_required` flag latency**: how soon after a token expires `GET /users` reports it (affects how early the dashboard warns).
7. **Webhook delivery of `social_account_*` events** requires them to be enabled in the provider dashboard (`UPLOAD_POST_SETUP.md`).
8. **Plan limits** (monthly uploads, pending scheduled posts 5 000–50 000 by plan) are provider-enforced; Socialith only reports the profile limit and surfaces refusals.
9. Documentation inconsistencies noted: `external_id` max 255 (upload) vs ≤ 200 (history filter); `created_at` has two timestamp formats (both parsed); the reference page mentions cursor pagination that the history endpoint page does not document.
