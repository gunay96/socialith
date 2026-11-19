import type { NextFunction, Request, Response } from "express";
import { loadEnv, resolveAppOrigin } from "@socialith/config";
import { generateSecureToken, generatePkceVerifier, computePkceChallenge } from "@socialith/auth";
import { platformSchema } from "../validation/social-account.validation.js";
import { resolveOAuthProvider, resolveRedirectUri } from "../oauth/resolve-provider.js";
import { OAuthError } from "../oauth/types.js";
import * as socialAccountService from "../services/social-account.service.js";
import { logger } from "../logger.js";

/** The state round-trip is single-use and short-lived — a start whose callback never returns within this window is treated as abandoned, not replayable later. */
const STATE_MAX_AGE_MS = 10 * 60 * 1000;

function redirectToAccountsWithError(res: Response, env: ReturnType<typeof loadEnv>, code: string): void {
  const url = new URL("/accounts", resolveAppOrigin(env));
  url.searchParams.set("oauthError", code);
  res.redirect(url.toString());
}

/** GET /api/oauth/:platform/start — real, provider-specific authorization redirect; never a fabricated success. */
export function startOAuth(req: Request, res: Response, next: NextFunction): void {
  try {
    const platformParsed = platformSchema.safeParse(req.params.platform?.toUpperCase());
    if (!platformParsed.success) {
      res.status(400).json({ success: false, error: { code: "INVALID_REQUEST", message: "Unknown platform." } });
      return;
    }
    const platform = platformParsed.data;
    const env = loadEnv();
    const provider = resolveOAuthProvider(platform, env);
    if (!provider) {
      res.status(400).json({
        success: false,
        error: { code: "CONFIGURATION_ERROR", message: `${platform} OAuth app credentials are not configured.` },
      });
      return;
    }

    const state = generateSecureToken();
    let codeVerifier: string | undefined;
    let codeChallenge: string | undefined;
    if (provider.requiresPkce) {
      codeVerifier = generatePkceVerifier();
      codeChallenge = computePkceChallenge(codeVerifier);
    }
    req.session.oauthState = { platform, state, createdAt: Date.now(), codeVerifier };

    const redirectUri = resolveRedirectUri(platform, env);
    res.redirect(provider.buildAuthorizationUrl(state, redirectUri, codeChallenge ? { codeChallenge } : undefined));
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/oauth/:platform/callback — the platform redirects the user's
 * browser here directly (never the frontend), so this must never hand a
 * token back to the browser: it exchanges the code server-side, encrypts
 * and persists the credential, and redirects the browser on to
 * /accounts with only a success/error signal in the query string — no
 * token, no secret, ever crosses into a response body or URL the browser
 * can read.
 */
export async function handleOAuthCallback(req: Request, res: Response): Promise<void> {
  const env = loadEnv();
  const platformParsed = platformSchema.safeParse(req.params.platform?.toUpperCase());
  if (!platformParsed.success) {
    redirectToAccountsWithError(res, env, "invalid_platform");
    return;
  }
  const platform = platformParsed.data;

  if (req.query.error) {
    // The user denied consent on the platform's own screen — a real,
    // expected outcome, not a bug.
    redirectToAccountsWithError(res, env, "access_denied");
    return;
  }

  const savedState = req.session.oauthState;
  req.session.oauthState = undefined; // single-use regardless of outcome below

  const code = typeof req.query.code === "string" ? req.query.code : undefined;
  const state = typeof req.query.state === "string" ? req.query.state : undefined;
  if (
    !code ||
    !state ||
    !savedState ||
    savedState.platform !== platform ||
    savedState.state !== state ||
    Date.now() - savedState.createdAt > STATE_MAX_AGE_MS
  ) {
    redirectToAccountsWithError(res, env, "invalid_state");
    return;
  }

  const provider = resolveOAuthProvider(platform, env);
  if (!provider) {
    redirectToAccountsWithError(res, env, "configuration_error");
    return;
  }

  try {
    const redirectUri = resolveRedirectUri(platform, env);
    const exchanged = await provider.exchangeCode(
      code,
      redirectUri,
      savedState.codeVerifier ? { codeVerifier: savedState.codeVerifier } : undefined,
    );
    const metadata = await provider.fetchAccountMetadata(exchanged.accessToken, exchanged);

    await socialAccountService.connectAccount(req.user!, {
      platform,
      externalAccountId: metadata.externalAccountId,
      handle: metadata.handle,
      displayName: metadata.displayName,
      avatarUrl: metadata.avatarUrl,
      followerCount: metadata.followerCount,
      providerMetadata: metadata.providerMetadata,
      accessToken: metadata.effectiveAccessToken ?? exchanged.accessToken,
      refreshToken: exchanged.refreshToken,
      tokenExpiresAt: exchanged.expiresAt,
      scopes: exchanged.scopes,
    });

    const url = new URL("/accounts", resolveAppOrigin(env));
    url.searchParams.set("connected", platform);
    res.redirect(url.toString());
  } catch (err) {
    logger.error({ err, platform }, "OAuth callback failed");
    redirectToAccountsWithError(res, env, err instanceof OAuthError ? err.code.toLowerCase() : "platform_error");
  }
}
