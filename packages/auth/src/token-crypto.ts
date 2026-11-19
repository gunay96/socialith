import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

/**
 * AES-256-GCM encryption for OAuth credentials at rest
 * (platform_connections.encrypted_access_token / encrypted_refresh_token —
 * see packages/database/prisma/schema.prisma). Deliberately takes the key
 * as a parameter rather than reading TOKEN_ENCRYPTION_KEY from env itself
 * — same reasoning as password.ts/tokens.ts: this package stays
 * env/framework-free, so its logic is unit-testable with a throwaway key
 * and there's exactly one place (loadEnv() in @socialith/config) that
 * resolves the real key from the environment.
 */
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96-bit nonce, the size GCM is designed for
const AUTH_TAG_LENGTH = 16;

/**
 * Encrypts `plaintext` with a fresh random IV per call (GCM must never
 * reuse an IV under the same key). Output packs iv + authTag + ciphertext
 * into one base64 string so callers only need to store a single opaque
 * column value.
 */
export function encryptToken(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}

/**
 * Reverses encryptToken. Throws if `key` is wrong or `encoded` was
 * tampered with — GCM's auth tag makes ciphertext modification fail
 * loudly here rather than silently decrypting to garbage.
 */
export function decryptToken(encoded: string, key: Buffer): string {
  const raw = Buffer.from(encoded, "base64");
  const iv = raw.subarray(0, IV_LENGTH);
  const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = raw.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/**
 * Parses TOKEN_ENCRYPTION_KEY (64 hex characters, i.e. 32 raw bytes) into
 * the Buffer encryptToken/decryptToken need. Kept here rather than in
 * @socialith/config so the hex-decoding/length rule lives next to the
 * algorithm that dictates it (AES-256 needs exactly a 32-byte key).
 */
export function parseEncryptionKey(hexKey: string): Buffer {
  const key = Buffer.from(hexKey, "hex");
  if (key.length !== 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes (64 hex characters).");
  }
  return key;
}
