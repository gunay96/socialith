import { createHash } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { ZodTypeAny, z } from "zod";
import { loadEnv } from "@socialith/config";
import { prisma } from "@socialith/database";
import { ERROR_CODES, type ApiResponse } from "@socialith/types";
import { parseWebhookEvent, resolveIntegrationOrganization, verifyWebhookSignature } from "@socialith/upload-post";
import { ApiHttpError } from "../middleware/error-handler.js";
import { logger } from "../logger.js";
import { enqueueUploadPostReconcile, enqueueUploadPostSync } from "../lib/upload-post.js";
import * as service from "../services/upload-post.service.js";
import * as schema from "../validation/upload-post.validation.js";

type Result = { status?: number; data: unknown };

/** Wraps a handler: success envelope + errors to the shared error middleware (provider errors are mapped, never leaked raw). */
function wrap(fn: (req: Request) => Promise<Result>): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await fn(req);
      const body: ApiResponse<unknown> = { success: true, data: result.data };
      res.status(result.status ?? 200).json(body);
    } catch (err) {
      next(service.toApiError(err));
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
const idParam = (req: Request) => req.params.id!;

export const getOverview: RequestHandler = wrap(async (req) => ({ data: await service.getOverview(user(req)) }));
export const getHealth: RequestHandler = wrap(async (req) => ({ data: await service.getHealth(user(req), req.query.refresh === "true") }));
export const getPlan: RequestHandler = wrap(async (req) => ({ data: await service.getPlan(user(req)) }));
export const getCapabilities: RequestHandler = wrap(async (req) => ({ data: await service.getCapabilities(user(req)) }));
export const requestSync: RequestHandler = wrap(async (req) => ({ status: 202, data: await service.requestSync(user(req)) }));

export const listProfiles: RequestHandler = wrap(async (req) => ({ data: await service.listProfiles(user(req), parse(schema.listProfilesQuerySchema, req.query, "query")) }));
export const listAccounts: RequestHandler = wrap(async (req) => ({ data: await service.listAccounts(user(req), parse(schema.listAccountsQuerySchema, req.query, "query")) }));
export const listPublications: RequestHandler = wrap(async (req) => ({ data: await service.listPublications(user(req), parse(schema.listPublicationsQuerySchema, req.query, "query")) }));
export const listScheduled: RequestHandler = wrap(async (req) => {
  const q = parse(schema.listPublicationsQuerySchema, req.query, "query");
  return { data: await service.listScheduled(user(req), q) };
});

export const setProfileMapping: RequestHandler = wrap(async (req) => ({ data: await service.setProfileMapping(user(req), idParam(req), parse(schema.profileMappingSchema, req.body, "body").managedPageId) }));
export const setAccountMapping: RequestHandler = wrap(async (req) => ({ data: await service.setAccountMapping(user(req), idParam(req), parse(schema.accountMappingSchema, req.body, "body").creatorId) }));
export const enableDestination: RequestHandler = wrap(async (req) => ({ data: await service.enableDestination(user(req), idParam(req)) }));
export const disableDestination: RequestHandler = wrap(async (req) => ({ data: await service.disableDestination(user(req), idParam(req)) }));

export const listManagedPages: RequestHandler = wrap(async (req) => ({ data: await service.listManagedPages(user(req), req.query.includeArchived === "true") }));
export const createManagedPage: RequestHandler = wrap(async (req) => ({ status: 201, data: await service.createManagedPage(user(req), parse(schema.managedPageCreateSchema, req.body, "body")) }));
export const updateManagedPage: RequestHandler = wrap(async (req) => ({ data: await service.updateManagedPage(user(req), idParam(req), parse(schema.managedPageUpdateSchema, req.body, "body")) }));
export const listCreators: RequestHandler = wrap(async (req) => ({ data: await service.listCreators(user(req), req.query.includeArchived === "true") }));
export const createCreator: RequestHandler = wrap(async (req) => ({ status: 201, data: await service.createCreator(user(req), parse(schema.creatorCreateSchema, req.body, "body")) }));
export const updateCreator: RequestHandler = wrap(async (req) => ({ data: await service.updateCreator(user(req), idParam(req), parse(schema.creatorUpdateSchema, req.body, "body")) }));

export const searchMusic: RequestHandler = wrap(async (req) => ({ data: await service.searchMusic(user(req), parse(schema.musicQuerySchema, req.query, "query")) }));
export const listMusicMappings: RequestHandler = wrap(async (req) => ({ data: await service.listMusicMappings(user(req), idParam(req)) }));
export const createMusicMapping: RequestHandler = wrap(async (req) => ({ status: 201, data: await service.createMusicMapping(user(req), idParam(req), parse(schema.musicMappingCreateSchema, req.body, "body")) }));
export const verifyMusicMapping: RequestHandler = wrap(async (req) => ({ data: await service.verifyMusicMapping(user(req), idParam(req), parse(schema.musicVerifySchema, req.body, "body").profileId) }));
export const setMusicRights: RequestHandler = wrap(async (req) => ({ data: await service.setMusicRights(user(req), idParam(req), parse(schema.rightsConfirmSchema, req.body, "body")) }));
export const deleteMusicMapping: RequestHandler = wrap(async (req) => {
  await service.deleteMusicMapping(user(req), idParam(req));
  return { data: { deleted: true } };
});

// ------------------------------------------------------------------------------------ webhook --

/** Events that mean "an account's connection changed": answered with a (read-only) re-sync. */
const ACCOUNT_EVENTS = new Set(["social_account_connected", "social_account_disconnected", "social_account_reauth_required"]);

/**
 * POST /api/webhooks/upload-post — public (no session), authenticated ONLY by the HMAC signature over the RAW body.
 *  - no secret configured → 503 and nothing is processed;
 *  - bad/missing/stale signature → 401 (reason logged, never the secret or the body);
 *  - at-least-once delivery → de-duplicated on X-Upload-Post-Delivery;
 *  - the payload is a HINT: the worker re-reads the authoritative provider status before changing anything.
 */
export async function receiveWebhook(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const env = loadEnv();
    const secrets = [env.UPLOAD_POST_WEBHOOK_SECRET, env.UPLOAD_POST_WEBHOOK_SECRET_PREVIOUS].filter((s): s is string => Boolean(s));
    if (secrets.length === 0) {
      res.status(503).json({ success: false, error: { code: ERROR_CODES.CONFIGURATION_ERROR, message: "Webhook signing secret is not configured." } });
      return;
    }
    const raw = req.rawBody;
    if (!raw || raw.length === 0) throw new ApiHttpError(400, ERROR_CODES.INVALID_REQUEST, "Empty webhook body.");

    const verdict = verifyWebhookSignature({
      secrets,
      signatureHeader: req.header("x-upload-post-signature"),
      timestampHeader: req.header("x-upload-post-timestamp"),
      rawBody: raw,
    });
    if (!verdict.ok) {
      logger.warn({ reason: verdict.reason }, "upload-post webhook rejected");
      throw new ApiHttpError(401, ERROR_CODES.AUTH_REQUIRED, "Invalid webhook signature.");
    }

    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v[0] : v]));
    const event = parseWebhookEvent(raw, headers);
    if (!event) throw new ApiHttpError(400, ERROR_CODES.INVALID_REQUEST, "Unrecognized webhook payload.");

    // Without a delivery id, fall back to the body hash (identical retries still collapse).
    const deliveryId = event.deliveryId ?? `body:${createHash("sha256").update(raw).digest("hex")}`;
    try {
      await prisma.uploadPostWebhookDelivery.create({
        data: { deliveryId, event: event.event, attempt: event.attempt, requestId: event.requestId, jobId: event.jobId, externalId: event.externalId, outcome: "RECEIVED" },
      });
    } catch (err) {
      if ((err as { code?: string }).code === "P2002") {
        res.status(200).json({ success: true, data: { duplicate: true } });
        return;
      }
      throw err;
    }

    let outcome = "IGNORED";
    if (event.event === "upload_completed" && (event.requestId || event.jobId || event.externalId)) {
      const queued = await enqueueUploadPostReconcile({ requestId: event.requestId ?? undefined, jobId: event.jobId ?? undefined, externalId: event.externalId ?? undefined, deliveryId });
      outcome = queued ? "PROCESSED" : "FAILED";
    } else if (ACCOUNT_EVENTS.has(event.event)) {
      const orgs = await prisma.organization.findMany({ where: { status: "ACTIVE" }, select: { id: true }, take: 3 });
      const owner = resolveIntegrationOrganization(orgs.map((o) => o.id), env.UPLOAD_POST_ORGANIZATION_ID);
      outcome = owner.ok && (await enqueueUploadPostSync(owner.organizationId)) !== "NO_QUEUE" ? "PROCESSED" : "FAILED";
    }
    await prisma.uploadPostWebhookDelivery.update({ where: { deliveryId }, data: { outcome, processedAt: new Date() } });

    if (outcome === "FAILED") {
      // A 5xx makes the provider retry (the delivery row is released so the retry is processed, not treated as a duplicate).
      await prisma.uploadPostWebhookDelivery.delete({ where: { deliveryId } }).catch(() => undefined);
      res.status(503).json({ success: false, error: { code: ERROR_CODES.CONFIGURATION_ERROR, message: "Could not queue the event; retry later." } });
      return;
    }
    res.status(200).json({ success: true, data: { outcome } });
  } catch (err) {
    next(err);
  }
}
