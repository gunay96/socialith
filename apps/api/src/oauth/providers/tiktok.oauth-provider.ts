import { OAuthError, type ConnectedAccountMetadata, type ExchangedToken, type OAuthProvider } from "../types.js";

const AUTHORIZE_URL = "https://www.tiktok.com/v2/auth/authorize/";
const TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";
const USER_INFO_URL = "https://open.tiktokapis.com/v2/user/info/";

/**
 * TikTok Login Kit — verified against developers.tiktok.com (2026-09):
 *   - Authorize: GET https://www.tiktok.com/v2/auth/authorize/
 *     (client_key, scope, response_type=code, redirect_uri, state,
 *     code_challenge, code_challenge_method=S256)
 *   - Token exchange / refresh: POST https://open.tiktokapis.com/v2/oauth/token/,
 *     form-urlencoded, same endpoint for both grant types.
 *   - PKCE (`code_challenge`/`code_verifier`) — the general Login Kit docs
 *     don't call this out for a server-side web client, but a real, live
 *     request against this exact endpoint with this project's real
 *     registered app credentials was rejected for a missing
 *     `code_challenge` (verified during this phase's real E2E pass, not
 *     assumed). `requiresPkce = true` reflects that live, verified
 *     behavior over the (apparently stale/incomplete) general docs.
 *   - This project's real, registered TikTok app requests `video.upload`
 *     + `video.list`, not `video.publish` — confirmed against the actual
 *     app configuration, not assumed. `video.upload` authorizes
 *     apps/worker/src/publishing/providers/tiktok.provider.ts's real
 *     Upload/Inbox flow (POST /v2/post/publish/inbox/video/init/);
 *     `video.list` authorizes that same file's Query Video analytics
 *     call (POST /v2/video/query/) — verified directly against
 *     developers.tiktok.com/doc/tiktok-api-v2-video-query, which
 *     documents `video.list` (not `video.publish`) as that endpoint's
 *     required scope. `user.info.*` scopes are what let Get User Info
 *     return profile/stats fields, used to populate SocialAccount's
 *     handle/displayName/avatarUrl/followerCount on connect.
 */
export class TikTokOAuthProvider implements OAuthProvider {
  readonly platform = "TIKTOK" as const;
  readonly requiresPkce = true;

  constructor(
    private readonly clientKey: string,
    private readonly clientSecret: string,
  ) {}

  buildAuthorizationUrl(state: string, redirectUri: string, pkce?: { codeChallenge: string }): string {
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("client_key", this.clientKey);
    url.searchParams.set("scope", "user.info.basic,user.info.profile,user.info.stats,video.list,video.upload");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    if (pkce) {
      url.searchParams.set("code_challenge", pkce.codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
    }
    return url.toString();
  }

  async exchangeCode(code: string, redirectUri: string, pkce?: { codeVerifier: string }): Promise<ExchangedToken> {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_key: this.clientKey,
        client_secret: this.clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
        ...(pkce ? { code_verifier: pkce.codeVerifier } : {}),
      }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
      error?: string;
      error_description?: string;
    };
    if (!res.ok || !body.access_token) {
      throw new OAuthError(
        `TikTok token exchange failed: ${body.error_description ?? body.error ?? res.statusText}`,
        res.status === 401 || res.status === 403 ? "AUTH_ERROR" : "PLATFORM_ERROR",
      );
    }
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? null,
      expiresAt: body.expires_in ? new Date(Date.now() + body.expires_in * 1000) : null,
      scopes: body.scope ? body.scope.split(",") : [],
    };
  }

  async fetchAccountMetadata(accessToken: string, _exchanged: ExchangedToken): Promise<ConnectedAccountMetadata> {
    const url = new URL(USER_INFO_URL);
    url.searchParams.set("fields", "open_id,display_name,username,avatar_url,follower_count");
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    const body = (await res.json().catch(() => ({}))) as {
      data?: {
        user?: {
          open_id?: string;
          display_name?: string;
          username?: string;
          avatar_url?: string;
          follower_count?: number;
        };
      };
      error?: { code?: string; message?: string };
    };
    const user = body.data?.user;
    if (!res.ok || !user?.open_id) {
      throw new OAuthError(`TikTok user info fetch failed: ${body.error?.message ?? res.statusText}`, "PLATFORM_ERROR");
    }
    return {
      externalAccountId: user.open_id,
      handle: user.username ? `@${user.username}` : user.open_id,
      displayName: user.display_name ?? user.username ?? user.open_id,
      avatarUrl: user.avatar_url ?? null,
      followerCount: user.follower_count ?? null,
      providerMetadata: { username: user.username },
    };
  }
}
