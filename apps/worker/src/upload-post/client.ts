import type { Env } from "@socialith/config";
import { UploadPostClient, UploadPostError, type UploadPostClientOptions } from "@socialith/upload-post";
import { logger } from "../logger.js";
import { PublishError } from "../publishing/types.js";

let cached: { key: string; baseUrl: string | undefined; client: UploadPostClient } | null = null;

/** The configured client, or null when no API key is set (callers report "not configured"; nothing is faked). */
export function getUploadPostClient(
  env: Pick<Env, "UPLOAD_POST_API_KEY" | "UPLOAD_POST_BASE_URL" | "UPLOAD_POST_TIMEOUT_MS" | "UPLOAD_POST_PUBLISH_TIMEOUT_MS">,
  overrides: Partial<UploadPostClientOptions> = {},
): UploadPostClient | null {
  if (!env.UPLOAD_POST_API_KEY) return null;
  if (Object.keys(overrides).length === 0 && cached && cached.key === env.UPLOAD_POST_API_KEY && cached.baseUrl === env.UPLOAD_POST_BASE_URL) {
    return cached.client;
  }
  const client = new UploadPostClient({
    apiKey: env.UPLOAD_POST_API_KEY,
    baseUrl: env.UPLOAD_POST_BASE_URL,
    timeoutMs: env.UPLOAD_POST_TIMEOUT_MS,
    writeTimeoutMs: env.UPLOAD_POST_PUBLISH_TIMEOUT_MS,
    // Only method/path/status/timing are logged by the client — never headers, bodies or the key.
    logger: {
      debug: (fields, message) => logger.debug({ provider: "upload-post", ...fields }, message),
      warn: (fields, message) => logger.warn({ provider: "upload-post", ...fields }, message),
    },
    ...overrides,
  });
  if (Object.keys(overrides).length === 0) cached = { key: env.UPLOAD_POST_API_KEY, baseUrl: env.UPLOAD_POST_BASE_URL, client };
  return client;
}

/**
 * Maps a provider failure onto the worker's existing PublishError taxonomy, which is what decides
 * retry vs permanent failure and what marks an account ERROR:
 *  - a rejected API key / plan / quota problem is OUR configuration, not the social account's auth,
 *    so it must not flip the destination to ERROR (CONFIGURATION_ERROR);
 *  - REAUTH_REQUIRED means the creator must reconnect the account: AUTH_ERROR (non-retryable).
 */
export function toPublishError(err: unknown): PublishError {
  if (err instanceof PublishError) return err;
  if (!(err instanceof UploadPostError)) {
    return new PublishError(err instanceof Error ? err.message : String(err), "PLATFORM_ERROR", true);
  }
  const meta = { provider: "upload-post", kind: err.kind, errorCode: err.errorCode ?? null };
  switch (err.kind) {
    case "NOT_CONFIGURED":
      return new PublishError("Upload-Post is not configured (API key missing).", "CONFIGURATION_ERROR", false, undefined, undefined, meta);
    case "AUTH":
      return new PublishError("Upload-Post rejected the configured API key. Replace it in the server environment.", "CONFIGURATION_ERROR", false, err.httpStatus, undefined, meta);
    case "FORBIDDEN_PLAN":
      return new PublishError(`Upload-Post refused this request for the current plan: ${err.message}`, "CONFIGURATION_ERROR", false, err.httpStatus, undefined, meta);
    case "QUOTA_EXCEEDED":
      return new PublishError(`Upload-Post limit reached: ${err.message}`, "CONFIGURATION_ERROR", false, err.httpStatus, undefined, meta);
    case "NOT_FOUND":
      return new PublishError(`Upload-Post profile not found: ${err.message}`, "CONFIGURATION_ERROR", false, err.httpStatus, undefined, meta);
    case "REAUTH_REQUIRED":
      return new PublishError(`The social account must be reconnected in Upload-Post: ${err.message}`, "AUTH_ERROR", false, err.httpStatus, undefined, meta);
    case "VALIDATION":
    case "CONFLICT":
      return new PublishError(`Upload-Post rejected the publication: ${err.message}`, "CONTENT_ERROR", false, err.httpStatus, undefined, meta);
    case "RATE_LIMITED":
      return new PublishError(`Upload-Post rate limit: ${err.message}`, "RATE_LIMITED", true, err.httpStatus, err.retryAfterMs, meta);
    case "TIMEOUT":
    case "NETWORK":
      return new PublishError(err.message, "NETWORK_ERROR", true, undefined, undefined, meta);
    case "SERVER":
      return new PublishError(`Upload-Post server error: ${err.message}`, "PLATFORM_ERROR", true, err.httpStatus, err.retryAfterMs, meta);
    default:
      return new PublishError(err.message, "PLATFORM_ERROR", true, err.httpStatus, undefined, meta);
  }
}
