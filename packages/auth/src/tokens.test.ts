import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generateSecureToken, hashToken, safeCompareHashes, generatePkceVerifier, computePkceChallenge } from "./tokens.js";

describe("generateSecureToken", () => {
  it("produces sufficiently long, URL-safe, unique tokens", () => {
    const a = generateSecureToken();
    const b = generateSecureToken();

    expect(a).not.toEqual(b);
    expect(a.length).toBeGreaterThanOrEqual(40);
    expect(a).toMatch(/^[A-Za-z0-9\-_]+$/);
  });
});

describe("hashToken", () => {
  it("is deterministic for the same input", () => {
    const token = generateSecureToken();
    expect(hashToken(token)).toEqual(hashToken(token));
  });

  it("produces different hashes for different tokens", () => {
    const a = generateSecureToken();
    const b = generateSecureToken();
    expect(hashToken(a)).not.toEqual(hashToken(b));
  });

  it("returns a 64-character hex string (SHA-256)", () => {
    const hash = hashToken("anything");
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("safeCompareHashes", () => {
  it("returns true for identical hashes", () => {
    const hash = hashToken("some-token");
    expect(safeCompareHashes(hash, hash)).toBe(true);
  });

  it("returns false for different hashes", () => {
    expect(safeCompareHashes(hashToken("a"), hashToken("b"))).toBe(false);
  });

  it("returns false (not a thrown error) for mismatched lengths", () => {
    expect(safeCompareHashes("ab", hashToken("a"))).toBe(false);
  });
});

describe("generatePkceVerifier", () => {
  it("produces a unique, sufficiently high-entropy value on each call", () => {
    const a = generatePkceVerifier();
    const b = generatePkceVerifier();
    expect(a).not.toEqual(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
  });

  it("only ever uses RFC 7636's allowed code_verifier character set (no padding/other base64 chars)", () => {
    const verifier = generatePkceVerifier();
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
    expect(verifier.length).toBeGreaterThanOrEqual(43); // RFC 7636's minimum length
    expect(verifier.length).toBeLessThanOrEqual(128); // RFC 7636's maximum length
  });
});

describe("computePkceChallenge", () => {
  it("computes the real RFC 7636 S256 transform: BASE64URL(SHA256(verifier))", () => {
    const verifier = "test-verifier-value-for-a-deterministic-check";
    const expected = createHash("sha256").update(verifier).digest("base64url");
    expect(computePkceChallenge(verifier)).toBe(expected);
  });

  it("is deterministic for the same verifier (the server must recompute the same challenge TikTok already validated)", () => {
    const verifier = generatePkceVerifier();
    expect(computePkceChallenge(verifier)).toBe(computePkceChallenge(verifier));
  });

  it("produces different challenges for different verifiers", () => {
    const a = computePkceChallenge(generatePkceVerifier());
    const b = computePkceChallenge(generatePkceVerifier());
    expect(a).not.toBe(b);
  });
});
