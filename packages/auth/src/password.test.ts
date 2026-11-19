import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password.js";

describe("hashPassword / verifyPassword (scrypt)", () => {
  it("produces a versioned, self-describing hash string", async () => {
    const hash = await hashPassword("correct horse battery staple");
    const parts = hash.split("$");
    expect(parts).toHaveLength(7);
    expect(parts[0]).toBe("scrypt");
    expect(parts[1]).toBe("v1");
    expect(Number(parts[2])).toBeGreaterThan(0); // N
    expect(Number(parts[3])).toBeGreaterThan(0); // r
    expect(Number(parts[4])).toBeGreaterThan(0); // p
  });

  it("verifies the correct password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    await expect(verifyPassword(hash, "correct horse battery staple")).resolves.toBe(true);
  });

  it("rejects a wrong password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    await expect(verifyPassword(hash, "wrong password")).resolves.toBe(false);
  });

  it("uses a fresh random salt per call, even for the same password", async () => {
    const a = await hashPassword("same password");
    const b = await hashPassword("same password");
    expect(a).not.toBe(b);
    await expect(verifyPassword(a, "same password")).resolves.toBe(true);
    await expect(verifyPassword(b, "same password")).resolves.toBe(true);
  });

  it("returns false, never throws, for a malformed hash", async () => {
    await expect(verifyPassword("not-a-real-hash", "anything")).resolves.toBe(false);
    await expect(verifyPassword("", "anything")).resolves.toBe(false);
  });

  it("returns false for a pre-migration Argon2id-shaped hash rather than throwing", async () => {
    await expect(
      verifyPassword("$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$hashvalue", "anything"),
    ).resolves.toBe(false);
  });

  it("returns false when the recorded parameters are tampered/non-numeric", async () => {
    const hash = await hashPassword("password");
    const parts = hash.split("$");
    parts[2] = "not-a-number";
    await expect(verifyPassword(parts.join("$"), "password")).resolves.toBe(false);
  });

  it("rejects a hash whose derived-key length was truncated", async () => {
    const hash = await hashPassword("password");
    const parts = hash.split("$");
    parts[6] = Buffer.from("short").toString("base64");
    await expect(verifyPassword(parts.join("$"), "password")).resolves.toBe(false);
  });
});
