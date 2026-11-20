import type {
  TikTokMusicResult,
  TikTokMusicTrack,
  TikTokSettings,
  UploadPostAccountInfo,
  UploadPostConnectedAccountData,
  UploadPostHistoryItem,
  UploadPostHistoryPage,
  UploadPostJobStatus,
  UploadPostPlatformResult,
  UploadPostProfileData,
  UploadPostProfileList,
  UploadPostPublishAck,
  UploadPostScheduledJob,
  UploadPostScheduledList,
  UploadPostStatus,
} from "./types.js";

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const strArr = (v: unknown): string[] => arr(v).filter((x): x is string => typeof x === "string");

/**
 * The provider documents two timestamp formats for `created_at`:
 * "2025-04-02T17:44:33.229755" (no zone — UTC) and "Fri, 02 May 2025 21:43:14 GMT".
 */
export function parseProviderDate(value: unknown): Date | null {
  const s = str(value);
  if (!s) return null;
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2}|GMT|UTC)$/i.test(s);
  const iso = /^\d{4}-\d{2}-\d{2}T/.test(s) && !hasZone ? `${s}Z` : s;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function normalizeMe(body: unknown): UploadPostAccountInfo {
  const b = isObj(body) ? body : {};
  const shorts = isObj(b.analyze_shorts) ? b.analyze_shorts : null;
  const prefs = isObj(b.preferences) ? b.preferences : null;
  return {
    email: str(b.email),
    plan: str(b.plan),
    weekStartDay: prefs ? num(prefs.weekStartDay) : null,
    analyzeShorts: shorts
      ? {
          limit: num(shorts.limit) ?? 0,
          used: num(shorts.used) ?? 0,
          remaining: num(shorts.remaining) ?? 0,
          resetsAt: str(shorts.resets_at),
        }
      : null,
  };
}

function normalizeAccount(platformKey: string, raw: unknown): UploadPostConnectedAccountData | null {
  if (!isObj(raw)) return null; // "" / null / missing = not connected
  const providerAccountId = str(raw.username);
  if (!providerAccountId) return null; // started but no stable id yet: treated as pending by the caller
  return {
    platform: platformKey.toLowerCase(),
    providerAccountId,
    handle: str(raw.handle),
    displayName: str(raw.display_name),
    avatarUrl: str(raw.social_images),
    reauthRequired: raw.reauth_required === true,
    capabilities: strArr(raw.capabilities),
  };
}

export function normalizeProfile(raw: unknown): UploadPostProfileData | null {
  if (!isObj(raw)) return null;
  const username = str(raw.username);
  if (!username) return null;

  const accounts: UploadPostConnectedAccountData[] = [];
  const pending = new Set<string>();
  const social = isObj(raw.social_accounts) ? raw.social_accounts : {};
  for (const [key, value] of Object.entries(social)) {
    if (key.endsWith("_pending")) {
      if (value) pending.add(key.slice(0, -"_pending".length).toLowerCase());
      continue;
    }
    const account = normalizeAccount(key, value);
    if (account) accounts.push(account);
    else if (isObj(value)) pending.add(key.toLowerCase()); // object without a stable id
  }
  // a platform that is both connected and "pending" is simply connected
  for (const a of accounts) pending.delete(a.platform);

  return {
    username,
    displayName: str(raw.display_name),
    createdAt: parseProviderDate(raw.created_at),
    blocked: raw.blocked === true,
    accounts,
    pendingPlatforms: [...pending].sort(),
  };
}

export function normalizeProfileList(body: unknown): UploadPostProfileList {
  const b = isObj(body) ? body : {};
  const profiles = arr(b.profiles)
    .map(normalizeProfile)
    .filter((p): p is UploadPostProfileData => p !== null);
  return { profileLimit: num(b.limit), plan: str(b.plan), profiles };
}

function normalizePlatformResult(raw: unknown, fallbackPlatform?: string): UploadPostPlatformResult | null {
  if (!isObj(raw)) return null;
  const platform = str(raw.platform) ?? fallbackPlatform ?? null;
  if (!platform) return null;
  return {
    platform: platform.toLowerCase(),
    success: raw.success === true,
    status: str(raw.status),
    message: str(raw.message),
    postUrl: str(raw.post_url) ?? str(raw.url),
    platformPostId: str(raw.platform_post_id) ?? str(raw.post_id) ?? str(raw.video_id),
    skipped: raw.skipped === true,
    skipReason: str(raw.skip_reason),
    fallbackToInbox: raw.fallback_to_inbox === true,
    error: str(raw.error) ?? str(raw.error_message),
    uploadedAt: str(raw.upload_timestamp),
  };
}

const JOB_STATUSES = new Set<UploadPostJobStatus>([
  "pending",
  "queued",
  "processing",
  "in_progress",
  "completed",
  "failed",
  "not_found",
]);

export function normalizeStatus(body: unknown): UploadPostStatus {
  const b = isObj(body) ? body : {};
  const rawStatus = str(b.status)?.toLowerCase() ?? "";
  const status: UploadPostJobStatus = JOB_STATUSES.has(rawStatus as UploadPostJobStatus)
    ? (rawStatus as UploadPostJobStatus)
    : "pending";
  return {
    status,
    requestId: str(b.request_id),
    jobId: str(b.job_id),
    externalId: str(b.external_id),
    completed: num(b.completed),
    total: num(b.total),
    results: arr(b.results)
      .map((r) => normalizePlatformResult(r))
      .filter((r): r is UploadPostPlatformResult => r !== null),
    message: str(b.message),
    lastUpdate: str(b.last_update),
  };
}

function normalizeHistoryItem(raw: unknown): UploadPostHistoryItem | null {
  if (!isObj(raw)) return null;
  return {
    profileUsername: str(raw.profile_username),
    platform: str(raw.platform)?.toLowerCase() ?? null,
    mediaType: str(raw.media_type),
    success: raw.success === true,
    platformPostId: str(raw.platform_post_id),
    postUrl: str(raw.post_url),
    errorMessage: str(raw.error_message),
    postTitle: str(raw.post_title),
    uploadedAt: str(raw.upload_timestamp),
    isAsync: raw.is_async === true,
    jobId: str(raw.job_id),
    requestId: str(raw.request_id),
    externalId: str(raw.external_id),
    fallbackToInbox: raw.fallback_to_inbox === true,
  };
}

export function normalizeHistory(body: unknown): UploadPostHistoryPage {
  const b = isObj(body) ? body : {};
  const toItems = (v: unknown) => arr(v).map(normalizeHistoryItem).filter((i): i is UploadPostHistoryItem => i !== null);
  return { items: toItems(b.history), inProgress: toItems(b.in_progress), total: num(b.total), page: num(b.page), limit: num(b.limit) };
}

function normalizeScheduledJob(raw: unknown): UploadPostScheduledJob | null {
  if (!isObj(raw)) return null;
  const jobId = str(raw.job_id);
  if (!jobId) return null;
  return {
    jobId,
    scheduledDate: str(raw.scheduled_date),
    postType: str(raw.post_type),
    title: str(raw.title),
    externalId: str(raw.external_id),
    platforms: strArr(raw.platforms).map((p) => p.toLowerCase()),
    profileUsername: str(raw.profile_username) ?? str(raw.user),
  };
}

export function normalizeScheduledList(body: unknown): UploadPostScheduledList {
  const b = isObj(body) ? body : {};
  return {
    jobs: arr(b.scheduled_posts)
      .map(normalizeScheduledJob)
      .filter((j): j is UploadPostScheduledJob => j !== null),
    total: num(b.total),
    limit: num(b.limit),
    offset: num(b.offset),
  };
}

export function normalizeTikTokSettings(body: unknown): TikTokSettings {
  const b = isObj(body) ? body : {};
  const flag = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
  return {
    privacyLevelOptions: strArr(b.privacy_level_options),
    maxVideoPostDurationSec: num(b.max_video_post_duration_sec),
    commentDisabled: flag(b.comment_disabled),
    duetDisabled: flag(b.duet_disabled),
    stitchDisabled: flag(b.stitch_disabled),
  };
}

function normalizeTrack(raw: unknown): TikTokMusicTrack | null {
  if (!isObj(raw)) return null;
  const id = str(raw.id) ?? (typeof raw.id === "number" ? String(raw.id) : null);
  const title = str(raw.title);
  if (!id || !title) return null;
  return {
    id,
    commercialMusicId: str(raw.commercial_music_id),
    title,
    artist: str(raw.artist),
    durationSec: num(raw.duration),
    rank: num(raw.rank),
    genres: strArr(raw.genres),
    coverUrl: str(raw.cover_url),
    previewUrl: str(raw.preview_url),
  };
}

export function normalizeMusic(body: unknown): TikTokMusicResult {
  const b = isObj(body) ? body : {};
  return {
    tracks: arr(b.tracks)
      .map(normalizeTrack)
      .filter((t): t is TikTokMusicTrack => t !== null),
    scope: "COMMERCIAL_MUSIC_LIBRARY_CHARTS",
    total: num(b.total),
    genre: str(b.genre),
    countryCode: str(b.country_code),
    dateRange: str(b.date_range),
  };
}

/** Interprets the three documented publish responses: sync (results), async (request_id), scheduled (job_id). */
export function normalizePublishAck(httpStatus: number, body: unknown): UploadPostPublishAck {
  const b = isObj(body) ? body : {};
  const jobId = str(b.job_id);
  if (jobId) return { kind: "SCHEDULED", jobId, scheduledDate: str(b.scheduled_date) };

  if (isObj(b.results)) {
    const results = Object.entries(b.results)
      .map(([platform, r]) => normalizePlatformResult(r, platform))
      .filter((r): r is UploadPostPlatformResult => r !== null);
    return { kind: "COMPLETED_SYNC", requestId: str(b.request_id), results };
  }

  const requestId = str(b.request_id);
  if (requestId) return { kind: "ACCEPTED_ASYNC", requestId, totalPlatforms: num(b.total_platforms) };

  throw new Error(`Unrecognized Upload-Post publish response (HTTP ${httpStatus}).`);
}
