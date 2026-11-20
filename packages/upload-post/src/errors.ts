/**
 * Structured Upload-Post failures. Every error the client raises is an
 * UploadPostError with a machine-readable `kind`, so callers branch on the
 * kind (retry / reconnect / fix input / wait) instead of string-matching
 * messages. The API key is NEVER part of a message, a detail or a log line:
 * `redactSecrets` strips it from anything that came back from the network.
 */
export type UploadPostErrorKind =
  | "NOT_CONFIGURED" // no API key / base URL — nothing was sent
  | "AUTH" // 401: the API key is invalid or expired
  | "FORBIDDEN_PLAN" // 403: plan does not include this, profile limit, blocked
  | "NOT_FOUND" // 404
  | "VALIDATION" // 400 (and other unfixable-as-is client errors)
  | "CONFLICT" // 409 (username in use, scheduled post in progress, ...)
  | "REAUTH_REQUIRED" // the connected social account must be reconnected
  | "RATE_LIMITED" // 429, temporary — wait Retry-After
  | "QUOTA_EXCEEDED" // 429, plan/monthly/scheduled-pending limit — waiting briefly will not help
  | "TIMEOUT" // our request timeout fired
  | "NETWORK" // DNS / connection reset / TLS
  | "SERVER" // 5xx
  | "UNKNOWN";

export interface UploadPostErrorInit {
  kind: UploadPostErrorKind;
  message: string;
  httpStatus?: number;
  /** Upload-Post's stable `error_code`, e.g. `tiktok_reconnect_required`. */
  errorCode?: string;
  retryable: boolean;
  retryAfterMs?: number;
  /**
   * True when a state-changing request (publish/schedule) was sent but we do not
   * know whether Upload-Post processed it (timeout / connection reset after the
   * request left). The caller must NOT blindly resend: look the publication up by
   * its request_id/external_id first, or rely on the Idempotency-Key.
   */
  outcomeUnknown?: boolean;
}

export class UploadPostError extends Error {
  readonly kind: UploadPostErrorKind;
  readonly httpStatus?: number;
  readonly errorCode?: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly outcomeUnknown: boolean;

  constructor(init: UploadPostErrorInit) {
    super(init.message);
    this.name = "UploadPostError";
    this.kind = init.kind;
    this.httpStatus = init.httpStatus;
    this.errorCode = init.errorCode;
    this.retryable = init.retryable;
    this.retryAfterMs = init.retryAfterMs;
    this.outcomeUnknown = init.outcomeUnknown ?? false;
  }
}

const REAUTH_CODES = new Set([
  "reauth_required",
  "tiktok_reconnect_required",
  "account_reauth_required",
  "facebook_reauth_required",
  "account_checkpoint_required",
]);

const QUOTA_CODES = new Set(["SCHEDULED_POSTS_LIMIT", "PROFILE_LIMIT_REACHED", "daily_limit", "x_daily_write_limit"]);

export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s.length >= 4) out = out.split(s).join("[redacted]");
  }
  return out;
}

function pickString(body: unknown, key: string): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const v = (body as Record<string, unknown>)[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function pickNumber(body: unknown, key: string): number | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const v = (body as Record<string, unknown>)[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Parses a Retry-After header (delta-seconds or HTTP date) into milliseconds. */
export function parseRetryAfterMs(header: string | null | undefined, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** Maps an HTTP error response to a structured error. `secrets` are redacted from any text copied from the body. */
export function classifyHttpError(
  status: number,
  body: unknown,
  headers: { get(name: string): string | null },
  secrets: readonly string[],
): UploadPostError {
  const errorCode = pickString(body, "error_code") ?? pickString(body, "code");
  const rawMessage = pickString(body, "message") ?? pickString(body, "error") ?? `HTTP ${status}`;
  const message = redactSecrets(rawMessage, secrets).slice(0, 300);
  const bodyRetrySeconds = pickNumber(body, "retry_after_seconds") ?? pickNumber(body, "retry_after");
  const retryAfterMs =
    parseRetryAfterMs(headers.get("retry-after")) ??
    (bodyRetrySeconds !== undefined ? Math.round(bodyRetrySeconds * 1000) : undefined);
  const base = { httpStatus: status, errorCode, retryAfterMs };

  if (errorCode && REAUTH_CODES.has(errorCode)) {
    return new UploadPostError({ ...base, kind: "REAUTH_REQUIRED", message, retryable: false });
  }
  if (typeof body === "object" && body !== null && (body as Record<string, unknown>).reauth_required === true) {
    return new UploadPostError({ ...base, kind: "REAUTH_REQUIRED", message, retryable: false });
  }

  switch (status) {
    case 401:
      return new UploadPostError({ ...base, kind: "AUTH", message: "Upload-Post rejected the API key (invalid or expired).", retryable: false });
    case 403:
      return new UploadPostError({ ...base, kind: "FORBIDDEN_PLAN", message, retryable: false });
    case 404:
      return new UploadPostError({ ...base, kind: "NOT_FOUND", message, retryable: false });
    case 409:
      return new UploadPostError({ ...base, kind: "CONFLICT", message, retryable: false });
    case 429: {
      const usageExceeded = typeof body === "object" && body !== null && "usage" in (body as object);
      if ((errorCode && QUOTA_CODES.has(errorCode)) || usageExceeded) {
        return new UploadPostError({ ...base, kind: "QUOTA_EXCEEDED", message, retryable: false });
      }
      return new UploadPostError({ ...base, kind: "RATE_LIMITED", message, retryable: true });
    }
    default:
      if (status >= 500) return new UploadPostError({ ...base, kind: "SERVER", message, retryable: true });
      if (status >= 400) return new UploadPostError({ ...base, kind: "VALIDATION", message, retryable: false });
      return new UploadPostError({ ...base, kind: "UNKNOWN", message, retryable: false });
  }
}
