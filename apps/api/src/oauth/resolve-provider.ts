import { resolveOAuthRedirectUri, type Env } from "@socialith/config";
import type { Platform } from "@socialith/database";
import { TikTokOAuthProvider } from "./providers/tiktok.oauth-provider.js";
import { InstagramOAuthProvider } from "./providers/instagram.oauth-provider.js";
import { YouTubeOAuthProvider } from "./providers/youtube.oauth-provider.js";
import type { OAuthProvider } from "./types.js";

/**
 * Returns `null` when the app-level OAuth credentials for this platform
 * aren't configured — the route (routes/oauth.ts) turns that into a real
 * CONFIGURATION_ERROR response, never a fabricated authorization URL that
 * would fail once the user actually reached the platform.
 */
export function resolveOAuthProvider(platform: Platform, env: Env): OAuthProvider | null {
  switch (platform) {
    case "TIKTOK":
      return env.TIKTOK_CLIENT_KEY && env.TIKTOK_CLIENT_SECRET
        ? new TikTokOAuthProvider(env.TIKTOK_CLIENT_KEY, env.TIKTOK_CLIENT_SECRET)
        : null;
    case "INSTAGRAM":
      return env.META_APP_ID && env.META_APP_SECRET ? new InstagramOAuthProvider(env.META_APP_ID, env.META_APP_SECRET) : null;
    case "YOUTUBE":
      return env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
        ? new YouTubeOAuthProvider(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET)
        : null;
    default:
      return null;
  }
}

/** The redirect_uri each provider's app config must be registered with — see @socialith/config's resolveOAuthRedirectUri. */
export function resolveRedirectUri(platform: Platform, env: Env): string {
  return resolveOAuthRedirectUri(platform, env);
}
