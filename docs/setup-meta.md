# Meta (Instagram) setup

Socialith connects Instagram accounts via **Facebook Login** (Meta's
OAuth) and publishes via the **Instagram Graph API**. Implementation:
`apps/api/src/oauth/providers/instagram.oauth-provider.ts` (connect) and
`apps/worker/src/publishing/providers/instagram.provider.ts` (publish).

## 1. Prerequisites on the Instagram side

The Instagram account you connect must be:
- A **professional account** (Business or Creator), not a personal account.
- Linked to a **Facebook Page** you administer. Socialith's connect flow
  looks up your Facebook Pages and picks the one with a linked Instagram
  Business Account — if none exists, connecting fails with a clear
  `CONFIGURATION_ERROR`, not a silent partial connection.

## 2. Create a Meta app

1. Go to [developers.facebook.com](https://developers.facebook.com/) → **My Apps** → **Create App** (type: **Business**).
2. Add the **Facebook Login** product.
3. Under Facebook Login → Settings, add a **Valid OAuth Redirect URI**
   (must exactly match what Socialith computes — see step 4).
4. Under **App Settings → Basic**, copy the **App ID** and **App Secret**.
5. Add the **Instagram Graph API** capability (via the Instagram product,
   or it may already be available under your Business app).

## 3. App Review

`instagram_content_publish` (required for real publishing) is a
Meta-restricted permission. During development, it works for the app's
own admins/testers/developers (Standard Access). Publishing on behalf of
any other account requires submitting your app for **App Review** with
Meta — see `GET /api/platform-capabilities` for the current, honest
capability status (`REQUIRES_APPROVAL`) reflected in the running app.

## 4. Environment variables

```bash
META_APP_ID="<App ID from App Settings → Basic>"
META_APP_SECRET="<App Secret from App Settings → Basic>"
# Optional — only set if your Meta app's registered redirect URI is NOT
# the default computed one (see below).
META_REDIRECT_URI=""
```

The default redirect URI (used when `META_REDIRECT_URI` is unset) is:

```
${API_PUBLIC_URL or http://localhost:<API_PORT>}/api/oauth/instagram/callback
```

## 5. Token lifecycle notes

Meta's long-lived user token (60 days) has no separate `refresh_token` —
it's extended via re-exchanging itself (`fb_exchange_token`), which
`apps/worker/src/publishing/token.ts` already implements. The scheduled
token-refresh worker (`token-refresh-scan`) proactively re-exchanges it
before expiry so a scheduled publish never needs the connecting user to
be present.

## 6. Known limitations

- Reach/impressions/saves/shares analytics require the separate
  `/insights` edge and additional permissions this app does not request —
  only `like_count`/`comments_count` are pulled today (see the capability
  matrix, `PARTIAL`).
- No sound/music-attachment concept exists in the Graph API's media
  container fields.
