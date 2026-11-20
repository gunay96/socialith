import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Upload-Post webhook verification (documented behaviour, see
 * docs/UPLOAD_POST_API_MAPPING.md §Webhooks):
 *
 *  - header `X-Upload-Post-Signature: sha256=<hex>`; present only when the account has a secret
 *  - header `X-Upload-Post-Timestamp: <unix seconds>`
 *  - signed string is `"<timestamp>.<raw body bytes>"`, HMAC-SHA256 with the webhook secret, hex
 *  - verify against the RAW bytes (never re-serialized JSON), reject timestamps older than ~5 min,
 *    compare in constant time; accept both secrets while one is being rotated
 *  - `X-Upload-Post-Delivery` is identical across retries → deduplicate on it
 */
export type WebhookRejection =
  | "NO_SECRET_CONFIGURED"
  | "MISSING_SIGNATURE"
  | "MISSING_TIMESTAMP"
  | "BAD_TIMESTAMP"
  | "STALE_TIMESTAMP"
  | "BAD_SIGNATURE_FORMAT"
  | "SIGNATURE_MISMATCH";

export type WebhookVerification = { ok: true } | { ok: false; reason: WebhookRejection };

export const WEBHOOK_TOLERANCE_SECONDS = 300;

export function computeWebhookSignature(secret: string, timestamp: string, rawBody: Buffer | string): string {
  const mac = createHmac("sha256", secret);
  mac.update(`${timestamp}.`);
  mac.update(typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody);
  return `sha256=${mac.digest("hex")}`;
}

export function verifyWebhookSignature(input: {
  /** Current secret first; a previous secret may follow while a rotation settles. Empty list = not configured. */
  secrets: readonly string[];
  signatureHeader: string | undefined;
  timestampHeader: string | undefined;
  rawBody: Buffer | string;
  toleranceSeconds?: number;
  nowMs?: number;
}): WebhookVerification {
  const secrets = input.secrets.filter((s) => s.length > 0);
  if (secrets.length === 0) return { ok: false, reason: "NO_SECRET_CONFIGURED" };
  if (!input.signatureHeader) return { ok: false, reason: "MISSING_SIGNATURE" };
  if (!input.timestampHeader) return { ok: false, reason: "MISSING_TIMESTAMP" };

  const timestamp = Number(input.timestampHeader);
  if (!Number.isInteger(timestamp) || timestamp <= 0) return { ok: false, reason: "BAD_TIMESTAMP" };
  const ageSeconds = Math.abs((input.nowMs ?? Date.now()) / 1000 - timestamp);
  if (ageSeconds > (input.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS)) return { ok: false, reason: "STALE_TIMESTAMP" };

  const presented = input.signatureHeader.trim().toLowerCase();
  if (!/^sha256=[0-9a-f]{64}$/.test(presented)) return { ok: false, reason: "BAD_SIGNATURE_FORMAT" };
  const presentedBuf = Buffer.from(presented, "utf8");

  let matched = false;
  for (const secret of secrets) {
    const expected = Buffer.from(computeWebhookSignature(secret, input.timestampHeader, input.rawBody), "utf8");
    // Same length is guaranteed by the format check above; compare every secret (no early exit) in constant time.
    if (expected.length === presentedBuf.length && timingSafeEqual(expected, presentedBuf)) matched = true;
  }
  return matched ? { ok: true } : { ok: false, reason: "SIGNATURE_MISMATCH" };
}

export interface ParsedWebhookEvent {
  deliveryId: string | null;
  event: string;
  attempt: number | null;
  /** Hints taken from the payload. They are only hints: the worker re-reads the authoritative status before changing anything. */
  requestId: string | null;
  jobId: string | null;
  externalId: string | null;
  profileUsername: string | null;
  platform: string | null;
  createdAt: string | null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/**
 * The provider documents the headers and the event names, but not the full upload_completed payload,
 * so ids are looked up tolerantly at the top level and under `result`/`data`.
 */
export function parseWebhookEvent(rawBody: Buffer | string, headers: Record<string, string | undefined>): ParsedWebhookEvent | null {
  let payload: unknown;
  try {
    payload = JSON.parse(typeof rawBody === "string" ? rawBody : rawBody.toString("utf8"));
  } catch {
    return null;
  }
  if (!isObj(payload)) return null;
  const nested = [payload, isObj(payload.result) ? payload.result : {}, isObj(payload.data) ? payload.data : {}];
  const pick = (...keys: string[]): string | null => {
    for (const source of nested) for (const key of keys) {
      const v = str(source[key]);
      if (v) return v;
    }
    return null;
  };
  const event = str(payload.event) ?? str(headers["x-upload-post-event"]);
  if (!event) return null;
  const attempt = Number(headers["x-upload-post-attempt"]);
  return {
    deliveryId: str(headers["x-upload-post-delivery"]),
    event,
    attempt: Number.isInteger(attempt) ? attempt : null,
    requestId: pick("request_id"),
    jobId: pick("job_id"),
    externalId: pick("external_id"),
    profileUsername: pick("profile_username", "user"),
    platform: pick("platform")?.toLowerCase() ?? null,
    createdAt: pick("created_at"),
  };
}
