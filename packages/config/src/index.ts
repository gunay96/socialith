import { z } from "zod";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Validates process.env once at startup so a missing/misconfigured
 * variable fails fast with a clear message instead of surfacing as a
 * confusing runtime error deep in a request or job handler.
 *
 * Phase 01 validates only what the API/worker skeletons need to boot.
 * Platform credentials (TikTok/Meta), R2, and Sentry stay optional here —
 * they are validated starting in the phases that actually use them, so
 * Phase 01 never fails to boot over a secret it doesn't need yet.
 */
/**
 * `.env`/`.env.example` follow this repo's existing convention of
 * `VAR=""` for "reserved, not configured yet" (see R2_*, TIKTOK_*
 * above). Those fields were never zod-validated, so an empty string
 * never had to mean anything. `API_PUBLIC_URL`/`AI_PROVIDER_BASE_URL`
 * are — treat "" the same as "unset" before `.url()`/`.optional()` runs,
 * instead of letting an empty string fail URL validation and block boot.
 */
function emptyStringAsUndefined<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((value) => (value === "" ? undefined : value), schema);
}

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    // Optional as of the shared-hosting/demo-lite deployment tier: no
    // persistent worker process, no Redis available on shared cPanel
    // hosting. Unset means the API boots without BullMQ queues, without a
    // Redis-backed session/rate-limit store — see apps/api/src/index.ts,
    // app.ts, middleware/rate-limit.ts, and lib/queue.ts for each real
    // fallback this enables. apps/worker still requires it (a worker with
    // no Redis has nothing to do), unchanged.
    REDIS_URL: emptyStringAsUndefined(z.string().min(1).optional()),
    API_PORT: z.coerce.number().int().positive().default(4000),
    WORKER_PORT: z.coerce.number().int().positive().default(4100),
    SESSION_SECRET: z.string().min(16, "SESSION_SECRET must be at least 16 characters"),
    // The web app's origin, used by the API to restrict CORS. Optional in
    // development (falls back to localhost); required and validated in
    // production — see resolveAppOrigin below.
    NEXT_PUBLIC_APP_URL: z.string().url().optional(),
    // Selects the EmailService implementation (see
    // apps/api/src/lib/email/email.service.ts). "console" (log the
    // email instead of sending it) is the only implemented value today
    // — this is where a later phase adds "resend"/"ses"/"smtp" etc.
    // without changing anything that calls getEmailService().
    EMAIL_PROVIDER: z.enum(["console"]).default("console"),
    // AES-256 key for platform_connections' encrypted OAuth credentials
    // (packages/auth/src/token-crypto.ts) — 64 hex characters (32 raw
    // bytes). Actually validated starting Phase 04, since that's the
    // first phase anything writes an encrypted token.
    TOKEN_ENCRYPTION_KEY: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, "TOKEN_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes)"),
    // Phase 07: AI caption/hashtag generation (apps/worker/src/ai). Left
    // optional/unvalidated in shape — a missing key does not block boot,
    // it just means content-generation jobs legitimately fail with a
    // "provider not configured" error instead of a fabricated success
    // (see apps/worker/src/ai/provider.ts). BASE_URL/MODEL default to an
    // OpenAI-compatible chat-completions endpoint, the closest thing to a
    // generic "AI provider" shape this spec names.
    AI_PROVIDER_API_KEY: z.string().optional(),
    AI_PROVIDER_BASE_URL: emptyStringAsUndefined(z.string().url().optional()).default(
      "https://api.openai.com/v1",
    ),
    AI_PROVIDER_MODEL: emptyStringAsUndefined(z.string().optional()).default("gpt-4o-mini"),
    // Phase 10: production-hardening for the AI pipeline. Timeout guards
    // against a hung request blocking a worker slot forever (there was no
    // timeout at all before this phase). The two cost vars are optional
    // and independent of whether generation works at all — "cost tracking
    // if feasible" only activates when an operator actually provides
    // their provider's real per-1k-token pricing; without them, usage
    // (real prompt/completion token counts, when the provider returns
    // them) is still recorded, just without a derived dollar estimate.
    AI_PROVIDER_TIMEOUT_MS: emptyStringAsUndefined(z.coerce.number().int().positive().optional()).default(30_000),
    AI_PROVIDER_COST_PER_1K_PROMPT_TOKENS_USD: emptyStringAsUndefined(z.coerce.number().nonnegative().optional()),
    AI_PROVIDER_COST_PER_1K_COMPLETION_TOKENS_USD: emptyStringAsUndefined(z.coerce.number().nonnegative().optional()),
    // Phase 10 §15: per-queue BullMQ rate limits (Worker's own `limiter`
    // option — no new rate-limiting library). Defaults are deliberately
    // conservative real-world guesses per provider (TikTok/Meta/Google all
    // publish concrete per-app rate limits in their docs that vary by app
    // tier, so these are operator-tunable rather than hardcoded) — the
    // point is that *some* real cap always exists per queue, never "no
    // limit, whatever BullMQ's concurrency alone throttles to".
    AI_PROVIDER_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),
    AI_PROVIDER_RATE_LIMIT_DURATION_MS: z.coerce.number().int().positive().default(60_000),
    PUBLISHING_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),
    PUBLISHING_RATE_LIMIT_DURATION_MS: z.coerce.number().int().positive().default(60_000),
    ANALYTICS_SYNC_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(60),
    ANALYTICS_SYNC_RATE_LIMIT_DURATION_MS: z.coerce.number().int().positive().default(60_000),
    TOKEN_REFRESH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),
    TOKEN_REFRESH_RATE_LIMIT_DURATION_MS: z.coerce.number().int().positive().default(60_000),
    // TikTok's real, documented Get Post Status limit is 30 requests/min
    // PER USER ACCESS TOKEN — this is a coarser, whole-queue cap (every
    // account's polls share it), deliberately looser than that per-account
    // limit since the per-target 15s poll interval (see
    // apps/worker/src/publishing/enqueue.ts) already keeps any single
    // account's own poll rate far under 30/min.
    PUBLISH_STATUS_POLL_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(60),
    PUBLISH_STATUS_POLL_RATE_LIMIT_DURATION_MS: z.coerce.number().int().positive().default(60_000),
    // Phase 07: local asset storage (packages/video-engine) — the real,
    // credential-free storage backend this phase ships (R2 is reserved
    // for later, see .env.example). Defaults to a per-machine temp
    // directory shared by apps/api (upload + static serving) and
    // apps/worker (render output) since both run on the same host today.
    LOCAL_STORAGE_DIR: emptyStringAsUndefined(z.string().optional()),
    // The externally-reachable origin apps/api serves local media from —
    // used only to build absolute ContentAsset URLs (e.g.
    // "http://localhost:4000/media/..."). Defaults to localhost:API_PORT.
    API_PUBLIC_URL: emptyStringAsUndefined(z.string().url().optional()),
    // Defaults to relying on FFmpeg being on PATH — set only if it isn't.
    FFMPEG_PATH: z.string().default("ffmpeg"),
    // Phase 08: publishing (apps/worker/src/publishing). App-level OAuth
    // credentials, needed only for refreshing an expired per-account
    // access token (PlatformConnection.encryptedRefreshToken) — a plain
    // publish call with a still-valid token needs none of these. Left
    // optional: a missing value means token refresh for that platform
    // fails with a real CONFIGURATION_ERROR (see
    // apps/worker/src/publishing/providers), never a fabricated success.
    // TIKTOK_CLIENT_KEY/SECRET and META_APP_ID/SECRET were already
    // reserved in .env.example since Phase 04; GOOGLE_CLIENT_ID/SECRET is
    // new here (YouTube's OAuth provider is Google, and nothing
    // Google-specific was reserved before this phase needed it).
    TIKTOK_CLIENT_KEY: z.string().optional(),
    TIKTOK_CLIENT_SECRET: z.string().optional(),
    META_APP_ID: z.string().optional(),
    META_APP_SECRET: z.string().optional(),
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    // Phase 10: real OAuth connect (apps/api/src/oauth). Each must exactly
    // match the redirect URI registered in that platform's own developer
    // console — left optional with a computed default (resolveOAuthRedirectUri
    // below) pointing at this API's own real callback route, so local/dev
    // setups don't need to set it unless the platform app is registered
    // with a different one.
    TIKTOK_REDIRECT_URI: emptyStringAsUndefined(z.string().url().optional()),
    META_REDIRECT_URI: emptyStringAsUndefined(z.string().url().optional()),
    GOOGLE_REDIRECT_URI: emptyStringAsUndefined(z.string().url().optional()),
    // Phase 10: production object storage (packages/video-engine's R2
    // backend). Optional — see resolveAssetStorage: without these, the
    // app falls back to the real local-filesystem backend Phase 07 shipped,
    // never a fabricated upload success.
    R2_ACCOUNT_ID: z.string().optional(),
    R2_ACCESS_KEY_ID: z.string().optional(),
    R2_SECRET_ACCESS_KEY: z.string().optional(),
    R2_BUCKET_NAME: z.string().default("socialith"),
    R2_PUBLIC_URL: emptyStringAsUndefined(z.string().url().optional()),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== "production") return;

    if (!env.NEXT_PUBLIC_APP_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["NEXT_PUBLIC_APP_URL"],
        message: "NEXT_PUBLIC_APP_URL must be set explicitly in production (no localhost fallback).",
      });
      return;
    }

    const host = safeHostname(env.NEXT_PUBLIC_APP_URL);
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["NEXT_PUBLIC_APP_URL"],
        message: "NEXT_PUBLIC_APP_URL must not point to localhost in production.",
      });
    }
  });

function safeHostname(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

export type Env = z.infer<typeof envSchema>;

let cachedEnv: Env | undefined;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cachedEnv) return cachedEnv;

  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  cachedEnv = parsed.data;
  return cachedEnv;
}

/**
 * Resolves the single origin the API should accept CORS requests from.
 * - production: NEXT_PUBLIC_APP_URL is required (enforced above) and must
 *   not be localhost — there is no fallback, so a misconfigured deploy
 *   fails at boot instead of silently allowing an unintended origin.
 * - development/test: falls back to the local web dev server.
 */
export function resolveAppOrigin(env: Env): string {
  if (env.NODE_ENV === "production") {
    // env.NEXT_PUBLIC_APP_URL is guaranteed present and non-localhost by
    // the schema's superRefine above once loadEnv() has succeeded.
    return env.NEXT_PUBLIC_APP_URL as string;
  }
  return env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
}

/** The origin apps/api serves local media from — see LOCAL_STORAGE_DIR/API_PUBLIC_URL above. */
export function resolveApiPublicUrl(env: Env): string {
  return env.API_PUBLIC_URL ?? `http://localhost:${env.API_PORT}`;
}

/**
 * Shared by apps/api and apps/worker so both resolve the exact same
 * absolute path without either one needing to know the other's cwd (dev
 * runs each from its own package directory; production runs each from
 * wherever it's deployed) — an env override always wins; the default is
 * a stable, per-OS temp directory, appropriate for the real-but-local
 * storage backend this phase ships (see packages/video-engine).
 */
export function resolveLocalStorageDir(env: Env): string {
  if (env.LOCAL_STORAGE_DIR) return env.LOCAL_STORAGE_DIR;
  return join(tmpdir(), "socialith-local-storage");
}

/**
 * Shape mirrors @socialith/video-engine's ResolveAssetStorageInput
 * structurally (this package does not depend on video-engine — apps/api
 * and apps/worker each already import both, and TypeScript's structural
 * typing means this plain object satisfies that interface without an
 * explicit cross-package type import). The one place `r2` gets built from
 * raw env vars — only set when every credential is actually present, so
 * resolveAssetStorage (video-engine) never has to guess whether a partial
 * R2 config should still count as "configured".
 */
export interface AssetStorageEnvConfig {
  r2?: { accountId: string; accessKeyId: string; secretAccessKey: string; bucketName: string; publicUrl?: string };
  local: { baseDir: string; baseUrl: string };
}

export function resolveAssetStorageConfig(env: Env): AssetStorageEnvConfig {
  const r2 =
    env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY
      ? {
          accountId: env.R2_ACCOUNT_ID,
          accessKeyId: env.R2_ACCESS_KEY_ID,
          secretAccessKey: env.R2_SECRET_ACCESS_KEY,
          bucketName: env.R2_BUCKET_NAME,
          publicUrl: env.R2_PUBLIC_URL,
        }
      : undefined;
  return { r2, local: { baseDir: resolveLocalStorageDir(env), baseUrl: `${resolveApiPublicUrl(env)}/media` } };
}

/** Real, credential-free by construction: this API's own callback route, not something that needs to be registered separately unless the platform app config points elsewhere. */
export function resolveOAuthRedirectUri(
  platform: "TIKTOK" | "INSTAGRAM" | "YOUTUBE",
  env: Env,
): string {
  const explicit = { TIKTOK: env.TIKTOK_REDIRECT_URI, INSTAGRAM: env.META_REDIRECT_URI, YOUTUBE: env.GOOGLE_REDIRECT_URI }[
    platform
  ];
  if (explicit) return explicit;
  const path = { TIKTOK: "tiktok", INSTAGRAM: "instagram", YOUTUBE: "youtube" }[platform];
  return `${resolveApiPublicUrl(env)}/api/oauth/${path}/callback`;
}
