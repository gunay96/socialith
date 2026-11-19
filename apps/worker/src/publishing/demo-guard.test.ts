import { describe, expect, it } from "vitest";
import { DEMO_ACCOUNT_PUBLISH_MESSAGE, isDemoAccount } from "./demo-guard.js";

describe("isDemoAccount", () => {
  it("is true only for providerMetadata.seed === true", () => {
    expect(isDemoAccount({ seed: true })).toBe(true);
    expect(isDemoAccount({ seed: true, other: "x" })).toBe(true);
  });

  it("is false for a real OAuth profile's metadata", () => {
    expect(isDemoAccount({ username: "real.artist" })).toBe(false);
    expect(isDemoAccount({})).toBe(false);
  });

  it("does not treat truthy-but-not-true values as demo", () => {
    expect(isDemoAccount({ seed: "true" })).toBe(false);
    expect(isDemoAccount({ seed: 1 })).toBe(false);
    expect(isDemoAccount({ seed: false })).toBe(false);
  });

  it("is false for null, arrays and primitives", () => {
    expect(isDemoAccount(null)).toBe(false);
    expect(isDemoAccount(undefined)).toBe(false);
    expect(isDemoAccount([{ seed: true }])).toBe(false);
    expect(isDemoAccount("seed")).toBe(false);
    expect(isDemoAccount(true)).toBe(false);
  });

  it("explains itself to the operator", () => {
    expect(DEMO_ACCOUNT_PUBLISH_MESSAGE).toMatch(/demo/i);
    expect(DEMO_ACCOUNT_PUBLISH_MESSAGE).toMatch(/disabled/i);
  });
});
