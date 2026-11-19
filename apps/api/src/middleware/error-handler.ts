import type { NextFunction, Request, Response } from "express";
import { ERROR_CODES, type ApiResponse } from "@socialith/types";
import { logger } from "../logger.js";

export class ApiHttpError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiHttpError";
  }
}

export function notFoundHandler(_req: Request, res: Response) {
  const body: ApiResponse<never> = {
    success: false,
    error: { code: ERROR_CODES.NOT_FOUND, message: "Resource not found" },
  };
  res.status(404).json(body);
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ApiHttpError) {
    const body: ApiResponse<never> = {
      success: false,
      error: { code: err.code, message: err.message },
    };
    res.status(err.statusCode).json(body);
    return;
  }

  // Malformed client input rejected by body-parser (invalid JSON, payload too large, ...) is the CLIENT's
  // error: answer 4xx with a fixed message instead of a misleading 500 (and without echoing the body).
  const parserStatus = (err as { status?: unknown; type?: unknown } | null)?.status;
  const parserType = (err as { type?: unknown } | null)?.type;
  if (typeof parserType === "string" && parserType.startsWith("entity.") && typeof parserStatus === "number" && parserStatus >= 400 && parserStatus < 500) {
    const body: ApiResponse<never> = {
      success: false,
      error: { code: ERROR_CODES.INVALID_REQUEST, message: parserType === "entity.too.large" ? "Request body too large." : "Malformed request body." },
    };
    res.status(parserStatus).json(body);
    return;
  }

  // Never expose internal stack traces / raw error messages to the client.
  logger.error({ err }, "Unhandled API error");
  const body: ApiResponse<never> = {
    success: false,
    error: { code: ERROR_CODES.INTERNAL_ERROR, message: "Internal server error" },
  };
  res.status(500).json(body);
}
