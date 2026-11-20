import { pipeline } from "node:stream/promises";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { ZodTypeAny, z } from "zod";
import { ERROR_CODES, type ApiResponse } from "@socialith/types";
import { ApiHttpError } from "../middleware/error-handler.js";
import * as library from "../services/media-library.service.js";
import { libraryStorage } from "../services/media-common.js";
import * as tasks from "../services/operation-task.service.js";
import { handleUpload } from "../services/media-upload.service.js";
import * as schema from "../validation/media.validation.js";

type Result = { status?: number; data: unknown };

function wrap(fn: (req: Request) => Promise<Result>): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await fn(req);
      const body: ApiResponse<unknown> = { success: true, data: result.data };
      res.status(result.status ?? 200).json(body);
    } catch (err) {
      next(err);
    }
  };
}

function parse<S extends ZodTypeAny>(s: S, input: unknown, what = "request"): z.infer<S> {
  const parsed = s.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ApiHttpError(400, ERROR_CODES.INVALID_REQUEST, `Invalid ${what}${first ? `: ${first.path.join(".") || "input"} ${first.message}` : "."}`);
  }
  return parsed.data;
}
const user = (req: Request) => req.user!;
const id = (req: Request) => req.params.id!;
const body = <S extends ZodTypeAny>(s: S, req: Request) => parse(s, req.body ?? {}, "body");
const query = <S extends ZodTypeAny>(s: S, req: Request) => parse(s, req.query, "query");

// uploads
export const upload: RequestHandler = wrap(async (req) => {
  const result = await handleUpload(user(req), req);
  return { status: result.duplicate ? 200 : 202, data: result };
});

// assets
export const listAssets: RequestHandler = wrap(async (req) => ({ data: await library.listAssets(user(req), query(schema.listAssetsQuerySchema, req)) }));
export const facets: RequestHandler = wrap(async (req) => ({ data: await library.getFacets(user(req)) }));
export const getAsset: RequestHandler = wrap(async (req) => ({ data: await library.getAsset(user(req), id(req)) }));
export const setTags: RequestHandler = wrap(async (req) => ({ data: await library.setTags(user(req), id(req), body(schema.tagsSchema, req).tags) }));
export const bulkTags: RequestHandler = wrap(async (req) => {
  const b = body(schema.bulkTagsSchema, req);
  return { data: await library.bulkTags(user(req), b.assetIds, b.add, b.remove) };
});
export const setNotes: RequestHandler = wrap(async (req) => ({ data: await library.updateNotes(user(req), id(req), body(schema.notesSchema, req).notes) }));
export const archiveAsset: RequestHandler = wrap(async (req) => ({ data: await library.setAssetStatus(user(req), id(req), true) }));
export const restoreAsset: RequestHandler = wrap(async (req) => ({ data: await library.setAssetStatus(user(req), id(req), false) }));
export const setRights: RequestHandler = wrap(async (req) => {
  const b = body(schema.rightsSchema, req);
  return { data: await library.setRights(user(req), id(req), b.status, b.notes) };
});
export const reanalyze: RequestHandler = wrap(async (req) => ({ status: 202, data: await library.reanalyze(user(req), id(req)) }));
export const setAssetCampaigns: RequestHandler = wrap(async (req) => {
  await library.setCampaigns(user(req), "asset", id(req), body(schema.campaignIdsSchema, req).campaignIds);
  return { data: await library.getAsset(user(req), id(req)) };
});
export const setAssetPageGroups: RequestHandler = wrap(async (req) => {
  await library.setPageGroups(user(req), "asset", id(req), body(schema.pageGroupIdsSchema, req).groupIds);
  return { data: await library.getAsset(user(req), id(req)) };
});

// packs
export const listPacks: RequestHandler = wrap(async (req) => ({ data: await library.listPacks(user(req), query(schema.listPacksQuerySchema, req)) }));
export const getPack: RequestHandler = wrap(async (req) => ({ data: await library.getPack(user(req), id(req)) }));
export const updatePack: RequestHandler = wrap(async (req) => ({ data: await library.updatePack(user(req), id(req), body(schema.packUpdateSchema, req)) }));
export const archivePack: RequestHandler = wrap(async (req) => ({ data: await library.setPackArchived(user(req), id(req), true) }));
export const restorePack: RequestHandler = wrap(async (req) => ({ data: await library.setPackArchived(user(req), id(req), false) }));
export const setPackCampaigns: RequestHandler = wrap(async (req) => {
  await library.setCampaigns(user(req), "pack", id(req), body(schema.campaignIdsSchema, req).campaignIds);
  return { data: await library.getPack(user(req), id(req)) };
});
export const setPackPageGroups: RequestHandler = wrap(async (req) => {
  await library.setPageGroups(user(req), "pack", id(req), body(schema.pageGroupIdsSchema, req).groupIds);
  return { data: await library.getPack(user(req), id(req)) };
});

// tasks (the progress ledger; 5E adds the live stream)
export const listTasks: RequestHandler = wrap(async (req) => ({ data: await tasks.listTasks(user(req), query(schema.listTasksQuerySchema, req)) }));
export const getTask: RequestHandler = wrap(async (req) => ({ data: await tasks.getTask(user(req), id(req)) }));

/** Parses a single `Range: bytes=a-b` request (a player's seek). Anything else (multi-range, garbage) is ignored and the whole file is sent. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | "unsatisfiable" {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start: number;
  let end: number;
  if (m[1] === "") {
    const suffix = Number(m[2]);
    if (suffix === 0) return "unsatisfiable";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return "unsatisfiable";
  return { start, end };
}

/**
 * Streams a stored file to an AUTHENTICATED, organization-checked reader. The library is private: there is no public URL
 * for any of it. Supports Range requests so video can be scrubbed; sends nosniff, a private cache policy, and for
 * text/spreadsheets an attachment disposition so nothing user-supplied is ever rendered inside the page.
 */
export const stream = (which: "content" | "thumbnail"): RequestHandler => async (req, res, next) => {
  try {
    const target = await library.resolveStreamTarget(user(req), id(req), which);
    const storage = libraryStorage();
    const meta = await storage.getMetadata(target.key);
    if (!meta) throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, "The stored file is missing.");
    const range = parseRange(req.headers.range, meta.sizeBytes);
    if (range === "unsatisfiable") {
      res.status(416).setHeader("Content-Range", `bytes */${meta.sizeBytes}`).end();
      return;
    }
    const out = await storage.createReadStream(target.key, range ?? undefined);
    res.setHeader("Content-Type", target.contentType);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, max-age=300");
    // the web app and the API are different origins in development (same-site): let the app embed its own library files
    res.setHeader("Cross-Origin-Resource-Policy", "same-site");
    res.setHeader("Content-Disposition", `${target.inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(target.fileName)}`);
    if (range) {
      res.status(206).setHeader("Content-Range", `bytes ${range.start}-${range.end}/${meta.sizeBytes}`);
      res.setHeader("Content-Length", String(range.end - range.start + 1));
    } else {
      res.status(200).setHeader("Content-Length", String(meta.sizeBytes));
    }
    await pipeline(out.stream, res);
  } catch (err) {
    // a client that closes the connection mid-stream (a player seeking) is not an error
    if ((err as NodeJS.ErrnoException)?.code === "ERR_STREAM_PREMATURE_CLOSE" || (err as NodeJS.ErrnoException)?.code === "ECONNRESET") return;
    if (res.headersSent) {
      res.destroy();
      return;
    }
    next(err);
  }
};
