import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { TikTokOAuthProvider } from "./tiktok.oauth-provider.js";
import { OAuthError } from "../types.js";

describe("TikTokOAuthProvider", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("buildAuthorizationUrl", () => {
    it("builds the real TikTok Login Kit authorize URL with the exact scopes this app requests", () => {
      const provider = new TikTokOAuthProvider("real-client-key", "real-client-secret");
      const url = new URL(provider.buildAuthorizationUrl("state-123", "https://api.example.com/api/oauth/tiktok/callback"));

      expect(url.origin + url.pathname).toBe("https://www.tiktok.com/v2/auth/authorize/");
      expect(url.searchParams.get("client_key")).toBe("real-client-key");
      expect(url.searchParams.get("response_type")).toBe("code");
      expect(url.searchParams.get("redirect_uri")).toBe("https://api.example.com/api/oauth/tiktok/callback");
      expect(url.searchParams.get("state")).toBe("state-123");
      expect(url.searchParams.get("scope")).toBe("user.info.basic,user.info.profile,user.info.stats,video.list,video.upload");
    });

    it("declares requiresPkce — TikTok's real, live authorize endpoint rejects this app's requests without a code_challenge", () => {
      const provider = new TikTokOAuthProvider("real-client-key", "real-client-secret");
      expect(provider.requiresPkce).toBe(true);
    });

    it("includes code_challenge/code_challenge_method=S256 when a PKCE challenge is passed", () => {
      const provider = new TikTokOAuthProvider("real-client-key", "real-client-secret");
      const url = new URL(
        provider.buildAuthorizationUrl("state-123", "https://api.example.com/api/oauth/tiktok/callback", {
          codeChallenge: "real-shaped-challenge-value",
        }),
      );
      expect(url.searchParams.get("code_challenge")).toBe("real-shaped-challenge-value");
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    });

    it("never includes client_secret in the authorization URL (it's a browser-visible redirect)", () => {
      const provider = new TikTokOAuthProvider("real-client-key", "super-secret-value");
      const url = provider.buildAuthorizationUrl("state", "https://x.example.com/cb");
      expect(url).not.toContain("super-secret-value");
    });
  });

  describe("exchangeCode", () => {
    it("posts the real form-urlencoded exchange request to TikTok's real token endpoint", async () => {
      fetchMock.mockResolvedValue(
        new Response(
          JSON.stringify({
            access_token: "act.real-shaped-access-token",
            refresh_token: "rft.real-shaped-refresh-token",
            expires_in: 86400,
            scope: "user.info.basic,video.publish",
            token_type: "Bearer",
          }),
          { status: 200 },
        ),
      );

      const provider = new TikTokOAuthProvider("client-key", "client-secret");
      const result = await provider.exchangeCode("real-auth-code", "https://api.example.com/api/oauth/tiktok/callback");

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://open.tiktokapis.com/v2/oauth/token/");
      expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/x-www-form-urlencoded");
      const body = new URLSearchParams(init.body as string);
      expect(body.get("client_key")).toBe("client-key");
      expect(body.get("client_secret")).toBe("client-secret");
      expect(body.get("code")).toBe("real-auth-code");
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("redirect_uri")).toBe("https://api.example.com/api/oauth/tiktok/callback");

      expect(result.accessToken).toBe("act.real-shaped-access-token");
      expect(result.refreshToken).toBe("rft.real-shaped-refresh-token");
      expect(result.scopes).toEqual(["user.info.basic", "video.publish"]);
      expect(result.expiresAt).toBeInstanceOf(Date);
    });

    it("includes code_verifier in the token exchange when PKCE was used on /start (this is what TikTok's real endpoint actually requires)", async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ access_token: "act.token", expires_in: 86400, scope: "user.info.basic" }), { status: 200 }),
      );
      const provider = new TikTokOAuthProvider("client-key", "client-secret");
      await provider.exchangeCode("real-auth-code", "https://api.example.com/api/oauth/tiktok/callback", {
        codeVerifier: "the-real-pkce-verifier",
      });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = new URLSearchParams(init.body as string);
      expect(body.get("code_verifier")).toBe("the-real-pkce-verifier");
    });

    it("classifies a real invalid_grant (already-used/expired code) rejection as a real error, not a fabricated success", async () => {
      fetchMock.mockResolvedValue(
        new Response(
          JSON.stringify({ error: "invalid_grant", error_description: "Authorization code has expired or been used." }),
          { status: 400 },
        ),
      );
      const provider = new TikTokOAuthProvider("client-key", "client-secret");
      await expect(provider.exchangeCode("stale-code", "https://x.example.com/cb")).rejects.toThrow(OAuthError);
    });

    it("classifies a 401/invalid_client rejection as AUTH_ERROR", async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ error: "invalid_client", error_description: "Client key/secret mismatch." }), {
          status: 401,
        }),
      );
      const provider = new TikTokOAuthProvider("wrong-key", "wrong-secret");
      await expect(provider.exchangeCode("code", "https://x.example.com/cb")).rejects.toMatchObject({ code: "AUTH_ERROR" });
    });
  });

  describe("fetchAccountMetadata", () => {
    it("fetches the real Get User Info fields and maps them to ConnectedAccountMetadata", async () => {
      fetchMock.mockResolvedValue(
        new Response(
          JSON.stringify({
            data: {
              user: {
                open_id: "tiktok_open_id_real_shape",
                display_name: "Real Creator Name",
                username: "realcreator",
                avatar_url: "https://p16-sign.tiktokcdn-us.com/real-avatar.jpeg",
                follower_count: 15230,
              },
            },
            error: { code: "ok", message: "", log_id: "log-abc" },
          }),
          { status: 200 },
        ),
      );

      const provider = new TikTokOAuthProvider("client-key", "client-secret");
      const metadata = await provider.fetchAccountMetadata("access-token", {
        accessToken: "access-token",
        refreshToken: null,
        expiresAt: null,
        scopes: [],
      });

      const [url] = fetchMock.mock.calls[0] as [URL | string];
      expect(String(url)).toContain("https://open.tiktokapis.com/v2/user/info/");
      expect(String(url)).toContain("fields=");

      expect(metadata.externalAccountId).toBe("tiktok_open_id_real_shape");
      expect(metadata.handle).toBe("@realcreator");
      expect(metadata.displayName).toBe("Real Creator Name");
      expect(metadata.followerCount).toBe(15230);
      // TikTok returns no separate publish-credential — unlike Instagram's
      // Page-token indirection, effectiveAccessToken should be absent here.
      expect(metadata.effectiveAccessToken).toBeUndefined();
    });

    it("throws a real error when TikTok's user info response has no open_id (never fabricates an account identity)", async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ data: { user: {} }, error: { code: "ok", message: "" } }), { status: 200 }),
      );
      const provider = new TikTokOAuthProvider("client-key", "client-secret");
      await expect(
        provider.fetchAccountMetadata("access-token", { accessToken: "access-token", refreshToken: null, expiresAt: null, scopes: [] }),
      ).rejects.toThrow(OAuthError);
    });
  });
});
