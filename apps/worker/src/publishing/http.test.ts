import { describe, it, expect } from "vitest";
import { fetchOrThrow, throwForErrorResponse } from "./http.js";
import { PublishError } from "./types.js";

function mockResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

describe("throwForErrorResponse", () => {
  it("classifies 401 as a permanent AUTH_ERROR", async () => {
    const res = mockResponse(401, { error: "invalid token" });
    await expect(throwForErrorResponse(res, "test")).rejects.toMatchObject({
      code: "AUTH_ERROR",
      retryable: false,
      httpStatusCode: 401,
    });
  });

  it("classifies 403 as a permanent AUTH_ERROR", async () => {
    const res = mockResponse(403, { error: "forbidden" });
    await expect(throwForErrorResponse(res, "test")).rejects.toMatchObject({ code: "AUTH_ERROR", retryable: false });
  });

  it("classifies 429 as a retryable RATE_LIMITED and parses Retry-After seconds", async () => {
    const res = mockResponse(429, { error: "rate limited" }, { "retry-after": "30" });
    try {
      await throwForErrorResponse(res, "test");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PublishError);
      const publishErr = err as PublishError;
      expect(publishErr.code).toBe("RATE_LIMITED");
      expect(publishErr.retryable).toBe(true);
      expect(publishErr.retryAfterMs).toBeGreaterThan(29_000);
      expect(publishErr.retryAfterMs).toBeLessThanOrEqual(30_000);
    }
  });

  it("classifies 5xx as a retryable PLATFORM_ERROR", async () => {
    const res = mockResponse(503, { error: "server error" });
    await expect(throwForErrorResponse(res, "test")).rejects.toMatchObject({
      code: "PLATFORM_ERROR",
      retryable: true,
      httpStatusCode: 503,
    });
  });

  it("classifies other 4xx as a permanent CONTENT_ERROR", async () => {
    const res = mockResponse(422, { error: "bad content" });
    await expect(throwForErrorResponse(res, "test")).rejects.toMatchObject({
      code: "CONTENT_ERROR",
      retryable: false,
      httpStatusCode: 422,
    });
  });
});

describe("fetchOrThrow", () => {
  it("wraps a network failure as a retryable NETWORK_ERROR", async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    try {
      await expect(fetchOrThrow("http://example.invalid", {}, "test")).rejects.toMatchObject({
        code: "NETWORK_ERROR",
        retryable: true,
      });
    } finally {
      global.fetch = originalFetch;
    }
  });
});
