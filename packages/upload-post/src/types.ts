/**
 * Normalized (provider-agnostic-ish) shapes the rest of Socialith consumes.
 * Upload-Post's raw JSON never leaves this package unparsed: `normalize.ts`
 * converts it, tolerating missing/extra fields (the provider documents
 * several response shapes inconsistently — see docs/UPLOAD_POST_API_MAPPING.md).
 */

export interface UploadPostAccountInfo {
  /** Account e-mail. PII: shown to admins, never logged. */
  email: string | null;
  /** Plan name exactly as the provider reports it, e.g. "Professional". */
  plan: string | null;
  weekStartDay: number | null;
  analyzeShorts: { limit: number; used: number; remaining: number; resetsAt: string | null } | null;
}

export interface UploadPostConnectedAccountData {
  /** Provider platform key, lower-case: tiktok, instagram, youtube, facebook, x, ... */
  platform: string;
  /**
   * The provider's STABLE account identifier (`social_accounts.<platform>.username`).
   * For TikTok this is the app-scoped open_id — it does not change when the user renames their @handle.
   */
  providerAccountId: string;
  /** The PUBLIC @handle. Can change when the user reconnects/renames — never use it as a key. */
  handle: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  /** The token expired / was revoked: the account must be reconnected before it can publish. */
  reauthRequired: boolean;
  /** Provider-reported capabilities (documented for TikTok: music, location, cover_image, ...). Open list. */
  capabilities: string[];
}

export interface UploadPostProfileData {
  /** Provider profile identifier (`username`): immutable, used as `user` on every publish call. */
  username: string;
  displayName: string | null;
  createdAt: Date | null;
  accounts: UploadPostConnectedAccountData[];
  /** Platforms the provider lists as started-but-not-finished (e.g. `tiktok_pending`). */
  pendingPlatforms: string[];
}

export interface UploadPostProfileList {
  /** Max profiles the CURRENT plan allows, as reported by the provider (never hard-coded here). */
  profileLimit: number | null;
  plan: string | null;
  profiles: UploadPostProfileData[];
}

export type UploadPostJobStatus =
  | "pending"
  | "queued"
  | "processing"
  | "in_progress"
  | "completed"
  | "failed"
  | "not_found";

export interface UploadPostPlatformResult {
  platform: string;
  success: boolean;
  /** queued | processing | completed | failed | retryable | skipped — as documented. */
  status: string | null;
  message: string | null;
  postUrl: string | null;
  platformPostId: string | null;
  skipped: boolean;
  skipReason: string | null;
  /** TikTok: the upload reached the creator's inbox/drafts, it is NOT live. */
  fallbackToInbox: boolean;
  error: string | null;
  uploadedAt: string | null;
}

export interface UploadPostStatus {
  status: UploadPostJobStatus;
  requestId: string | null;
  jobId: string | null;
  externalId: string | null;
  completed: number | null;
  total: number | null;
  results: UploadPostPlatformResult[];
  message: string | null;
  lastUpdate: string | null;
}

export interface UploadPostHistoryItem {
  profileUsername: string | null;
  platform: string | null;
  mediaType: string | null;
  success: boolean;
  platformPostId: string | null;
  postUrl: string | null;
  errorMessage: string | null;
  postTitle: string | null;
  uploadedAt: string | null;
  isAsync: boolean;
  jobId: string | null;
  requestId: string | null;
  externalId: string | null;
  fallbackToInbox: boolean;
}

export interface UploadPostHistoryPage {
  items: UploadPostHistoryItem[];
  inProgress: UploadPostHistoryItem[];
  total: number | null;
  page: number | null;
  limit: number | null;
}

export interface UploadPostScheduledJob {
  jobId: string;
  /** UTC ISO string. */
  scheduledDate: string | null;
  postType: string | null;
  title: string | null;
  externalId: string | null;
  platforms: string[];
  profileUsername: string | null;
}

export interface UploadPostScheduledList {
  jobs: UploadPostScheduledJob[];
  total: number | null;
  limit: number | null;
  offset: number | null;
}

export interface TikTokSettings {
  privacyLevelOptions: string[];
  maxVideoPostDurationSec: number | null;
  commentDisabled: boolean | null;
  duetDisabled: boolean | null;
  stitchDisabled: boolean | null;
}

export interface TikTokMusicTrack {
  /** Pass this as `tiktok_music_id`. */
  id: string;
  /** Reference only: the provider says publishing with it is rejected on public posts. */
  commercialMusicId: string | null;
  title: string;
  artist: string | null;
  durationSec: number | null;
  rank: number | null;
  genres: string[];
  coverUrl: string | null;
  previewUrl: string | null;
}

export interface TikTokMusicResult {
  tracks: TikTokMusicTrack[];
  /** Documented as a Commercial Music Library chart snapshot — NOT the whole TikTok catalogue. */
  scope: "COMMERCIAL_MUSIC_LIBRARY_CHARTS";
  total: number | null;
  genre: string | null;
  countryCode: string | null;
  dateRange: string | null;
}

/** Acknowledgement of a publish call. Only `COMPLETED_SYNC` carries final results. */
export type UploadPostPublishAck =
  | { kind: "ACCEPTED_ASYNC"; requestId: string; totalPlatforms: number | null }
  | { kind: "SCHEDULED"; jobId: string; scheduledDate: string | null }
  | { kind: "COMPLETED_SYNC"; requestId: string | null; results: UploadPostPlatformResult[] };

export interface UploadPostPublishCommon {
  /** Provider profile username (`user`). */
  profile: string;
  platforms: string[];
  /** Socialith correlation id, echoed by status/history/schedule/webhooks. Max 255 chars. NEVER the title. */
  externalId: string;
  /** Our own request id, so the outcome can be looked up even after a timeout. */
  requestId: string;
  /** Prevents a duplicate job when a retry follows a timeout (provider keeps it 24 h). */
  idempotencyKey: string;
  title?: string | null;
  description?: string | null;
  /** ISO-8601, future, ≤ 365 days. When set the response is a scheduled job_id. */
  scheduledDate?: string;
  timezone?: string;
  /** Platform-specific multipart fields, passed through verbatim (e.g. tiktok_music_id). */
  extraFields?: Record<string, string>;
}

export interface UploadPostVideoPublish extends UploadPostPublishCommon {
  videoUrl: string;
}

export interface UploadPostPhotoPublish extends UploadPostPublishCommon {
  photoUrls: string[];
}
