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
    // The externally-reachable origin of this deployment's API — used to
    // build absolute ContentAsset URLs (e.g. "https://…/media/…"), which
    // platforms must be able to fetch, and as the default OAuth redirect
    // base (resolveOAuthRedirectUri). Defaults to localhost:API_PORT in
    // development; REQUIRED and non-localhost in production (see
    // superRefine below) — the apps/worker crash loop and its latent
    // localhost-media-URL twin both came from this not being enforced.
    API_PUBLIC_URL: emptyStringAsUndefined(z.string().url().optional()),
    // Defaults to relying on FFmpeg being on PATH — set only if it isn't.
    FFMPEG_PATH: z.string().default("ffmpeg"),
    // Phase 1 scheduling reliability (apps/worker/src/scheduling).
    // A scheduled item whose time passed by MORE than this many minutes is
    // held (never auto-published): protects against posting stale content
    // after an outage, a restored Redis snapshot, or an old seed row.
    SCHEDULE_STALE_AFTER_MINUTES: z.coerce.number().int().positive().default(30),
    // How often the DB↔Redis scheduling reconciler runs (it also runs once
    // at worker start).
    SCHEDULING_RECONCILE_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60),
    // A target stuck in PUBLISHING (no progress) longer than this is
    // picked up by the reconciler; older than the max age it is failed
    // instead of republished.
    PUBLISHING_STUCK_AFTER_MINUTES: z.coerce.number().int().positive().default(20),
    PUBLISHING_RECOVERY_MAX_AGE_HOURS: z.coerce.number().int().positive().default(24),
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
    // Phase 2: Upload-Post (packages/upload-post). SERVER-SIDE ONLY: the key
    // is read by apps/api and apps/worker, never sent to the browser and never
    // logged. Unset = the integration reports "not configured" (never a fake
    // success); it does not block boot.
    UPLOAD_POST_API_KEY: emptyStringAsUndefined(z.string().min(8, "UPLOAD_POST_API_KEY looks too short").optional()),
    // Defaults to the provider's production API; must be https in production
    // (a loopback http URL is accepted only outside production, for the mock server).
    UPLOAD_POST_BASE_URL: emptyStringAsUndefined(z.string().url().optional()),
    UPLOAD_POST_TIMEOUT_MS: emptyStringAsUndefined(z.coerce.number().int().min(1_000).max(120_000).optional()).default(15_000),
    UPLOAD_POST_PUBLISH_TIMEOUT_MS: emptyStringAsUndefined(z.coerce.number().int().min(5_000).max(300_000).optional()).default(60_000),
    // Webhook signing secret(s) (Upload-Post "Signing secret"). The PREVIOUS one is
    // only for the minutes during a rotation. Without a secret the webhook route
    // answers 503 and processes nothing.
    UPLOAD_POST_WEBHOOK_SECRET: emptyStringAsUndefined(z.string().min(16, "UPLOAD_POST_WEBHOOK_SECRET must be at least 16 characters").optional()),
    UPLOAD_POST_WEBHOOK_SECRET_PREVIOUS: emptyStringAsUndefined(z.string().min(16).optional()),
    // How often the worker re-synchronizes provider profiles/accounts (it also
    // syncs on demand from the dashboard).
    // Which Socialith organization the (single, deployment-wide) Upload-Post API key belongs to.
    // Optional when the deployment has exactly one organization (then that one is used);
    // required as soon as there are several.
    UPLOAD_POST_ORGANIZATION_ID: emptyStringAsUndefined(z.string().min(1).optional()),
    UPLOAD_POST_SYNC_INTERVAL_MINUTES: z.coerce.number().int().min(5).max(1_440).default(30),
    // Hybrid scheduling (Socialith owns the master schedule). OFF by default:
    // when on, a target due within the window is handed to Upload-Post's own
    // scheduler and Socialith's BullMQ job for it is suppressed — never both.
    UPLOAD_POST_SCHEDULE_HANDOFF_ENABLED: emptyStringAsUndefined(
      z.enum(["true", "false"]).optional(),
    )
      .default("false")
      .transform((v) => v === "true"),
    UPLOAD_POST_SCHEDULE_HANDOFF_WINDOW_HOURS: z.coerce.number().int().min(1).max(168).default(48),
  })
  .superRefine((env, ctx) => {
    if (env.UPLOAD_POST_BASE_URL) {
      const host = safeHostname(env.UPLOAD_POST_BASE_URL);
      const isHttps = env.UPLOAD_POST_BASE_URL.startsWith("https://");
      if (env.NODE_ENV === "production" && !isHttps) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["UPLOAD_POST_BASE_URL"],
          message: "UPLOAD_POST_BASE_URL must use https in production.",
        });
      } else if (!isHttps && !isLocalHostname(host)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["UPLOAD_POST_BASE_URL"],
          message: "UPLOAD_POST_BASE_URL must use https (plain http is only accepted for a loopback test server).",
        });
      }
    }

    if (env.NODE_ENV !== "production") return;

    if (!env.NEXT_PUBLIC_APP_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["NEXT_PUBLIC_APP_URL"],
        message: "NEXT_PUBLIC_APP_URL must be set explicitly in production (no localhost fallback).",
      });
      return;
    }

    if (isLocalHostname(safeHostname(env.NEXT_PUBLIC_APP_URL))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["NEXT_PUBLIC_APP_URL"],
        message: "NEXT_PUBLIC_APP_URL must not point to localhost in production.",
      });
    }

    // Same rule for the API's public origin: every process that builds a
    // media URL or an OAuth redirect (api AND worker) must be given it.
    if (!env.API_PUBLIC_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["API_PUBLIC_URL"],
        message:
          "API_PUBLIC_URL must be set explicitly in production (media URLs and OAuth redirects are built from it; every service that loads this config needs it, including the worker).",
      });
    } else if (isLocalHostname(safeHostname(env.API_PUBLIC_URL))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["API_PUBLIC_URL"],
        message: "API_PUBLIC_URL must not point to localhost in production.",
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

function isLocalHostname(host: string | undefined): boolean {
  // new URL("http://[::1]").hostname is "[::1]" (brackets kept).
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

export type Env = z.infer<typeof envSchema>;

export interface EnvIssue {
  path: string;
  message: string;
}

/**
 * Thrown for any invalid configuration. `issues` is machine-readable so a
 * process entry point can log one structured line naming every offending
 * variable (see apps/*\/src/bootstrap.ts) instead of an opaque stack trace.
 * The message format is unchanged from before this class existed.
 */
export class EnvValidationError extends Error {
  constructor(public readonly issues: EnvIssue[]) {
    super(`Invalid environment configuration:\n${issues.map((i) => `  - ${i.path}: ${i.message}`).join("\n")}`);
    this.name = "EnvValidationError";
  }
}

/** Pure, uncached validation (what loadEnv wraps) — used directly by tests. */
export function parseEnv(source: NodeJS.ProcessEnv): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new EnvValidationError(
      parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    );
  }
  return parsed.data;
}

let cachedEnv: Env | undefined;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cachedEnv) return cachedEnv;
  cachedEnv = parseEnv(source);
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
