import { PublishError, type PublishErrorCode } from "./types.js";

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (!Number.isNaN(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(value);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return undefined;
}

/** Classifies an HTTP response's status into the right PublishErrorCode/retryable pair and throws. Shared by every provider so the 4xx/5xx/429 rules stay in exactly one place. */
export async function throwForErrorResponse(res: Response, context: string): Promise<never> {
  const bodyText = await res.text().catch(() => "");
  let body: unknown = bodyText;
  try {
    body = bodyText ? JSON.parse(bodyText) : undefined;
  } catch {
    // not JSON — keep the raw text, still useful for diagnosing the failure
  }

  const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
  const responseMetadata = { body };

  let code: PublishErrorCode;
  let retryable: boolean;
  if (res.status === 401 || res.status === 403) {
    code = "AUTH_ERROR";
    retryable = false;
  } else if (res.status === 429) {
    code = "RATE_LIMITED";
    retryable = true;
  } else if (res.status >= 500) {
    code = "PLATFORM_ERROR";
    retryable = true;
  } else if (res.status >= 400) {
    code = "CONTENT_ERROR";
    retryable = false;
  } else {
    code = "PLATFORM_ERROR";
    retryable = true;
  }

  throw new PublishError(
    `${context}: ${res.status} ${res.statusText}`,
    code,
    retryable,
    res.status,
    retryAfterMs,
    responseMetadata,
  );
}

/** Wraps fetch() so a DNS/timeout/connection-reset failure becomes a classified, retryable PublishError instead of an untyped throw. */
export async function fetchOrThrow(url: string, init: RequestInit, context: string): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    throw new PublishError(
      `${context}: network error — ${err instanceof Error ? err.message : String(err)}`,
      "NETWORK_ERROR",
      true,
    );
  }
}
