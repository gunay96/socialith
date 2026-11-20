import { describe, expect, it } from "vitest";
import { computeWebhookSignature, parseWebhookEvent, verifyWebhookSignature } from "./webhook.js";

const SECRET = "whsec_test_secret_value_1";
const NOW = 1_800_000_000_000;
const ts = String(Math.floor(NOW / 1000));
const body = JSON.stringify({ event: "upload_completed", request_id: "r1", external_id: "socialith:target:t1", result: { success: true } });

function verify(overrides: Partial<Parameters<typeof verifyWebhookSignature>[0]> = {}) {
  return verifyWebhookSignature({
    secrets: [SECRET],
    signatureHeader: computeWebhookSignature(SECRET, ts, body),
    timestampHeader: ts,
    rawBody: body,
    nowMs: NOW,
    ...overrides,
  });
}

describe("verifyWebhookSignature", () => {
  it("accepts a correctly signed raw body (string or Buffer)", () => {
    expect(verify()).toEqual({ ok: true });
    expect(verify({ rawBody: Buffer.from(body) })).toEqual({ ok: true });
  });

  it("signs '<timestamp>.<raw body>' with HMAC-SHA256 and the sha256= prefix (documented format)", () => {
    const sig = computeWebhookSignature(SECRET, ts, body);
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(computeWebhookSignature(SECRET, ts, body + " ")).not.toBe(sig);
    expect(computeWebhookSignature(SECRET, String(Number(ts) + 1), body)).not.toBe(sig);
  });

  it("rejects a tampered body, a wrong secret and a re-serialized body", () => {
    expect(verify({ rawBody: body.replace("r1", "r2") })).toEqual({ ok: false, reason: "SIGNATURE_MISMATCH" });
    expect(verify({ secrets: ["another_secret_value"] })).toEqual({ ok: false, reason: "SIGNATURE_MISMATCH" });
    expect(verify({ rawBody: JSON.stringify(JSON.parse(body), null, 2) })).toEqual({ ok: false, reason: "SIGNATURE_MISMATCH" });
  });

  it("rejects missing/garbled headers and a missing secret", () => {
    expect(verify({ signatureHeader: undefined })).toEqual({ ok: false, reason: "MISSING_SIGNATURE" });
    expect(verify({ timestampHeader: undefined })).toEqual({ ok: false, reason: "MISSING_TIMESTAMP" });
    expect(verify({ timestampHeader: "yesterday" })).toEqual({ ok: false, reason: "BAD_TIMESTAMP" });
    expect(verify({ signatureHeader: "abc" })).toEqual({ ok: false, reason: "BAD_SIGNATURE_FORMAT" });
    expect(verify({ signatureHeader: "sha256=zz" })).toEqual({ ok: false, reason: "BAD_SIGNATURE_FORMAT" });
    expect(verify({ secrets: [] })).toEqual({ ok: false, reason: "NO_SECRET_CONFIGURED" });
    expect(verify({ secrets: [""] })).toEqual({ ok: false, reason: "NO_SECRET_CONFIGURED" });
  });

  it("rejects stale and far-future timestamps (replay protection), accepts within tolerance", () => {
    const old = String(Math.floor(NOW / 1000) - 301);
    expect(verify({ timestampHeader: old, signatureHeader: computeWebhookSignature(SECRET, old, body) })).toEqual({ ok: false, reason: "STALE_TIMESTAMP" });
    const future = String(Math.floor(NOW / 1000) + 301);
    expect(verify({ timestampHeader: future, signatureHeader: computeWebhookSignature(SECRET, future, body) })).toEqual({ ok: false, reason: "STALE_TIMESTAMP" });
    const edge = String(Math.floor(NOW / 1000) - 299);
    expect(verify({ timestampHeader: edge, signatureHeader: computeWebhookSignature(SECRET, edge, body) })).toEqual({ ok: true });
  });

  it("accepts the previous secret while a rotation settles", () => {
    const old = "old_secret_before_rotation";
    expect(verify({ secrets: [SECRET, old], signatureHeader: computeWebhookSignature(old, ts, body) })).toEqual({ ok: true });
    expect(verify({ secrets: [SECRET, old], signatureHeader: computeWebhookSignature("third", ts, body) })).toEqual({ ok: false, reason: "SIGNATURE_MISMATCH" });
  });

  it("is case-insensitive about the hex digest", () => {
    expect(verify({ signatureHeader: computeWebhookSignature(SECRET, ts, body).toUpperCase().replace("SHA256=", "sha256=") })).toEqual({ ok: true });
  });
});

describe("parseWebhookEvent", () => {
  it("extracts the event, delivery id and correlation hints from the headers and payload", () => {
    const e = parseWebhookEvent(body, { "x-upload-post-delivery": "d-1", "x-upload-post-attempt": "2" });
    expect(e).toMatchObject({ event: "upload_completed", deliveryId: "d-1", attempt: 2, requestId: "r1", externalId: "socialith:target:t1" });
  });

  it("finds ids nested under result/data and falls back to the event header", () => {
    const nested = JSON.stringify({ data: { job_id: "job_1", platform: "TikTok", profile_username: "acme" } });
    expect(parseWebhookEvent(nested, { "x-upload-post-event": "upload_completed" })).toMatchObject({ event: "upload_completed", jobId: "job_1", platform: "tiktok", profileUsername: "acme" });
  });

  it("returns null for non-JSON, non-object or event-less payloads", () => {
    expect(parseWebhookEvent("not json", {})).toBeNull();
    expect(parseWebhookEvent("[1]", {})).toBeNull();
    expect(parseWebhookEvent("{}", {})).toBeNull();
  });
});
