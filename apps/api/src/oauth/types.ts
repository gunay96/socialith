import type { Platform } from "@socialith/database";

export interface ExchangedToken {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scopes: string[];
}

export interface ConnectedAccountMetadata {
  externalAccountId: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  followerCount: number | null;
  /** Public-ish profile trivia only — never a credential (see schema.prisma's SocialAccount.providerMetadata: this field is returned in plain API responses). */
  providerMetadata: Record<string, unknown>;
  /**
   * Overrides the token from exchangeCode() when the platform's real
   * publishing credential isn't the token exchangeCode() returned —
   * Instagram's case: publishing needs the linked Facebook Page's access
   * token, not the user token. Encrypted into PlatformConnection exactly
   * like exchangeCode()'s token would be; never placed in
   * providerMetadata above, which is not encrypted and is returned as-is
   * in API responses.
   */
  effectiveAccessToken?: string;
}

export class OAuthError extends Error {
  constructor(
    message: string,
    /** Machine-readable, mirrors PublishErrorCode's naming so the API layer can reuse the same ERROR_CODES mapping. */
    public readonly code: "CONFIGURATION_ERROR" | "AUTH_ERROR" | "PLATFORM_ERROR" | "NETWORK_ERROR",
  ) {
    super(message);
    this.name = "OAuthError";
  }
}

/**
 * One real implementation per platform (apps/api/src/oauth/providers/) —
 * built against each platform's current official OAuth documentation
 * (TikTok Login Kit / Meta Facebook Login for Instagram / Google OAuth
 * 2.0 server-side web flow), verified directly against developers.tiktok.com,
 * developers.facebook.com, and developers.google.com rather than assumed.
 * CSRF protection is the `state` parameter for every provider, stored
 * server-side in the user's session (see routes/oauth.ts), never trusted
 * from the client alone.
 *
 * PKCE note: Meta/Google's server-side web flows don't require it per
 * their current docs. TikTok's general Login Kit docs don't mention it
 * either — but a real, live request against TikTok's actual
 * /v2/auth/authorize/ endpoint with this project's real registered app
 * credentials was rejected for a missing code_challenge (verified during
 * this phase's real E2E pass, not assumed from docs). `requiresPkce`
 * lets the controller generate a verifier/challenge pair only for the
 * provider(s) that actually need it, live behavior over stale docs.
 */
export interface OAuthProvider {
  readonly platform: Platform;
  readonly requiresPkce?: boolean;
  buildAuthorizationUrl(state: string, redirectUri: string, pkce?: { codeChallenge: string }): string;
  exchangeCode(code: string, redirectUri: string, pkce?: { codeVerifier: string }): Promise<ExchangedToken>;
  fetchAccountMetadata(accessToken: string, exchanged: ExchangedToken): Promise<ConnectedAccountMetadata>;
}
