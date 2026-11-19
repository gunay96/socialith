# Socialith — Integration Status

Evidence tags as in PROJECT_AUDIT.md. "Implemented" means code + unit tests against
**mocked HTTP**; it does **not** mean proven against the real platform. Nothing below has
yet performed a real publish.

## Summary matrix

| Integration | Auth/connect | Publish | Status poll | Analytics | Verified live | Blocking external item |
|---|---|---|---|---|---|---|
| **TikTok native — `video.upload`** (Upload/Inbox) | OAuth+PKCE implemented | `POST /v2/post/publish/inbox/video/init/` (PULL_FROM_URL) implemented | `SEND_TO_USER_INBOX` terminal state implemented | `video.list` Query Video implemented | Authorize redirect only (2026-09-22) | App Review for `video.upload`; Portal redirect URI + Web/Desktop URL on a **stable verified domain**; unexplained Portal "1 error" + authorize-time `client_key` error unresolved; secret rotation |
| **TikTok native — `video.publish`** (Direct Post) | not requested | **Not implemented** (code was removed in favor of Upload/Inbox); `PUBLISH_COMPLETE` branch kept for forward-compat only | polling code present | — | No | Separate audit/approval (per TikTok's published rules that unaudited clients are restricted — not re-verified today) |
| **Instagram native** | Facebook Login OAuth implemented | Graph media-container + publish implemented | n/a (synchronous) | basic counts only (no insights) | No | Meta app credentials (vars empty), Business/Creator account + FB Page, `instagram_content_publish` via App Review (Advanced Access) |
| **YouTube native** | Google OAuth implemented | resumable upload implemented | n/a | implemented | No | Google OAuth client + consent-screen verification for restricted `youtube.upload` |
| **Upload-Post** | **None** | **None** | **None** | **None** | No | Business-plan API key; see UPLOAD_POST_INTEGRATION.md |
| AI captions (OpenAI-compatible) | key via env | n/a | n/a | token/cost metadata | No | Valid provider key (not verified) |
| Cloudflare R2 | env vars | upload/presign abstraction implemented | — | — | No | Bucket + keys (unconfigured) |
| Email | — | `console` only | — | — | n/a | Real provider (TD-06) |
| Webhooks (inbound) | **None** | — | — | — | — | Needed by Upload-Post design |

## Native providers in detail

### TikTok
- Scopes requested: `user.info.basic, user.info.profile, user.info.stats, video.list, video.upload`.
- Publishing is *inbox delivery*: the video lands in the user's TikTok inbox as a draft;
  the user must finish the post in the TikTok app; **no caption is transmitted**
  (`captionNotTransmitted`). `ContentTarget.deliveryNote` records this honestly.
- Sound attachment: `NOT_SUPPORTED` by the official API (no `sound_id` field).
- Required, not yet done: register `https://<stable-domain>/api/oauth/tiktok/callback`,
  Web/Desktop URL, domain/URL-prefix verification (needed for `PULL_FROM_URL` too), App Review demo video,
  resolve Portal error, rotate secret.
- Placeholders vs real: all request/response handling is real code (int64-safe parsing,
  status states, error classification); **all of it is unproven against live TikTok**.

### Instagram
- Real container→publish flow; permission list in `instagram.oauth-provider.ts`
  (`instagram_basic, instagram_content_publish, pages_show_list, pages_read_engagement`).
- Meta app credentials absent; redirect URI would be `<domain>/api/oauth/instagram/callback`.
- No insights permission → reach/impressions/saves unavailable.

### YouTube
- Real resumable upload; `youtube.upload` restricted scope. Not on the owner's near-term list.

## Upload-Post compatibility (preliminary — see UPLOAD_POST_INTEGRATION.md)

- The current `PublishingProvider` contract is **platform-keyed** (`resolvePublishingProvider(platform)`)
  and requires a per-account OAuth `accessToken`. Upload-Post accounts have no tokens in Socialith
  (the provider holds them) → **not compatible as-is**; needs a provider-keyed registry (TD-09).
- The *shape* of the existing result types (`PublishSuccess`, `PublishStatusResult`,
  `PublishError` with retryable classification, `pendingConfirmation` async pattern) maps well
  onto Upload-Post's async `request_id` flow and can be reused unchanged.
- Placeholder status of `PublishAttempt` / `ContentTarget` fields: `externalPostId` can hold
  the provider post id; **new fields are needed** for provider job id, `external_id` correlation
  and provider name.

## Permissions / approvals checklist (what the owner must obtain)

1. TikTok: App Review (`video.upload`), stable verified domain, secret rotation.
2. Meta: developer app, App Review for `instagram_content_publish`, business verification as required.
3. Google: OAuth client, consent-screen verification (only if YouTube native is kept).
4. Upload-Post: API key (Business plan), webhook secret, confirm per-platform publishing mode
   (e.g. whether TikTok is direct-post or inbox) in their per-platform docs.
5. R2 bucket + keys; transactional email provider.
