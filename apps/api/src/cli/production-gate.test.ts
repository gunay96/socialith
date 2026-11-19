import { describe, expect, it } from "vitest";
import { ProductionGateError, assertProductionEnvironment } from "./production-gate.js";

const PROD_ENV = {
  NODE_ENV: "production",
  DATABASE_URL: "mysql://u:p@mysql:3306/db",
  SESSION_SECRET: "0123456789abcdef-test-session-secret",
  TOKEN_ENCRYPTION_KEY: "ab".repeat(32),
  NEXT_PUBLIC_APP_URL: "https://app.mycompany.io",
  API_PUBLIC_URL: "https://app.mycompany.io",
};

function expectRefusal(env: NodeJS.ProcessEnv, domain: string | undefined, fragment: string): ProductionGateError {
  try {
    assertProductionEnvironment(env, domain);
  } catch (err) {
    expect(err).toBeInstanceOf(ProductionGateError);
    expect((err as Error).message + ((err as ProductionGateError).problems ?? []).join(" ")).toContain(fragment);
    return err as ProductionGateError;
  }
  throw new Error("expected a refusal");
}

describe("assertProductionEnvironment", () => {
  it("accepts a valid production environment with the matching confirmed domain", () => {
    const r = assertProductionEnvironment(PROD_ENV, "app.mycompany.io");
    expect(r.hostname).toBe("app.mycompany.io");
  });

  it("is case-insensitive about the confirmed domain", () => {
    expect(() => assertProductionEnvironment(PROD_ENV, "APP.MyCompany.IO")).not.toThrow();
  });

  it.each([undefined, "development", "test", ""])("refuses NODE_ENV=%s", (nodeEnv) => {
    const env = { ...PROD_ENV, NODE_ENV: nodeEnv } as NodeJS.ProcessEnv;
    if (nodeEnv === undefined) delete env.NODE_ENV;
    expectRefusal(env, "app.mycompany.io", "NODE_ENV");
  });

  it("refuses when the confirmed domain is missing or wrong", () => {
    expectRefusal(PROD_ENV, undefined, "--confirm-domain app.mycompany.io");
    expectRefusal(PROD_ENV, "staging.mycompany.io", "does not match");
  });

  it("refuses localhost public URLs (config-level production rule)", () => {
    const env = { ...PROD_ENV, NEXT_PUBLIC_APP_URL: "https://localhost:3000", API_PUBLIC_URL: "https://localhost:3000" };
    expectRefusal(env, "localhost", "NEXT_PUBLIC_APP_URL");
  });

  it("refuses a plain-http public URL", () => {
    const env = { ...PROD_ENV, NEXT_PUBLIC_APP_URL: "http://app.mycompany.io", API_PUBLIC_URL: "http://app.mycompany.io" };
    expectRefusal(env, "app.mycompany.io", "https");
  });

  it("refuses an incomplete configuration and names the offending variables, never their values", () => {
    const env = { ...PROD_ENV, SESSION_SECRET: "x" } as NodeJS.ProcessEnv;
    const err = expectRefusal(env, "app.mycompany.io", "SESSION_SECRET");
    expect(JSON.stringify(err.problems)).not.toContain("x\"");
  });
});
