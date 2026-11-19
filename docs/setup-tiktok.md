# TikTok setup

Socialith connects TikTok accounts via **TikTok Login Kit** (OAuth, with
PKCE) and uploads content via the Content Posting API's **Upload/Inbox
flow**. Implementation:
`apps/api/src/oauth/providers/tiktok.oauth-provider.ts` (connect) and
`apps/worker/src/publishing/providers/tiktok.provider.ts` (upload +
status polling).

## 1. Create a TikTok developer app

1. Go to [developers.tiktok.com](https://developers.tiktok.com/) → **Manage apps** → **Create an app**.
2. Add these products to the app:
   - **Login Kit** — required for OAuth connect.
   - **Content Posting API** — required for uploading. TikTok requires
     your app to be approved for the specific scopes below before they
     work for real users outside your own registered test users — see
     `GET /api/platform-capabilities` in the running app for the exact,
     current capability status.
3. Under Login Kit's settings, add a **Redirect URI**. It must exactly
   match what Socialith computes (see step 3 below).
4. Copy the app's **Client key** and **Client secret**.

## 2. Scopes

Socialith requests exactly:
`user.info.basic,user.info.profile,user.info.stats,video.list,video.upload`.

Request all five in your app's scope configuration in the TikTok
developer console, or connecting will fail with a scope-mismatch error
from TikTok. Every scope maps to a real, used feature — nothing here is
requested speculatively:

| Scope | Used by | Endpoint | Stored as | Shown in |
|---|---|---|---|---|
| `user.info.basic` | Connect flow | `GET /v2/user/info/` (`open_id`, `avatar_url`) | `SocialAccount.externalAccountId`, `avatarUrl` | Accounts list/detail avatar |
| `user.info.profile` | Connect flow | `GET /v2/user/info/` (`display_name`, `username`) | `SocialAccount.displayName`, `handle` | Accounts list/detail name/handle |
| `user.info.stats` | Connect flow | `GET /v2/user/info/` (`follower_count`) | `SocialAccount.followerCount` | Accounts list/detail follower count |
| `video.list` | Analytics sync | `POST /v2/video/query/` | `PostMetricsSnapshot` | Content detail's per-target metrics, Dashboard's top content/sounds |
| `video.upload` | Publishing | `POST /v2/post/publish/inbox/video/init/` + `POST /v2/post/publish/status/fetch/` | `ContentTarget`/`PublishAttempt` | Content detail's target row (status, delivery note) |

## 3. Environment variables

```bash
TIKTOK_CLIENT_KEY="<client key from the developer console>"
TIKTOK_CLIENT_SECRET="<client secret from the developer console>"
# Optional — only set if your TikTok app's registered redirect URI is
# NOT the default computed one (see below).
TIKTOK_REDIRECT_URI=""
```

The default redirect URI (used when `TIKTOK_REDIRECT_URI` is unset) is:

```
${API_PUBLIC_URL or http://localhost:<API_PORT>}/api/oauth/tiktok/callback
```

Register exactly that URL in the TikTok developer console (for
production, the real one is `https://<your-api-domain>/api/oauth/tiktok/callback`),
or set `TIKTOK_REDIRECT_URI` to match whatever you registered instead.

## 4. Connect flow

Once the two env vars are set and the API is restarted, the "Connect
TikTok" button on `/accounts` becomes a real, working OAuth flow
(`GET /api/oauth/tiktok/start` → TikTok's consent screen →
`GET /api/oauth/tiktok/callback`). Without them, the button still
appears, but the connect attempt fails with a `CONFIGURATION_ERROR` —
never a fabricated success. PKCE (`code_challenge`/`code_verifier`,
S256) is used automatically — TikTok's real authorize endpoint rejects
this app's requests without it, confirmed live against this project's
actual registered credentials.

## 5. Known limitations (verified against the real, live API — not assumed)

- **This is the Upload/Inbox flow, not Direct Post.** A successfully
  uploaded video is delivered to the connected account's **TikTok inbox
  as a draft** — it is not live/public yet. The authorizing user must
  open the TikTok app, find the notification, and manually finish
  posting it there. Socialith's own responsibility ends at successful
  delivery; the content-detail target row shows a real "Sent — action
  required" badge and delivery note rather than a plain "Published",
  and no external post URL is shown (there isn't a public one yet).
- **No caption/title in the request.** TikTok's Upload API has no
  post_info/title field for video at all — a caption prepared in
  Socialith is not transmitted; the user must add it themselves when
  finishing the post in TikTok's app. `PublishAttempt.responseMetadata`
  records `captionNotTransmitted: true` on every real upload.
- **Analytics only work after the user manually finishes the post.**
  `video.list`'s `Query Video` endpoint only returns data for the
  account's actual public videos — a draft still sitting in the inbox
  has no queryable stats yet. Clicking "Sync analytics" on a just-sent
  target will legitimately report nothing until the user completes it.
- **Rate limit**: TikTok documents "at most 5 pending shares within any
  24-hour period" per authorizing user for this endpoint.
- **Sound attachment**: neither Upload/Inbox nor Direct Post has a
  `sound_id`/`music_id` field. A `Sound` selected on a piece of content
  is tracked for campaign/analytics purposes only — see the capability
  matrix.
- **Async status**: the upload call only *initiates* delivery and
  returns a `publish_id`; Socialith polls
  `POST /v2/post/publish/status/fetch/` (every 15s, up to ~5 minutes)
  until TikTok reports a real terminal state (`SEND_TO_USER_INBOX` or
  `FAILED`) — see `apps/worker/src/processors/publish-status-poll.processor.ts`.

## 6. App Review

TikTok's App Review requires the `video.upload` scope itself to be
approved before it works for any TikTok account other than your app's
own registered test users. Until approved, only accounts you've added as
testers in the TikTok developer console can complete a real connect +
upload. See the project's App Review readiness report for the exact demo
flow, required Portal settings, and current blockers.
