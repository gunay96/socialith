import { describe, expect, it } from "vitest";
import { EnvValidationError, parseEnv, resolveOAuthRedirectUri } from "./index.js";

const BASE = {
  DATABASE_URL: "mysql://u:p@localhost:3306/db",
  SESSION_SECRET: "0123456789abcdef-test-session-secret",
  TOKEN_ENCRYPTION_KEY: "ab".repeat(32),
};

const PROD = {
  ...BASE,
  NODE_ENV: "production",
  NEXT_PUBLIC_APP_URL: "https://app.example.com",
  API_PUBLIC_URL: "https://app.example.com",
};

function issuesOf(source: Record<string, string>): { path: string; message: string }[] {
  try {
    parseEnv(source);
  } catch (err) {
    if (err instanceof EnvValidationError) return err.issues;
    throw err;
  }
  return [];
}

describe("parseEnv — development", () => {
  it("accepts a minimal environment and applies safe defaults", () => {
    const env = parseEnv(BASE);
    expect(env.NODE_ENV).toBe("development");
    expect(env.SCHEDULE_STALE_AFTER_MINUTES).toBe(30);
    expect(env.SCHEDULING_RECONCILE_INTERVAL_SECONDS).toBe(60);
    expect(env.PUBLISHING_STUCK_AFTER_MINUTES).toBe(20);
    expect(env.PUBLISHING_RECOVERY_MAX_AGE_HOURS).toBe(24);
  });

  it("treats REDIS_URL as optional, including an empty string", () => {
    expect(parseEnv(BASE).REDIS_URL).toBeUndefined();
    expect(parseEnv({ ...BASE, REDIS_URL: "" }).REDIS_URL).toBeUndefined();
    expect(parseEnv({ ...BASE, REDIS_URL: "redis://redis:6379" }).REDIS_URL).toBe("redis://redis:6379");
  });

  it("does not require API_PUBLIC_URL outside production", () => {
    expect(issuesOf(BASE)).toEqual([]);
  });

  it("coerces numeric scheduling settings and rejects non-positive values", () => {
    expect(parseEnv({ ...BASE, SCHEDULE_STALE_AFTER_MINUTES: "45" }).SCHEDULE_STALE_AFTER_MINUTES).toBe(45);
    expect(issuesOf({ ...BASE, SCHEDULE_STALE_AFTER_MINUTES: "0" }).map((i) => i.path)).toContain("SCHEDULE_STALE_AFTER_MINUTES");
    expect(issuesOf({ ...BASE, PUBLISHING_STUCK_AFTER_MINUTES: "-5" }).map((i) => i.path)).toContain("PUBLISHING_STUCK_AFTER_MINUTES");
  });
});

describe("parseEnv — production URL rules (the worker crash-loop root cause)", () => {
  it("accepts a fully specified production environment", () => {
    expect(issuesOf(PROD)).toEqual([]);
  });

  it("rejects a localhost NEXT_PUBLIC_APP_URL", () => {
    const issues = issuesOf({ ...PROD, NEXT_PUBLIC_APP_URL: "http://localhost:3000" });
    expect(issues).toEqual([{ path: "NEXT_PUBLIC_APP_URL", message: expect.stringContaining("localhost") }]);
  });

  it("rejects a missing NEXT_PUBLIC_APP_URL", () => {
    const { NEXT_PUBLIC_APP_URL: _omit, ...rest } = PROD;
    expect(issuesOf(rest).map((i) => i.path)).toContain("NEXT_PUBLIC_APP_URL");
  });

  it("rejects a missing API_PUBLIC_URL and says every service (incl. the worker) needs it", () => {
    const { API_PUBLIC_URL: _omit, ...rest } = PROD;
    const issue = issuesOf(rest).find((i) => i.path === "API_PUBLIC_URL");
    expect(issue?.message).toMatch(/worker/i);
  });

  it("treats an empty API_PUBLIC_URL like a missing one", () => {
    expect(issuesOf({ ...PROD, API_PUBLIC_URL: "" }).map((i) => i.path)).toContain("API_PUBLIC_URL");
  });

  it.each(["http://localhost:4000", "http://127.0.0.1:4000", "http://[::1]:4000"])("rejects a localhost API_PUBLIC_URL (%s)", (url) => {
    expect(issuesOf({ ...PROD, API_PUBLIC_URL: url }).map((i) => i.path)).toContain("API_PUBLIC_URL");
  });

  it("reports every offending variable at once, machine-readably", () => {
    const issues = issuesOf({ ...BASE, NODE_ENV: "production", NEXT_PUBLIC_APP_URL: "http://localhost:3000" });
    expect(issues.map((i) => i.path).sort()).toEqual(["API_PUBLIC_URL", "NEXT_PUBLIC_APP_URL"]);
  });

  it("keeps the human-readable message format", () => {
    expect(() => parseEnv({ NODE_ENV: "production" })).toThrow(/Invalid environment configuration:\n {2}- /);
  });
});

describe("resolveOAuthRedirectUri", () => {
  it("derives the callback from API_PUBLIC_URL", () => {
    const env = parseEnv(PROD);
    expect(resolveOAuthRedirectUri("TIKTOK", env)).toBe("https://app.example.com/api/oauth/tiktok/callback");
    expect(resolveOAuthRedirectUri("INSTAGRAM", env)).toBe("https://app.example.com/api/oauth/instagram/callback");
  });

  it("an explicit redirect URI wins", () => {
    const env = parseEnv({ ...PROD, TIKTOK_REDIRECT_URI: "https://other.example.com/cb" });
    expect(resolveOAuthRedirectUri("TIKTOK", env)).toBe("https://other.example.com/cb");
  });
});
