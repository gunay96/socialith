import { describe, expect, it } from "vitest";
import { buildLoginRateLimitKey } from "./rate-limit.js";

describe("buildLoginRateLimitKey", () => {
  it("combines IP and lowercased/trimmed email", () => {
    const key = buildLoginRateLimitKey({ ip: "203.0.113.5", body: { email: "  Owner@Example.com  " } });
    expect(key).toBe("203.0.113.5:owner@example.com");
  });

  it("falls back to 'unknown' for a missing email", () => {
    const key = buildLoginRateLimitKey({ ip: "203.0.113.5", body: {} });
    expect(key).toBe("203.0.113.5:unknown");
  });

  it("falls back to 'unknown' for a non-string email (malformed body)", () => {
    const key = buildLoginRateLimitKey({ ip: "203.0.113.5", body: { email: 12345 } });
    expect(key).toBe("203.0.113.5:unknown");
  });

  it("falls back to 'unknown' for a null/non-object body", () => {
    expect(buildLoginRateLimitKey({ ip: "203.0.113.5", body: null })).toBe("203.0.113.5:unknown");
  });

  it("falls back to 'unknown' IP when req.ip is undefined", () => {
    const key = buildLoginRateLimitKey({ ip: undefined, body: { email: "a@b.com" } });
    expect(key).toBe("unknown:a@b.com");
  });

  it("produces different keys for different emails from the same IP", () => {
    const a = buildLoginRateLimitKey({ ip: "203.0.113.5", body: { email: "a@example.com" } });
    const b = buildLoginRateLimitKey({ ip: "203.0.113.5", body: { email: "b@example.com" } });
    expect(a).not.toEqual(b);
  });
});
