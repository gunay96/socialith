import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { ApiHttpError, errorHandler } from "./error-handler.js";

function run(err: unknown) {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as Response & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
  errorHandler(err, {} as Request, res, vi.fn());
  return { status: res.status.mock.calls[0]?.[0], body: res.json.mock.calls[0]?.[0] };
}

describe("errorHandler", () => {
  it("keeps ApiHttpError status/code/message", () => {
    expect(run(new ApiHttpError(409, "CONFLICT", "nope"))).toEqual({ status: 409, body: { success: false, error: { code: "CONFLICT", message: "nope" } } });
  });

  it("answers malformed JSON from body-parser with 400, a fixed message, and never echoes the body", () => {
    const err = Object.assign(new SyntaxError("Unexpected token n"), { type: "entity.parse.failed", status: 400, body: "secret-ish payload" });
    const { status, body } = run(err);
    expect(status).toBe(400);
    expect(body.error).toEqual({ code: "INVALID_REQUEST", message: "Malformed request body." });
    expect(JSON.stringify(body)).not.toContain("secret-ish");
  });

  it("answers an oversized body with 413", () => {
    const { status, body } = run(Object.assign(new Error("too large"), { type: "entity.too.large", status: 413 }));
    expect(status).toBe(413);
    expect(body.error.message).toBe("Request body too large.");
  });

  it("still hides unknown errors behind a generic 500", () => {
    const { status, body } = run(new Error("db password is hunter2"));
    expect(status).toBe(500);
    expect(JSON.stringify(body)).not.toContain("hunter2");
  });
});
