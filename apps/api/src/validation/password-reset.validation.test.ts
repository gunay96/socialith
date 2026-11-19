import { describe, expect, it } from "vitest";
import { forgotPasswordSchema, resetPasswordSchema } from "./password-reset.validation.js";

describe("forgotPasswordSchema", () => {
  it("accepts a well-formed email", () => {
    expect(forgotPasswordSchema.safeParse({ email: "user@example.com" }).success).toBe(true);
  });

  it("rejects a malformed email", () => {
    expect(forgotPasswordSchema.safeParse({ email: "not-an-email" }).success).toBe(false);
  });

  it("rejects a missing email", () => {
    expect(forgotPasswordSchema.safeParse({}).success).toBe(false);
  });

  it("rejects an empty-after-trim email", () => {
    expect(forgotPasswordSchema.safeParse({ email: "   " }).success).toBe(false);
  });
});

describe("resetPasswordSchema", () => {
  it("accepts a token and a 12+ character password", () => {
    expect(
      resetPasswordSchema.safeParse({ token: "some-raw-token-value", password: "correct-horse-battery" }).success,
    ).toBe(true);
  });

  it("rejects a missing token", () => {
    expect(resetPasswordSchema.safeParse({ password: "correct-horse-battery" }).success).toBe(false);
  });

  it("rejects an empty token", () => {
    expect(resetPasswordSchema.safeParse({ token: "  ", password: "correct-horse-battery" }).success).toBe(false);
  });

  it("rejects a password shorter than 12 characters (same policy as invitation acceptance)", () => {
    expect(resetPasswordSchema.safeParse({ token: "abc", password: "short" }).success).toBe(false);
  });
});
