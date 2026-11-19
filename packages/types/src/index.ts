/**
 * Shared cross-app types for Socialith.
 * Grows alongside each phase (campaign types land in Phase 06,
 * publishing types in Phase 08, etc.) — kept minimal in Phase 01.
 */

export type ApiSuccess<T> = {
  success: true;
  data: T;
};

export type ApiError = {
  success: false;
  error: {
    code: string;
    message: string;
  };
};

export type ApiResponse<T> = ApiSuccess<T> | ApiError;

export const ERROR_CODES = {
  AUTH_REQUIRED: "AUTH_REQUIRED",
  FORBIDDEN: "FORBIDDEN",
  INVALID_REQUEST: "INVALID_REQUEST",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  RATE_LIMITED: "RATE_LIMITED",
  TOKEN_EXPIRED: "TOKEN_EXPIRED",
  AUTHORIZATION_REVOKED: "AUTHORIZATION_REVOKED",
  INVALID_INVITATION: "INVALID_INVITATION",
  INVALID_RESET_TOKEN: "INVALID_RESET_TOKEN",
  PLATFORM_PERMISSION_MISSING: "PLATFORM_PERMISSION_MISSING",
  INVALID_MEDIA: "INVALID_MEDIA",
  PUBLISH_FAILED: "PUBLISH_FAILED",
  RENDER_FAILED: "RENDER_FAILED",
  ACCOUNT_DISABLED: "ACCOUNT_DISABLED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  // Phase 10: normalized, user-facing codes for provider/config failures
  // that previously only existed as PublishErrorCode strings internal to
  // apps/worker — surfaced through the API/UI so "Something went wrong"
  // is never the only thing a real, actionable failure shows.
  CONFIGURATION_ERROR: "CONFIGURATION_ERROR",
  REAUTH_REQUIRED: "REAUTH_REQUIRED",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export type HealthStatus = {
  status: "ok" | "degraded" | "down";
  checks: {
    api: boolean;
    database: boolean;
    redis: boolean;
  };
  // Phase 10 §17: real per-queue backlog (not just "Redis is reachable") —
  // populated when the API's own Redis connection is healthy, omitted
  // otherwise rather than reporting fabricated zeros.
  queues?: { name: string; waiting: number; active: number; delayed: number; failed: number }[];
  timestamp: string;
};

export * from "./queues.js";
export * from "./platform-capabilities.js";
