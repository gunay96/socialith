import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

/**
 * A local, in-memory stand-in for the Upload-Post HTTP API, implementing the response shapes
 * the provider DOCUMENTS (docs/UPLOAD_POST_API_MAPPING.md). It exists so that:
 *   - CI and integration tests exercise the real HTTP client, real MySQL and real BullMQ
 *     without a paid account, a network, or ever publishing anything publicly;
 *   - failure modes the real service only shows rarely (429, 5xx, timeouts, reauth) are reproducible.
 * It is a test double: passing against it proves our handling of the DOCUMENTED contract, NOT that
 * the live service behaves identically. Live read-only checks are separate (UPLOAD_POST_TESTING.md).
 *
 * It never records the Authorization header's value, only whether the right key was presented.
 */

export interface MockSocialAccount {
  username: string;
  handle?: string;
  display_name?: string;
  social_images?: string;
  reauth_required?: boolean;
  capabilities?: string[];
}

export interface MockProfile {
  username: string;
  display_name: string | null;
  created_at: string;
  social_accounts: Record<string, MockSocialAccount | "" | null>;
}

export interface MockPublication {
  requestId: string;
  externalId: string | null;
  profile: string;
  platforms: string[];
  status: "pending" | "queued" | "processing" | "in_progress" | "completed" | "failed";
  results: Array<Record<string, unknown>>;
  fields: Record<string, string>;
  mediaType: "video" | "photo";
  jobId?: string;
}

export interface MockScheduledJob {
  jobId: string;
  externalId: string | null;
  profile: string;
  platforms: string[];
  scheduledDate: string;
  title: string | null;
  status: "pending" | "completed" | "failed" | "cancelled";
  fields: Record<string, string>;
  mediaType: "video" | "photo";
  /** When true, PATCH answers 409 scheduled_post_in_progress. */
  inProgress?: boolean;
}

export interface MockUploadPostState {
  apiKey: string;
  email: string;
  plan: string;
  profileLimit: number | null;
  profiles: MockProfile[];
  publications: Map<string, MockPublication>;
  jobs: Map<string, MockScheduledJob>;
  idempotency: Map<string, { status: number; body: unknown }>;
  /** Method + path (+ query) of every request, and whether it carried the right key. Never the key. */
  requests: Array<{ method: string; path: string; query: Record<string, string>; authorized: boolean; headers: Record<string, string | undefined> }>;
  duplicatesPrevented: number;
  tiktokSettings: Record<string, unknown>;
  music: Array<Record<string, unknown>>;
}

interface Scripted {
  match?: (method: string, path: string) => boolean;
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  delayMs?: number;
}

export interface MockUploadPostHandle {
  /** Base URL to give the client, e.g. http://127.0.0.1:41233/api */
  baseUrl: string;
  state: MockUploadPostState;
  /** Answer the next matching request(s) with this response instead of the normal one. */
  script(response: Scripted, times?: number): void;
  /** Delay every request BEFORE it is handled (ms) — the provider has not seen it yet. 0 clears. */
  setDelay(ms: number): void;
  /** Delay only the RESPONSE to publish calls, after the publication was created (ms): the provider processed it but the answer is "lost" to a client that times out. 0 clears. */
  setResponseDelay(ms: number): void;
  /** Move an async publication to a final state with per-platform results. */
  finishPublication(requestId: string, outcome: "completed" | "failed", results?: Array<Record<string, unknown>>): void;
  /** Run a scheduled job as the provider would at its time. */
  runScheduledJob(jobId: string, outcome?: "completed" | "failed"): void;
  close(): Promise<void>;
}

export function defaultProfiles(): MockProfile[] {
  return [
    {
      username: "acme_music",
      display_name: "Acme Music",
      created_at: "2025-04-02T17:44:33.229755",
      social_accounts: {
        tiktok: {
          username: "-000g91dgwXgwtNwcStableOpenId1",
          handle: "acme.music",
          display_name: "Acme Music",
          social_images: "https://cdn.example.test/acme-tiktok.jpg",
          reauth_required: false,
          capabilities: ["music", "location", "cover_image", "draft", "video_privacy"],
        },
        instagram: { username: "17841400000000001", handle: "acme.music", display_name: "Acme", reauth_required: false },
        youtube: { username: "UCacmeMusicChannel0001", handle: "@AcmeMusic", display_name: "Acme Music", reauth_required: true },
        facebook: "",
      },
    },
    {
      username: "label_two",
      display_name: null,
      created_at: "Fri, 02 May 2025 21:43:14 GMT",
      social_accounts: {
        tiktok: {
          username: "-000g91dgwXgwtNwcStableOpenId2",
          handle: "label.two",
          display_name: "Label Two",
          reauth_required: false,
          capabilities: ["comments"],
        },
        tiktok_pending: "",
      },
    },
  ];
}

export async function startMockUploadPostServer(options: { apiKey?: string } = {}): Promise<MockUploadPostHandle> {
  const state: MockUploadPostState = {
    apiKey: options.apiKey ?? "test-key-0000000000",
    email: "owner@acme.test",
    plan: "Business",
    profileLimit: 225,
    profiles: defaultProfiles(),
    publications: new Map(),
    jobs: new Map(),
    idempotency: new Map(),
    requests: [],
    duplicatesPrevented: 0,
    tiktokSettings: {
      success: true,
      privacy_level_options: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"],
      max_video_post_duration_sec: 600,
      comment_disabled: false,
      duet_disabled: false,
      stitch_disabled: false,
    },
    music: [
      { id: "7012345678901234567", commercial_music_id: "6987654321098765432", title: "Neon Skyline", artist: "Wave Theory", duration: 178, rank: 1, genres: ["POP"], cover_url: "https://cdn.example.test/c1.jpg", preview_url: "https://cdn.example.test/p1.mp3" },
      { id: "7012345678901234568", commercial_music_id: "6987654321098765433", title: "Midnight Drive", artist: "Wave Theory", duration: 201, rank: 2, genres: ["ELECTRONIC"], cover_url: null, preview_url: null },
    ],
  };
  const scripted: Scripted[] = [];
  let delayMs = 0;
  let responseDelayMs = 0;

  const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "Content-Type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };

  const readBody = async (req: IncomingMessage): Promise<Buffer> => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks);
  };

  const profileFor = (username: string) => state.profiles.find((p) => p.username.toLowerCase() === username.toLowerCase());

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://mock");
    const method = req.method ?? "GET";
    const path = url.pathname.replace(/^\/api/, "");
    const query = Object.fromEntries(url.searchParams.entries());
    const authorized = req.headers.authorization === `Apikey ${state.apiKey}`;
    state.requests.push({
      method,
      path,
      query,
      authorized,
      headers: {
        "idempotency-key": req.headers["idempotency-key"] as string | undefined,
        "x-external-id": req.headers["x-external-id"] as string | undefined,
      },
    });

    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));

    const idx = scripted.findIndex((s) => !s.match || s.match(method, path));
    if (idx >= 0) {
      const s = scripted[idx]!;
      scripted.splice(idx, 1);
      if (s.delayMs) await new Promise((r) => setTimeout(r, s.delayMs));
      return json(res, s.status, s.body, s.headers);
    }

    if (!authorized) return json(res, 401, { success: false, message: "Invalid or expired token" });

    // ---- account & profiles
    if (method === "GET" && path === "/uploadposts/me") {
      return json(res, 200, {
        success: true,
        message: "Token is valid",
        email: state.email,
        plan: state.plan,
        analyze_shorts: { limit: 300, used: 12, remaining: 288, resets_at: null },
        preferences: { weekStartDay: 1 },
      });
    }
    if (method === "GET" && path === "/uploadposts/users") {
      return json(res, 200, { success: true, limit: state.profileLimit, plan: state.plan.toLowerCase(), profiles: state.profiles });
    }
    const profileMatch = path.match(/^\/uploadposts\/users\/([^/]+)$/);
    if (method === "GET" && profileMatch) {
      const p = profileFor(decodeURIComponent(profileMatch[1]!));
      return p ? json(res, 200, { success: true, profile: p }) : json(res, 404, { success: false, message: "Profile not found" });
    }
    if (method === "POST" && path === "/uploadposts/users") {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}") as { username?: string; display_name?: string };
      if (!body.username) return json(res, 400, { success: false, message: "username required" });
      if (profileFor(body.username)) return json(res, 409, { success: false, message: "Username already in use" });
      if (state.profileLimit !== null && state.profiles.length >= state.profileLimit) {
        return json(res, 403, { success: false, error_code: "PROFILE_LIMIT_REACHED", current_profiles: state.profiles.length, profile_limit: state.profileLimit, message: "Profile limit reached for the current plan" });
      }
      const created: MockProfile = { username: body.username, display_name: body.display_name ?? null, created_at: new Date().toISOString(), social_accounts: {} };
      state.profiles.push(created);
      return json(res, 201, { success: true, profile: created });
    }

    // ---- TikTok
    const tiktokProfile = query.profile ? profileFor(query.profile) : undefined;
    if (path.startsWith("/uploadposts/tiktok/") && method === "GET") {
      if (!query.profile) return json(res, 400, { success: false, message: "profile is required" });
      if (!tiktokProfile) return json(res, 404, { success: false, error_code: "PROFILE_NOT_FOUND", message: "Profile not found" });
      const tt = tiktokProfile.social_accounts.tiktok;
      if (!tt || typeof tt !== "object") return json(res, 400, { success: false, error_code: "tiktok_reconnect_required", message: "No TikTok account connected" });
      if (tt.reauth_required) return json(res, 409, { success: false, reauth_required: true, message: "TikTok token expired" });
      if (path === "/uploadposts/tiktok/settings") return json(res, 200, state.tiktokSettings);
      if (!(tt.capabilities ?? []).includes("music")) {
        return json(res, 400, { success: false, error_code: "tiktok_reconnect_required", message: "Reconnect TikTok to enable music" });
      }
      if (path === "/uploadposts/tiktok/music/trending") {
        return json(res, 200, { success: true, genre: query.genre ?? "ALL", country_code: query.country_code ?? "US", date_range: query.date_range ?? "7DAY", tracks: state.music });
      }
      if (path === "/uploadposts/tiktok/music/search") {
        const q = (query.q ?? "").toLowerCase();
        const tracks = state.music.filter((t) => `${t.title} ${t.artist}`.toLowerCase().includes(q));
        return json(res, 200, { success: true, query: q, genre: query.genre ?? "ALL", country_code: query.country_code ?? "US", date_range: query.date_range ?? "7DAY", limit: 50, total: tracks.length, tracks, catalog: { tracks_indexed: state.music.length, genres_indexed: 1, cached: true } });
      }
    }

    // ---- publishing
    if (method === "POST" && (path === "/upload" || path === "/upload_photos")) {
      const idemKey = (req.headers["idempotency-key"] as string | undefined) ?? undefined;
      if (idemKey && state.idempotency.has(idemKey)) {
        state.duplicatesPrevented += 1;
        const prev = state.idempotency.get(idemKey)!;
        return json(res, prev.status, prev.body);
      }
      const form = await new Response(await readBody(req), { headers: { "content-type": String(req.headers["content-type"] ?? "") } }).formData();
      const fields: Record<string, string> = {};
      const platforms: string[] = [];
      for (const [k, v] of form.entries()) {
        if (k === "platform[]") platforms.push(String(v));
        else if (typeof v === "string") fields[k] = v;
      }
      const p = profileFor(fields.user ?? "");
      if (!p) return json(res, 404, { success: false, message: "Profile not found" });
      const connected = platforms.filter((pl) => {
        const a = p.social_accounts[pl];
        return a && typeof a === "object";
      });
      if (connected.length === 0) return json(res, 400, { success: false, message: "No requested platform is connected", invalid_platforms: Object.fromEntries(platforms.map((x) => [x, "profile_platform_not_configured"])) });

      const mediaType = path === "/upload" ? "video" : "photo";
      const externalId = fields.external_id ?? (req.headers["x-external-id"] as string | undefined) ?? null;
      const requestId = fields.request_id ?? randomUUID();
      let response: { status: number; body: unknown };

      if (fields.scheduled_date) {
        const jobId = `job_${randomUUID().slice(0, 12)}`;
        state.jobs.set(jobId, { jobId, externalId, profile: p.username, platforms, scheduledDate: new Date(fields.scheduled_date).toISOString(), title: fields.title ?? null, status: "pending", fields, mediaType });
        response = { status: 202, body: { success: true, job_id: jobId, scheduled_date: new Date(fields.scheduled_date).toISOString() } };
      } else {
        state.publications.set(requestId, { requestId, externalId, profile: p.username, platforms, status: "pending", results: [], fields, mediaType });
        response = { status: 200, body: { success: true, message: "Upload started", request_id: requestId, total_platforms: platforms.length } };
      }
      if (idemKey) state.idempotency.set(idemKey, response);
      if (responseDelayMs > 0) await new Promise((r) => setTimeout(r, responseDelayMs));
      return json(res, response.status, response.body);
    }

    // ---- status / history
    if (method === "GET" && path === "/uploadposts/status") {
      if (query.request_id) {
        const pub = state.publications.get(query.request_id);
        if (!pub) return json(res, 404, { request_id: query.request_id, status: "not_found", message: "No upload request found with this ID" });
        return json(res, 200, { request_id: pub.requestId, external_id: pub.externalId, status: pub.status, completed: pub.results.length, total: pub.platforms.length, results: pub.results, last_update: new Date().toISOString() });
      }
      if (query.job_id) {
        const job = state.jobs.get(query.job_id);
        if (!job) return json(res, 404, { job_id: query.job_id, status: "not_found", message: "No upload request found with this ID" });
        const results = job.status === "completed" ? job.platforms.map((pl) => ({ platform: pl, success: true, message: "Published", post_url: `https://example.test/${pl}/${job.jobId}`, platform_post_id: `${pl}-${job.jobId}` })) : [];
        return json(res, 200, { job_id: job.jobId, external_id: job.externalId, status: job.status === "cancelled" ? "failed" : job.status, completed: results.length, total: job.platforms.length, results, last_update: new Date().toISOString() });
      }
      return json(res, 400, { error: "request_id or job_id is required" });
    }
    if (method === "GET" && path === "/uploadposts/history") {
      const rows: Array<Record<string, unknown>> = [];
      for (const pub of state.publications.values()) {
        if (pub.status !== "completed" && pub.status !== "failed") continue;
        for (const r of pub.results) rows.push({ profile_username: pub.profile, platform: r.platform, media_type: pub.mediaType, success: r.success === true, platform_post_id: r.platform_post_id ?? null, post_url: r.post_url ?? null, error_message: r.error ?? null, post_title: pub.fields.title ?? null, upload_timestamp: new Date().toISOString(), is_async: true, request_id: pub.requestId, external_id: pub.externalId });
      }
      const filtered = rows.filter((r) => (!query.external_id || r.external_id === query.external_id) && (!query.request_id || r.request_id === query.request_id));
      const inProgress = [...state.publications.values()].filter((p) => p.status !== "completed" && p.status !== "failed" && (!query.external_id || p.externalId === query.external_id)).map((p) => ({ profile_username: p.profile, request_id: p.requestId, external_id: p.externalId, platform: p.platforms[0], media_type: p.mediaType, success: false, is_async: true }));
      return json(res, 200, { history: filtered, in_progress: inProgress, total: filtered.length, page: 1, limit: 10 });
    }

    // ---- scheduling
    if (method === "GET" && path === "/uploadposts/schedule") {
      const jobs = [...state.jobs.values()].filter((j) => j.status === "pending" && (!query.profile_username || j.profile === query.profile_username));
      return json(res, 200, { scheduled_posts: jobs.map((j) => ({ job_id: j.jobId, scheduled_date: j.scheduledDate, post_type: j.mediaType, title: j.title, external_id: j.externalId, platforms: j.platforms, profile_username: j.profile })), total: jobs.length, limit: 50, offset: 0 });
    }
    const jobMatch = path.match(/^\/uploadposts\/schedule\/([^/]+)$/);
    if (jobMatch) {
      const job = state.jobs.get(decodeURIComponent(jobMatch[1]!));
      if (!job || job.status === "cancelled") return json(res, 404, { success: false, message: "Job not found" });
      if (method === "GET") return json(res, 200, { success: true, job_id: job.jobId, scheduled_date: job.scheduledDate, title: job.title, external_id: job.externalId, platforms: job.platforms, editable: true });
      if (method === "DELETE") {
        job.status = "cancelled";
        return json(res, 200, { success: true, message: "Scheduled post cancelled", credits_refunded: 0 });
      }
      if (method === "PATCH") {
        if (job.inProgress || new Date(job.scheduledDate).getTime() - Date.now() < 60_000) {
          return json(res, 409, { success: false, error_code: "scheduled_post_in_progress", message: "The post is being published or is due within 60 seconds" });
        }
        const body = JSON.parse((await readBody(req)).toString("utf8") || "{}") as { scheduled_date?: string; title?: string };
        if (body.scheduled_date) job.scheduledDate = new Date(body.scheduled_date).toISOString();
        if (body.title !== undefined) job.title = body.title;
        return json(res, 200, { success: true, job_id: job.jobId });
      }
    }

    return json(res, 404, { success: false, message: `Mock: no route for ${method} ${path}` });
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((err) => json(res, 500, { success: false, message: err instanceof Error ? err.message : "mock error" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    baseUrl: `http://127.0.0.1:${port}/api`,
    state,
    script(response, times = 1) {
      for (let i = 0; i < times; i++) scripted.push(response);
    },
    setDelay(ms) {
      delayMs = ms;
    },
    setResponseDelay(ms) {
      responseDelayMs = ms;
    },
    finishPublication(requestId, outcome, results) {
      const pub = state.publications.get(requestId);
      if (!pub) throw new Error(`mock: unknown request ${requestId}`);
      pub.status = outcome;
      pub.results =
        results ??
        pub.platforms.map((pl) =>
          outcome === "completed"
            ? { platform: pl, success: true, status: "completed", message: "Published", post_url: `https://example.test/${pl}/${requestId}`, platform_post_id: `${pl}-${requestId}`, upload_timestamp: new Date().toISOString() }
            : { platform: pl, success: false, status: "failed", message: "Failed", error: "Platform rejected the upload", upload_timestamp: new Date().toISOString() },
        );
    },
    runScheduledJob(jobId, outcome = "completed") {
      const job = state.jobs.get(jobId);
      if (!job) throw new Error(`mock: unknown job ${jobId}`);
      job.status = outcome;
    },
    close() {
      return new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
  };
}
