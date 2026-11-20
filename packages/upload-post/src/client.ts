import { UploadPostError, classifyHttpError, redactSecrets } from "./errors.js";
import {
  normalizeHistory,
  normalizeMe,
  normalizeMusic,
  normalizeProfile,
  normalizeProfileList,
  normalizePublishAck,
  normalizeScheduledList,
  normalizeStatus,
  normalizeTikTokSettings,
} from "./normalize.js";
import type {
  TikTokMusicResult,
  TikTokSettings,
  UploadPostAccountInfo,
  UploadPostHistoryPage,
  UploadPostPhotoPublish,
  UploadPostProfileData,
  UploadPostProfileList,
  UploadPostPublishAck,
  UploadPostPublishCommon,
  UploadPostScheduledJob,
  UploadPostScheduledList,
  UploadPostStatus,
  UploadPostVideoPublish,
} from "./types.js";

export const DEFAULT_BASE_URL = "https://api.upload-post.com/api";

/** Minimal logger contract; the client only ever logs method/path/status/timing — never headers, bodies or the key. */
export interface UploadPostLogger {
  debug(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface UploadPostClientOptions {
  apiKey: string;
  /** Defaults to https://api.upload-post.com/api. Must be https, except for a loopback host (tests/mock server). */
  baseUrl?: string;
  /** Timeout for read calls (default 15 s). */
  timeoutMs?: number;
  /** Timeout for state-changing calls (publish/schedule/cancel; default 60 s — the provider itself switches to async after 59 s). */
  writeTimeoutMs?: number;
  /** Extra attempts for idempotent reads after a network error / timeout / 5xx / short 429 (default 2). */
  maxReadRetries?: number;
  /** A Retry-After longer than this is not waited out inside the client; the error carries retryAfterMs for the caller's queue (default 10 s). */
  maxInlineRetryDelayMs?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  logger?: UploadPostLogger;
}

interface RequestOptions {
  query?: Record<string, string | number | undefined>;
  json?: unknown;
  form?: FormData;
  headers?: Record<string, string>;
  /** Reads (GET) are retried; writes are not unless the caller opts in explicitly. */
  retry?: boolean;
  timeoutMs?: number;
  /** A write whose outcome becomes unknown on timeout/network error. */
  write?: boolean;
  /** 404 is returned as `null` instead of thrown (status lookups). */
  allowNotFound?: boolean;
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class UploadPostClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly writeTimeoutMs: number;
  private readonly maxReadRetries: number;
  private readonly maxInlineRetryDelayMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logger?: UploadPostLogger;

  constructor(options: UploadPostClientOptions) {
    if (!options.apiKey || options.apiKey.trim().length < 8) {
      throw new UploadPostError({ kind: "NOT_CONFIGURED", message: "Upload-Post API key is not configured.", retryable: false });
    }
    const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new UploadPostError({ kind: "NOT_CONFIGURED", message: "Upload-Post base URL is not a valid URL.", retryable: false });
    }
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback(parsed.hostname))) {
      throw new UploadPostError({
        kind: "NOT_CONFIGURED",
        message: "Upload-Post base URL must use https (plain http is only allowed for a loopback test server).",
        retryable: false,
      });
    }
    this.apiKey = options.apiKey.trim();
    this.baseUrl = baseUrl;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.writeTimeoutMs = options.writeTimeoutMs ?? 60_000;
    this.maxReadRetries = options.maxReadRetries ?? 2;
    this.maxInlineRetryDelayMs = options.maxInlineRetryDelayMs ?? 10_000;
    this.fetchImpl = options.fetch ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.logger = options.logger;
  }

  // -------------------------------------------------------------- core --

  private buildUrl(path: string, query?: RequestOptions["query"]): string {
    const url = new URL(`${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    }
    return url.toString();
  }

  private async request(method: string, path: string, opts: RequestOptions = {}): Promise<{ status: number; body: unknown } | null> {
    const maxAttempts = opts.retry ? this.maxReadRetries + 1 : 1;
    const timeoutMs = opts.timeoutMs ?? (opts.write ? this.writeTimeoutMs : this.timeoutMs);

    for (let attempt = 1; ; attempt++) {
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const headers: Record<string, string> = {
          Authorization: `Apikey ${this.apiKey}`,
          Accept: "application/json",
          ...opts.headers,
        };
        let body: FormData | string | undefined;
        if (opts.form) body = opts.form;
        else if (opts.json !== undefined) {
          headers["Content-Type"] = "application/json";
          body = JSON.stringify(opts.json);
        }

        const response = await this.fetchImpl(this.buildUrl(path, opts.query), { method, headers, body, signal: controller.signal });
        const text = await response.text();
        let parsed: unknown = null;
        if (text) {
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = { message: text.slice(0, 200) };
          }
        }
        this.logger?.debug({ method, path, status: response.status, ms: Date.now() - started, attempt }, "upload-post request");

        if (response.ok) return { status: response.status, body: parsed };
        if (response.status === 404 && opts.allowNotFound) return null;
        throw classifyHttpError(response.status, parsed, response.headers, [this.apiKey]);
      } catch (raw) {
        let error: UploadPostError;
        if (raw instanceof UploadPostError) {
          error = raw;
        } else if (controller.signal.aborted) {
          error = new UploadPostError({
            kind: "TIMEOUT",
            message: `Upload-Post did not answer within ${Math.round(timeoutMs / 1000)} s.`,
            retryable: true,
            outcomeUnknown: opts.write === true,
          });
        } else {
          const reason = raw instanceof Error ? redactSecrets(raw.message, [this.apiKey]) : "unknown error";
          error = new UploadPostError({
            kind: "NETWORK",
            message: `Could not reach Upload-Post (${reason.slice(0, 120)}).`,
            retryable: true,
            outcomeUnknown: opts.write === true,
          });
        }

        const canRetry = attempt < maxAttempts && error.retryable;
        const delay = error.retryAfterMs ?? Math.min(250 * 2 ** (attempt - 1) + Math.floor(Math.random() * 100), 5_000);
        if (!canRetry || delay > this.maxInlineRetryDelayMs) {
          this.logger?.warn({ method, path, kind: error.kind, httpStatus: error.httpStatus, errorCode: error.errorCode, attempt }, "upload-post request failed");
          throw error;
        }
        this.logger?.debug({ method, path, kind: error.kind, attempt, delayMs: delay }, "upload-post retrying read");
        await this.sleep(delay);
      } finally {
        clearTimeout(timer);
      }
    }
  }

  private async getJson(path: string, query?: RequestOptions["query"]): Promise<unknown> {
    const res = await this.request("GET", path, { query, retry: true });
    return res?.body ?? null;
  }

  // ------------------------------------------------ account / health --

  /** `GET /uploadposts/me` — validates the key and returns the account and plan. */
  async getMe(): Promise<UploadPostAccountInfo> {
    return normalizeMe(await this.getJson("/uploadposts/me"));
  }

  /** Validates the key and measures latency. Never throws for an unreachable/invalid provider: it reports it. */
  async ping(): Promise<
    | { ok: true; latencyMs: number; account: UploadPostAccountInfo }
    | { ok: false; latencyMs: number; error: UploadPostError }
  > {
    const started = Date.now();
    try {
      const account = await this.getMe();
      return { ok: true, latencyMs: Date.now() - started, account };
    } catch (err) {
      if (err instanceof UploadPostError) return { ok: false, latencyMs: Date.now() - started, error: err };
      throw err;
    }
  }

  // ---------------------------------------------------------- profiles --

  /** `GET /uploadposts/users` — all profiles, with their connected accounts, plan and profile limit. */
  async listProfiles(): Promise<UploadPostProfileList> {
    return normalizeProfileList(await this.getJson("/uploadposts/users"));
  }

  async getProfile(username: string): Promise<UploadPostProfileData | null> {
    const res = await this.request("GET", `/uploadposts/users/${encodeURIComponent(username)}`, { retry: true, allowNotFound: true });
    if (!res) return null;
    const body = res.body as { profile?: unknown } | null;
    return normalizeProfile(body?.profile);
  }

  /**
   * `POST /uploadposts/users`. Implemented and mock-tested, but NOT exposed by the
   * Socialith API in Phase 2 (read-only synchronization comes first) and never run live.
   */
  async createProfile(username: string, displayName?: string): Promise<UploadPostProfileData> {
    const res = await this.request("POST", "/uploadposts/users", {
      json: { username, ...(displayName ? { display_name: displayName } : {}) },
      write: true,
    });
    const profile = normalizeProfile((res?.body as { profile?: unknown } | null)?.profile);
    if (!profile) throw new UploadPostError({ kind: "UNKNOWN", message: "Upload-Post returned no profile.", retryable: false });
    return profile;
  }

  // ------------------------------------------------------------ TikTok --

  async getTikTokSettings(profile: string): Promise<TikTokSettings> {
    return normalizeTikTokSettings(await this.getJson("/uploadposts/tiktok/settings", { profile }));
  }

  async trendingTikTokMusic(params: { profile: string; genre?: string; countryCode?: string; dateRange?: string }): Promise<TikTokMusicResult> {
    return normalizeMusic(
      await this.getJson("/uploadposts/tiktok/music/trending", {
        profile: params.profile,
        genre: params.genre,
        country_code: params.countryCode,
        date_range: params.dateRange,
      }),
    );
  }

  async searchTikTokMusic(params: {
    profile: string;
    query: string;
    genre?: string;
    countryCode?: string;
    dateRange?: string;
    limit?: number;
  }): Promise<TikTokMusicResult> {
    return normalizeMusic(
      await this.getJson("/uploadposts/tiktok/music/search", {
        profile: params.profile,
        q: params.query.slice(0, 80),
        genre: params.genre,
        country_code: params.countryCode,
        date_range: params.dateRange,
        limit: params.limit,
      }),
    );
  }

  // -------------------------------------------------------- publishing --

  private commonForm(input: UploadPostPublishCommon, asyncUpload: boolean): FormData {
    if (input.externalId.length === 0 || input.externalId.length > 255) {
      throw new UploadPostError({ kind: "VALIDATION", message: "external_id must be 1-255 characters.", retryable: false });
    }
    const form = new FormData();
    form.set("user", input.profile);
    for (const p of input.platforms) form.append("platform[]", p);
    form.set("external_id", input.externalId);
    form.set("request_id", input.requestId);
    if (asyncUpload) form.set("async_upload", "true");
    if (input.title) form.set("title", input.title);
    if (input.description) form.set("description", input.description);
    if (input.scheduledDate) {
      form.set("scheduled_date", input.scheduledDate);
      form.set("timezone", input.timezone ?? "UTC");
    }
    for (const [k, v] of Object.entries(input.extraFields ?? {})) form.set(k, v);
    return form;
  }

  private publishHeaders(input: UploadPostPublishCommon): Record<string, string> {
    return { "Idempotency-Key": input.idempotencyKey, "X-External-Id": input.externalId };
  }

  /**
   * `POST /upload` with a video URL. Always asynchronous unless scheduled: the caller gets a
   * `request_id` (or a `job_id` when `scheduledDate` is set) and reconciles through getStatus/webhooks.
   * NEVER retried inside the client — on a timeout the error has `outcomeUnknown: true`.
   */
  async publishVideo(input: UploadPostVideoPublish): Promise<UploadPostPublishAck> {
    const form = this.commonForm(input, !input.scheduledDate);
    form.set("video", input.videoUrl);
    const res = await this.request("POST", "/upload", { form, headers: this.publishHeaders(input), write: true });
    return normalizePublishAck(res?.status ?? 0, res?.body);
  }

  /** `POST /upload_photos` with public HTTPS photo URLs. Same semantics as publishVideo. */
  async publishPhotos(input: UploadPostPhotoPublish): Promise<UploadPostPublishAck> {
    const form = this.commonForm(input, !input.scheduledDate);
    for (const url of input.photoUrls) form.append("photos[]", url);
    const res = await this.request("POST", "/upload_photos", { form, headers: this.publishHeaders(input), write: true });
    return normalizePublishAck(res?.status ?? 0, res?.body);
  }

  /** `GET /uploadposts/status` by request_id or job_id. A 404 is returned as status `not_found`, not thrown. */
  async getStatus(ref: { requestId?: string; jobId?: string }): Promise<UploadPostStatus> {
    if (!ref.requestId && !ref.jobId) {
      throw new UploadPostError({ kind: "VALIDATION", message: "request_id or job_id is required.", retryable: false });
    }
    const res = await this.request("GET", "/uploadposts/status", {
      query: { request_id: ref.requestId, job_id: ref.jobId },
      retry: true,
      allowNotFound: true,
    });
    if (!res) return { ...normalizeStatus({ status: "not_found" }), requestId: ref.requestId ?? null, jobId: ref.jobId ?? null };
    return normalizeStatus(res.body);
  }

  /** `GET /uploadposts/history` — used to find a publication by external_id after an unknown outcome. */
  async getHistory(params: {
    externalId?: string;
    requestId?: string;
    jobId?: string;
    profile?: string;
    platform?: string;
    status?: "success" | "failed";
    page?: number;
    limit?: 10 | 20 | 50 | 100;
  } = {}): Promise<UploadPostHistoryPage> {
    return normalizeHistory(
      await this.getJson("/uploadposts/history", {
        external_id: params.externalId,
        request_id: params.requestId,
        job_id: params.jobId,
        profile_username: params.profile,
        platform: params.platform,
        status: params.status,
        page: params.page,
        limit: params.limit,
      }),
    );
  }

  // --------------------------------------------------------- scheduling --

  /** `GET /uploadposts/schedule` — pending scheduled jobs (carry job_id and external_id). */
  async listScheduled(params: { profile?: string; from?: string; to?: string; limit?: number; offset?: number } = {}): Promise<UploadPostScheduledList> {
    return normalizeScheduledList(
      await this.getJson("/uploadposts/schedule", {
        profile_username: params.profile,
        from: params.from,
        to: params.to,
        limit: params.limit,
        offset: params.offset,
      }),
    );
  }

  async getScheduled(jobId: string): Promise<UploadPostScheduledJob | null> {
    const res = await this.request("GET", `/uploadposts/schedule/${encodeURIComponent(jobId)}`, { retry: true, allowNotFound: true });
    if (!res) return null;
    const body = res.body as Record<string, unknown> | null;
    return normalizeScheduledList({ scheduled_posts: [{ job_id: jobId, ...(body ?? {}) }] }).jobs[0] ?? null;
  }

  /** `DELETE /uploadposts/schedule/{job_id}` — cancels a pending job. A job that is already gone resolves with `alreadyGone: true`. */
  async cancelScheduled(jobId: string): Promise<{ cancelled: boolean; alreadyGone: boolean; creditsRefunded: number | null }> {
    const res = await this.request("DELETE", `/uploadposts/schedule/${encodeURIComponent(jobId)}`, { write: true, allowNotFound: true });
    if (!res) return { cancelled: false, alreadyGone: true, creditsRefunded: null };
    const refunded = (res.body as { credits_refunded?: unknown } | null)?.credits_refunded;
    return { cancelled: true, alreadyGone: false, creditsRefunded: typeof refunded === "number" ? refunded : null };
  }

  /**
   * `PATCH /uploadposts/schedule/{job_id}` — change the time/text of a pending job (media, profile and
   * platforms cannot change: cancel and re-schedule). A job publishing now / due within 60 s answers 409
   * `scheduled_post_in_progress` (kind CONFLICT).
   */
  async editScheduled(jobId: string, patch: { scheduledDate?: string; timezone?: string; title?: string; caption?: string }): Promise<void> {
    await this.request("PATCH", `/uploadposts/schedule/${encodeURIComponent(jobId)}`, {
      json: {
        ...(patch.scheduledDate ? { scheduled_date: patch.scheduledDate, timezone: patch.timezone ?? "UTC" } : {}),
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.caption !== undefined ? { caption: patch.caption } : {}),
      },
      write: true,
    });
  }
}
