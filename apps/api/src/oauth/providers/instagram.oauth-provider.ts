import { OAuthError, type ConnectedAccountMetadata, type ExchangedToken, type OAuthProvider } from "../types.js";

const GRAPH_API_BASE = "https://graph.facebook.com/v26.0";

interface MetaErrorBody {
  error?: { message?: string; code?: number };
}

/**
 * Instagram via Meta's "Facebook Login" path — verified against
 * developers.facebook.com (2026-09, Graph API v26.0, current as of this
 * phase). Meta also offers a newer "Instagram Login" (Business Login for
 * Instagram) flow that can skip the Facebook Page requirement for some
 * accounts; its exact current endpoints couldn't be verified with the
 * same confidence during this phase's research (see final report), so
 * the well-documented Facebook Login path is what's implemented — an
 * Instagram professional account must be connected to a Facebook Page,
 * modeled explicitly below rather than assumed away.
 *
 * Flow: authorize -> short-lived user token -> exchange for a long-lived
 * user token (60 days) -> list the user's Pages -> find the Page with a
 * linked Instagram Business Account -> use that PAGE's access token
 * (inherits the long-lived user token's validity, and survives the
 * user's own session ending, which matches "publish while the connecting
 * user isn't present" — see PlatformConnection.encryptedAccessToken).
 */
export class InstagramOAuthProvider implements OAuthProvider {
  readonly platform = "INSTAGRAM" as const;

  constructor(
    private readonly appId: string,
    private readonly appSecret: string,
  ) {}

  buildAuthorizationUrl(state: string, redirectUri: string): string {
    const url = new URL("https://www.facebook.com/v26.0/dialog/oauth");
    url.searchParams.set("client_id", this.appId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("scope", "instagram_basic,instagram_content_publish,pages_show_list,pages_read_engagement");
    url.searchParams.set("response_type", "code");
    return url.toString();
  }

  async exchangeCode(code: string, redirectUri: string): Promise<ExchangedToken> {
    const shortLived = await this.getAccessToken({
      client_id: this.appId,
      client_secret: this.appSecret,
      redirect_uri: redirectUri,
      code,
    });

    const longLived = await this.getAccessToken({
      grant_type: "fb_exchange_token",
      client_id: this.appId,
      client_secret: this.appSecret,
      fb_exchange_token: shortLived.access_token,
    });

    return {
      accessToken: longLived.access_token,
      // Meta's long-lived user token is itself the input to its next
      // refresh exchange — see apps/worker/src/publishing/token.ts's
      // Instagram branch, which already implements this. No separate
      // refresh_token exists for this flow.
      refreshToken: longLived.access_token,
      expiresAt: longLived.expires_in ? new Date(Date.now() + longLived.expires_in * 1000) : null,
      scopes: ["instagram_basic", "instagram_content_publish", "pages_show_list", "pages_read_engagement"],
    };
  }

  private async getAccessToken(params: Record<string, string>): Promise<{ access_token: string; expires_in?: number }> {
    const url = new URL(`${GRAPH_API_BASE}/oauth/access_token`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url);
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number } & MetaErrorBody;
    if (!res.ok || !body.access_token) {
      throw new OAuthError(
        `Instagram token exchange failed: ${body.error?.message ?? res.statusText}`,
        body.error?.code === 190 ? "AUTH_ERROR" : "PLATFORM_ERROR",
      );
    }
    return { access_token: body.access_token, expires_in: body.expires_in };
  }

  async fetchAccountMetadata(userAccessToken: string, _exchanged: ExchangedToken): Promise<ConnectedAccountMetadata> {
    const pagesRes = await fetch(
      `${GRAPH_API_BASE}/me/accounts?fields=id,name,access_token,instagram_business_account&access_token=${encodeURIComponent(userAccessToken)}`,
    );
    const pagesBody = (await pagesRes.json().catch(() => ({}))) as {
      data?: { id: string; name: string; access_token: string; instagram_business_account?: { id: string } }[];
    } & MetaErrorBody;
    if (!pagesRes.ok) {
      throw new OAuthError(`Instagram Pages lookup failed: ${pagesBody.error?.message ?? pagesRes.statusText}`, "PLATFORM_ERROR");
    }

    const pageWithIg = pagesBody.data?.find((p) => p.instagram_business_account);
    if (!pageWithIg?.instagram_business_account) {
      throw new OAuthError(
        "No Facebook Page with a linked Instagram professional account was found for this user. Instagram publishing requires a Page-linked Instagram Business or Creator account.",
        "CONFIGURATION_ERROR",
      );
    }

    const igId = pageWithIg.instagram_business_account.id;
    const igRes = await fetch(
      `${GRAPH_API_BASE}/${igId}?fields=username,name,profile_picture_url,followers_count&access_token=${encodeURIComponent(pageWithIg.access_token)}`,
    );
    const igBody = (await igRes.json().catch(() => ({}))) as {
      username?: string;
      name?: string;
      profile_picture_url?: string;
      followers_count?: number;
    } & MetaErrorBody;
    if (!igRes.ok) {
      throw new OAuthError(`Instagram account lookup failed: ${igBody.error?.message ?? igRes.statusText}`, "PLATFORM_ERROR");
    }

    return {
      externalAccountId: igId,
      handle: igBody.username ? `@${igBody.username}` : igId,
      displayName: igBody.name ?? igBody.username ?? igId,
      avatarUrl: igBody.profile_picture_url ?? null,
      followerCount: igBody.followers_count ?? null,
      // Public-ish trivia only — the real credential (the Page access
      // token) goes through effectiveAccessToken below, never through
      // this unencrypted field.
      providerMetadata: { facebookPageId: pageWithIg.id },
      // Instagram publishing uses the linked Page's access token, not the
      // user token exchangeCode() returned — see this class's doc comment.
      effectiveAccessToken: pageWithIg.access_token,
    };
  }
}
