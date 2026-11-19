import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

/**
 * Generates a URL-safe, high-entropy token (256 bits) for one-time use in
 * invitation and password-reset links. The raw token is returned to the
 * caller exactly once — it must never be persisted; only its hash is
 * stored, so a database read (or leak) alone can't be used to impersonate
 * the link.
 */
export function generateSecureToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Deterministic SHA-256 hash of a token, for storage/lookup. Not a
 * password hash (no salt, no work factor) — that's intentional: these
 * tokens are already high-entropy random values, not user-chosen secrets,
 * so a fast deterministic hash is both sufficient and necessary (it lets
 * us look the token up by hash equality in a single indexed query).
 */
export function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

/**
 * Constant-time comparison of two hex-encoded hashes, so token validation
 * doesn't leak timing information about how much of the hash matched.
 * (Included for callers that compare hashes outside a DB WHERE clause;
 * the DB lookup path below is already equality-based and constant enough
 * in practice, but this is here for defense in depth / direct use.)
 */
export function safeCompareHashes(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * PKCE (RFC 7636) support for OAuth providers that require it —
 * apps/api/src/oauth/providers/tiktok.oauth-provider.ts, confirmed live:
 * a real request against TikTok's actual /v2/auth/authorize/ endpoint
 * with this project's real registered app credentials was rejected with
 * "code_challenge" missing, contradicting the general Login Kit docs
 * (which don't mention PKCE for server-side web apps) — the live
 * behavior of the real, registered app is the ground truth here, not
 * the general doc. 32 random bytes, base64url-encoded, is both a valid
 * high-entropy secret and already exactly RFC 7636's allowed
 * code_verifier character set (unreserved: [A-Za-z0-9-._~]) — no
 * further encoding needed.
 */
export function generatePkceVerifier(): string {
  return randomBytes(32).toString("base64url");
}

/** S256 method (the only one TikTok/most providers accept) — BASE64URL(SHA256(verifier)), no padding. */
export function computePkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}
