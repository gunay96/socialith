import { OAuthError, type ConnectedAccountMetadata, type ExchangedToken, type OAuthProvider } from "../types.js";

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPES = "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly";

/**
 * Google OAuth 2.0 server-side web flow for YouTube — verified against
 * developers.google.com (2026-09). `access_type=offline` + `prompt=consent`
 * is what guarantees a refresh_token comes back (Google only issues one
 * on the *first* consent unless prompt=consent forces re-issuance) —
 * required per this phase's explicit "offline access / refresh token"
 * requirement, since scheduled publishing must work while the connecting
 * user isn't present in a browser.
 */
export class YouTubeOAuthProvider implements OAuthProvider {
  readonly platform = "YOUTUBE" as const;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
  ) {}

  buildAuthorizationUrl(state: string, redirectUri: string): string {
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", SCOPES);
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("state", state);
    return url.toString();
  }

  async exchangeCode(code: string, redirectUri: string): Promise<ExchangedToken> {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
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
        `YouTube token exchange failed: ${body.error_description ?? body.error ?? res.statusText}`,
        res.status === 401 || res.status === 400 ? "AUTH_ERROR" : "PLATFORM_ERROR",
      );
    }
    if (!body.refresh_token) {
      // A user who has authorized this app before, without revoking
      // access, can get a consent screen that still omits a refresh
      // token even with prompt=consent in rare cases — surfaced as a
      // real, actionable configuration error rather than silently
      // storing an access-only connection that will stop working the
      // moment the access token expires.
      throw new OAuthError(
        "Google did not return a refresh token. Revoke this app's access in your Google Account permissions and reconnect.",
        "CONFIGURATION_ERROR",
      );
    }
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: body.expires_in ? new Date(Date.now() + body.expires_in * 1000) : null,
      scopes: body.scope ? body.scope.split(" ") : [],
    };
  }

  async fetchAccountMetadata(accessToken: string): Promise<ConnectedAccountMetadata> {
    const res = await fetch("https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const body = (await res.json().catch(() => ({}))) as {
      items?: {
        id: string;
        snippet?: { title?: string; thumbnails?: { default?: { url?: string } } };
        statistics?: { subscriberCount?: string };
      }[];
      error?: { message?: string };
    };
    const channel = body.items?.[0];
    if (!res.ok || !channel) {
      throw new OAuthError(`YouTube channel lookup failed: ${body.error?.message ?? res.statusText}`, "PLATFORM_ERROR");
    }
    return {
      externalAccountId: channel.id,
      handle: channel.snippet?.title ?? channel.id,
      displayName: channel.snippet?.title ?? channel.id,
      avatarUrl: channel.snippet?.thumbnails?.default?.url ?? null,
      followerCount: channel.statistics?.subscriberCount ? Number(channel.statistics.subscriberCount) : null,
      providerMetadata: {},
    };
  }
}
