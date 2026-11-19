# YouTube (Google) setup

Socialith connects YouTube channels via **Google OAuth 2.0** (server-side
web flow, offline access) and publishes via the **YouTube Data API v3**.
Implementation: `apps/api/src/oauth/providers/youtube.oauth-provider.ts`
(connect) and `apps/worker/src/publishing/providers/youtube.provider.ts`
(publish).

## 1. Create a Google Cloud project + OAuth client

1. Go to [console.cloud.google.com](https://console.cloud.google.com/) → create/select a project.
2. **APIs & Services → Library**: enable the **YouTube Data API v3**.
3. **APIs & Services → OAuth consent screen**: configure it (External, unless
   you're using Google Workspace). Add the `youtube.upload` and
   `youtube.readonly` scopes (or whatever this app requests — see below).
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID**,
   type **Web application**. Add an **Authorized redirect URI** (must
   exactly match what Socialith computes — see step 3 below).
5. Copy the **Client ID** and **Client secret**.

## 2. Environment variables

```bash
GOOGLE_CLIENT_ID="<Client ID from Google Cloud Console>"
GOOGLE_CLIENT_SECRET="<Client secret from Google Cloud Console>"
# Optional — only set if your Google OAuth client's registered redirect
# URI is NOT the default computed one (see below).
GOOGLE_REDIRECT_URI=""
```

The default redirect URI (used when `GOOGLE_REDIRECT_URI` is unset) is:

```
${API_PUBLIC_URL or http://localhost:<API_PORT>}/api/oauth/youtube/callback
```

## 3. Offline access (critical)

Socialith's authorization request always includes `access_type=offline`
and `prompt=consent`, so Google issues a real `refresh_token` — required
for scheduled publishing to work while the connecting user isn't present.
**If you ever manually re-test this flow outside Socialith's own
`/api/oauth/youtube/start` redirect** (e.g. via Google's OAuth Playground),
make sure to include the same two parameters, or Google will silently omit
the refresh token on a repeat consent. Socialith's own provider throws a
real `CONFIGURATION_ERROR` if Google's response has no `refresh_token`,
rather than silently accepting an access-only connection that would
degrade to "works once, then requires the user to reconnect."

## 4. App verification

The `youtube.upload` scope is a Google **restricted scope**. During
development, it works for your project's own registered test users
(added under OAuth consent screen → Test users). Publishing on behalf of
any other Google account requires submitting the OAuth consent screen for
**verification** — see `GET /api/platform-capabilities` for the current,
honest capability status (`REQUIRES_APPROVAL`) reflected in the running app.

## 5. Known limitations

- No share-count metric exists in the YouTube Data API's `statistics`
  part — only view/like/comment counts are pulled.
- YouTube has no photo-post content type and no sound/music-library
  concept comparable to TikTok's.
