import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { encryptToken, decryptToken, parseEncryptionKey } from "./token-crypto.js";

const key = randomBytes(32);

describe("encryptToken/decryptToken", () => {
  it("round-trips a plaintext value", () => {
    const ciphertext = encryptToken("real-access-token-value", key);
    expect(decryptToken(ciphertext, key)).toBe("real-access-token-value");
  });

  it("never contains the raw plaintext as a substring of the ciphertext", () => {
    const plaintext = "super-secret-oauth-token";
    const ciphertext = encryptToken(plaintext, key);
    expect(ciphertext).not.toContain(plaintext);
  });

  it("produces different ciphertext for the same plaintext (random IV per call)", () => {
    const a = encryptToken("same-value", key);
    const b = encryptToken("same-value", key);
    expect(a).not.toBe(b);
  });

  it("fails to decrypt with the wrong key", () => {
    const ciphertext = encryptToken("value", key);
    const wrongKey = randomBytes(32);
    expect(() => decryptToken(ciphertext, wrongKey)).toThrow();
  });

  it("fails to decrypt tampered ciphertext (auth tag mismatch)", () => {
    const ciphertext = encryptToken("value", key);
    const raw = Buffer.from(ciphertext, "base64");
    raw[raw.length - 1] = raw[raw.length - 1] ^ 0xff;
    expect(() => decryptToken(raw.toString("base64"), key)).toThrow();
  });
});

describe("parseEncryptionKey", () => {
  it("accepts a valid 64-char hex string", () => {
    const hex = randomBytes(32).toString("hex");
    expect(parseEncryptionKey(hex).length).toBe(32);
  });

  it("rejects a key that decodes to the wrong length", () => {
    expect(() => parseEncryptionKey(randomBytes(16).toString("hex"))).toThrow();
  });
});
