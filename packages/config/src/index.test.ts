import { describe, expect, it } from "vitest";
import { EnvValidationError, parseEnv, resolveFfprobePath, resolveFontDirs, resolveLibraryStorageConfig, resolveMediaLibraryDir, resolveMediaLimits, resolveOAuthRedirectUri } from "./index.js";

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

describe("parseEnv — Upload-Post (Phase 2)", () => {
  it("is optional: unset/empty means 'not configured', with safe defaults and the hybrid hand-off OFF", () => {
    const env = parseEnv({ ...BASE, UPLOAD_POST_API_KEY: "" });
    expect(env.UPLOAD_POST_API_KEY).toBeUndefined();
    expect(env.UPLOAD_POST_BASE_URL).toBeUndefined();
    expect(env.UPLOAD_POST_TIMEOUT_MS).toBe(15_000);
    expect(env.UPLOAD_POST_PUBLISH_TIMEOUT_MS).toBe(60_000);
    expect(env.UPLOAD_POST_SYNC_INTERVAL_MINUTES).toBe(30);
    expect(env.UPLOAD_POST_SCHEDULE_HANDOFF_ENABLED).toBe(false);
    expect(env.UPLOAD_POST_HANDOFF_OWNER_APPROVED).toBe(false);
    expect(env.UPLOAD_POST_SCHEDULE_HANDOFF_WINDOW_HOURS).toBe(48);
  });

  it("provider-side scheduling cannot be switched on by one variable: it also needs the owner-approval confirmation", () => {
    // enabled without the confirmation: refuses to boot, naming the variable and saying why
    const refused = issuesOf({ ...BASE, UPLOAD_POST_API_KEY: "a-real-looking-key-123", UPLOAD_POST_SCHEDULE_HANDOFF_ENABLED: "true" });
    expect(refused.map((i) => i.path)).toContain("UPLOAD_POST_SCHEDULE_HANDOFF_ENABLED");
    expect(JSON.stringify(refused)).toMatch(/UPLOAD_POST_HANDOFF_OWNER_APPROVED/);
    expect(JSON.stringify(refused)).toMatch(/separate live verification/);
    // the confirmation alone does not enable anything
    const alone = parseEnv({ ...BASE, UPLOAD_POST_HANDOFF_OWNER_APPROVED: "true" });
    expect(alone.UPLOAD_POST_SCHEDULE_HANDOFF_ENABLED).toBe(false);
    // both together: allowed
    const both = parseEnv({ ...BASE, UPLOAD_POST_SCHEDULE_HANDOFF_ENABLED: "true", UPLOAD_POST_HANDOFF_OWNER_APPROVED: "true" });
    expect(both.UPLOAD_POST_SCHEDULE_HANDOFF_ENABLED).toBe(true);
    // explicit false/false and the empty strings of an unset .env line are the safe default
    expect(parseEnv({ ...BASE, UPLOAD_POST_SCHEDULE_HANDOFF_ENABLED: "", UPLOAD_POST_HANDOFF_OWNER_APPROVED: "" }).UPLOAD_POST_SCHEDULE_HANDOFF_ENABLED).toBe(false);
  });

  it("parses the key, the hand-off switch and numeric settings", () => {
    const env = parseEnv({
      ...BASE,
      UPLOAD_POST_API_KEY: "a-real-looking-key-123",
      UPLOAD_POST_SCHEDULE_HANDOFF_ENABLED: "true",
      UPLOAD_POST_HANDOFF_OWNER_APPROVED: "true", // the deliberate second switch (see the next tests)
      UPLOAD_POST_SCHEDULE_HANDOFF_WINDOW_HOURS: "24",
      UPLOAD_POST_SYNC_INTERVAL_MINUTES: "60",
    });
    expect(env.UPLOAD_POST_API_KEY).toBe("a-real-looking-key-123");
    expect(env.UPLOAD_POST_SCHEDULE_HANDOFF_ENABLED).toBe(true);
    expect(env.UPLOAD_POST_SCHEDULE_HANDOFF_WINDOW_HOURS).toBe(24);
    expect(env.UPLOAD_POST_SYNC_INTERVAL_MINUTES).toBe(60);
  });

  it("rejects an implausibly short key, a short webhook secret and a bad hand-off value — naming the variable, never the value", () => {
    const issues = issuesOf({ ...BASE, UPLOAD_POST_API_KEY: "k3y-abc", UPLOAD_POST_WEBHOOK_SECRET: "t1ny-s3cr3t", UPLOAD_POST_SCHEDULE_HANDOFF_ENABLED: "yes" });
    const paths = issues.map((i) => i.path);
    expect(paths).toEqual(expect.arrayContaining(["UPLOAD_POST_API_KEY", "UPLOAD_POST_WEBHOOK_SECRET", "UPLOAD_POST_SCHEDULE_HANDOFF_ENABLED"]));
    expect(JSON.stringify(issues)).not.toContain("k3y-abc");
    expect(JSON.stringify(issues)).not.toContain("t1ny-s3cr3t");
  });

  it("requires https for the base URL in production, and outside production allows http only on loopback", () => {
    expect(issuesOf({ ...PROD, UPLOAD_POST_BASE_URL: "http://127.0.0.1:9999/api" }).map((i) => i.path)).toContain("UPLOAD_POST_BASE_URL");
    expect(issuesOf({ ...PROD, UPLOAD_POST_BASE_URL: "https://api.upload-post.com/api" })).toEqual([]);
    expect(issuesOf({ ...BASE, UPLOAD_POST_BASE_URL: "http://127.0.0.1:9999/api" })).toEqual([]);
    expect(issuesOf({ ...BASE, UPLOAD_POST_BASE_URL: "http://api.example.net/api" }).map((i) => i.path)).toContain("UPLOAD_POST_BASE_URL");
  });

  it("bounds the hand-off window and timeouts", () => {
    expect(issuesOf({ ...BASE, UPLOAD_POST_SCHEDULE_HANDOFF_WINDOW_HOURS: "0" }).map((i) => i.path)).toContain("UPLOAD_POST_SCHEDULE_HANDOFF_WINDOW_HOURS");
    expect(issuesOf({ ...BASE, UPLOAD_POST_TIMEOUT_MS: "10" }).map((i) => i.path)).toContain("UPLOAD_POST_TIMEOUT_MS");
  });
});

describe("media library configuration (Phase 5A)", () => {
  const R2 = { R2_ACCOUNT_ID: "acct", R2_ACCESS_KEY_ID: "key", R2_SECRET_ACCESS_KEY: "secret", R2_BUCKET_NAME: "public-media", R2_PUBLIC_URL: "https://cdn.example.com" };

  it("has conservative, configurable upload and extraction limits", () => {
    expect(resolveMediaLimits(parseEnv(BASE))).toEqual({
      maxFileBytes: 1_073_741_824,
      maxArchiveBytes: 2_147_483_648,
      zipMaxEntries: 2_000,
      zipMaxTotalBytes: 4_294_967_296,
      zipMaxRatio: 100,
      zipMaxDepth: 12,
      zipMaxPathLength: 240,
    });
    const custom = parseEnv({ ...BASE, MEDIA_MAX_FILE_BYTES: "1000", MEDIA_ZIP_MAX_ENTRIES: "5", MEDIA_ZIP_MAX_RATIO: "20" });
    expect(resolveMediaLimits(custom)).toMatchObject({ maxFileBytes: 1000, zipMaxEntries: 5, zipMaxRatio: 20 });
  });

  it("treats empty limit variables as 'use the default' (Compose passes empty strings)", () => {
    expect(resolveMediaLimits(parseEnv({ ...BASE, MEDIA_MAX_FILE_BYTES: "", MEDIA_ZIP_MAX_ENTRIES: "" })).zipMaxEntries).toBe(2_000);
  });

  it("rejects a non-positive or non-numeric limit instead of silently disabling the protection", () => {
    expect(issuesOf({ ...BASE, MEDIA_ZIP_MAX_ENTRIES: "0" }).map((i) => i.path)).toContain("MEDIA_ZIP_MAX_ENTRIES");
    expect(issuesOf({ ...BASE, MEDIA_MAX_FILE_BYTES: "lots" }).map((i) => i.path)).toContain("MEDIA_MAX_FILE_BYTES");
    expect(issuesOf({ ...BASE, MEDIA_ZIP_MAX_RATIO: "-5" }).map((i) => i.path)).toContain("MEDIA_ZIP_MAX_RATIO");
  });

  it("keeps the library OUTSIDE the publicly served media directory", () => {
    const env = parseEnv({ ...BASE, LOCAL_STORAGE_DIR: "/data/media" });
    const library = resolveLibraryStorageConfig(env).local;
    expect(library.baseDir).not.toBe("/data/media");
    expect(library.baseDir.replace(/\\/g, "/").startsWith("/data/media/")).toBe(false);
    expect(resolveMediaLibraryDir(parseEnv({ ...BASE, MEDIA_LIBRARY_DIR: "/data/library" }))).toBe("/data/library");
  });

  it("never gives the library a fetchable URL", () => {
    const local = resolveLibraryStorageConfig(parseEnv(BASE)).local;
    expect(local.baseUrl).toBe("private://media-library");
    const r2 = resolveLibraryStorageConfig(parseEnv({ ...BASE, ...R2 })).r2;
    expect(r2?.publicUrl).toBeUndefined(); // even though the public media bucket has one
  });

  it("uses a separate private bucket for the library when configured, else the media bucket", () => {
    expect(resolveLibraryStorageConfig(parseEnv({ ...BASE, ...R2 })).r2?.bucketName).toBe("public-media");
    expect(resolveLibraryStorageConfig(parseEnv({ ...BASE, ...R2, R2_LIBRARY_BUCKET_NAME: "private-library" })).r2?.bucketName).toBe("private-library");
  });

  it("is local-only when R2 is incompletely configured, and passes an S3 endpoint override through", () => {
    expect(resolveLibraryStorageConfig(parseEnv({ ...BASE, R2_ACCOUNT_ID: "acct" })).r2).toBeUndefined();
    expect(resolveLibraryStorageConfig(parseEnv({ ...BASE, ...R2, R2_ENDPOINT: "http://127.0.0.1:9000" })).r2?.endpoint).toBe("http://127.0.0.1:9000");
  });

  it("finds ffprobe next to ffmpeg, or uses the explicit setting", () => {
    expect(resolveFfprobePath(parseEnv(BASE))).toBe("ffprobe");
    expect(resolveFfprobePath(parseEnv({ ...BASE, FFMPEG_PATH: "/opt/ff/bin/ffmpeg" })).replace(/\\/g, "/")).toBe("/opt/ff/bin/ffprobe");
    expect(resolveFfprobePath(parseEnv({ ...BASE, FFMPEG_PATH: "C:\\ff\\bin\\ffmpeg.exe" })).toLowerCase()).toContain("ffprobe.exe");
    expect(resolveFfprobePath(parseEnv({ ...BASE, FFMPEG_PATH: "/opt/ff/bin/ffmpeg", FFPROBE_PATH: "/usr/bin/ffprobe" }))).toBe("/usr/bin/ffprobe");
    expect(resolveFfprobePath(parseEnv({ ...BASE, FFMPEG_PATH: "/opt/custom/transcoder" }))).toBe("ffprobe");
  });

  it("reads the render settings, with defaults, and the font directories from FONT_DIRS", () => {
    const env = parseEnv(BASE);
    expect(env).toMatchObject({ RENDER_CONCURRENCY: 1, RENDER_TIMEOUT_MS: 900_000, RENDER_X264_PRESET: "veryfast", RENDER_X264_CRF: 21 });
    expect(resolveFontDirs(env)).toBeUndefined();
    expect(resolveFontDirs(parseEnv({ ...BASE, FONT_DIRS: "/a/fonts; /b/fonts,/c" }))).toEqual(["/a/fonts", "/b/fonts", "/c"]);
    expect(() => parseEnv({ ...BASE, RENDER_X264_PRESET: "turbo" })).toThrow();
    expect(() => parseEnv({ ...BASE, RENDER_X264_CRF: "99" })).toThrow();
  });
});
