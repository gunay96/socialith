import Redis from "ioredis";
import { Queue } from "bullmq";
import { loadEnv } from "@socialith/config";
import { QUEUE_NAMES, UPLOAD_POST_MANUAL_SYNC_JOB_ID, type UploadPostJobData } from "@socialith/types";
import { UploadPostClient, type UploadPostAccountInfo, type UploadPostError } from "@socialith/upload-post";
import { logger } from "../logger.js";

/**
 * Server-side Upload-Post plumbing for the API. The API key lives only in the server environment: it is never
 * serialized into a response, never logged, and never reaches the browser.
 */

let client: { key: string; baseUrl: string | undefined; instance: UploadPostClient } | null = null;

/** Null when no API key is configured ("not configured" is reported, never faked). */
export function getUploadPostClient(): UploadPostClient | null {
  const env = loadEnv();
  if (!env.UPLOAD_POST_API_KEY) return null;
  if (client && client.key === env.UPLOAD_POST_API_KEY && client.baseUrl === env.UPLOAD_POST_BASE_URL) return client.instance;
  const instance = new UploadPostClient({
    apiKey: env.UPLOAD_POST_API_KEY,
    baseUrl: env.UPLOAD_POST_BASE_URL,
    timeoutMs: env.UPLOAD_POST_TIMEOUT_MS,
    writeTimeoutMs: env.UPLOAD_POST_PUBLISH_TIMEOUT_MS,
    logger: {
      debug: (fields, message) => logger.debug({ provider: "upload-post", ...fields }, message),
      warn: (fields, message) => logger.warn({ provider: "upload-post", ...fields }, message),
    },
  });
  client = { key: env.UPLOAD_POST_API_KEY, baseUrl: env.UPLOAD_POST_BASE_URL, instance };
  return instance;
}

/** Test seam: drop the cached client (config changed). */
export function resetUploadPostClientForTests(): void {
  client = null;
  healthCache = null;
}

// ---- short-lived cache of the live health probe (the dashboard polls it) ----------------------------
export type HealthProbe =
  | { configured: false }
  | { configured: true; ok: true; latencyMs: number; checkedAt: string; account: UploadPostAccountInfo }
  | { configured: true; ok: false; latencyMs: number; checkedAt: string; errorKind: UploadPostError["kind"]; message: string; retryAfterMs: number | null };

const HEALTH_TTL_MS = 30_000;
let healthCache: { at: number; key: string; probe: HealthProbe } | null = null;

export async function probeProvider(force = false): Promise<HealthProbe> {
  const upload = getUploadPostClient();
  if (!upload) return { configured: false };
  const key = loadEnv().UPLOAD_POST_API_KEY!;
  if (!force && healthCache && healthCache.key === key && Date.now() - healthCache.at < HEALTH_TTL_MS) return healthCache.probe;

  const result = await upload.ping();
  const checkedAt = new Date().toISOString();
  const probe: HealthProbe = result.ok
    ? { configured: true, ok: true, latencyMs: result.latencyMs, checkedAt, account: result.account }
    : { configured: true, ok: false, latencyMs: result.latencyMs, checkedAt, errorKind: result.error.kind, message: result.error.message, retryAfterMs: result.error.retryAfterMs ?? null };
  healthCache = { at: Date.now(), key, probe };
  return probe;
}

// ---- queue (the worker does the heavy lifting; the API only enqueues) ---------------------------------
const connection = loadEnv().REDIS_URL ? new Redis(loadEnv().REDIS_URL!, { maxRetriesPerRequest: null }) : undefined;
connection?.on("error", (err) => logger.error({ err }, "Upload-Post queue Redis connection error"));
const uploadPostQueue = connection ? new Queue<UploadPostJobData>(QUEUE_NAMES.UPLOAD_POST, { connection }) : undefined;

export const uploadPostQueueAvailable = (): boolean => Boolean(uploadPostQueue);

/** Queues an on-demand sync. One manual sync at a time (deterministic job id); returns false when it was already queued. */
export async function enqueueUploadPostSync(organizationId: string): Promise<"QUEUED" | "ALREADY_QUEUED" | "NO_QUEUE"> {
  if (!uploadPostQueue) return "NO_QUEUE";
  const existing = await uploadPostQueue.getJob(UPLOAD_POST_MANUAL_SYNC_JOB_ID);
  if (existing) {
    const state = await existing.getState();
    if (state === "waiting" || state === "active" || state === "delayed") return "ALREADY_QUEUED";
    await existing.remove().catch(() => undefined);
  }
  await uploadPostQueue.add("upload-post-sync", { kind: "sync", trigger: "MANUAL", organizationId }, { jobId: UPLOAD_POST_MANUAL_SYNC_JOB_ID, removeOnComplete: true, removeOnFail: true });
  return "QUEUED";
}

/** Queues a webhook-triggered reconcile for one publication (hints only; the worker re-reads the provider status). */
export async function enqueueUploadPostReconcile(hint: { requestId?: string; jobId?: string; externalId?: string; deliveryId?: string }): Promise<boolean> {
  if (!uploadPostQueue) return false;
  await uploadPostQueue.add(
    "upload-post-reconcile",
    { kind: "reconcile", ...hint },
    { attempts: 5, backoff: { type: "exponential", delay: 5_000 }, removeOnComplete: true, removeOnFail: 100 },
  );
  return true;
}

export async function closeUploadPostQueue(): Promise<void> {
  await Promise.allSettled([uploadPostQueue?.close(), connection?.quit()]);
}
