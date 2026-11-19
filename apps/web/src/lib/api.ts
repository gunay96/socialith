import type { ApiResponse } from "@socialith/types";

/**
 * The API's origin only (e.g. "http://localhost:4000") — never touched by
 * hand, always read from NEXT_PUBLIC_API_URL when it's set. When it's
 * NOT set, falls back to the real page origin in the browser (so a
 * single-origin reverse-proxy deployment — production's real Nginx
 * setup, or a local Cloudflare Tunnel demo whose URL isn't known at
 * build time — works with zero configuration, same-origin, no CORS
 * preflight at all) and to the local API dev port only when there's no
 * browser `window` to read an origin from at all (a build-time/SSR
 * evaluation context) — matches .env.example's documented local-dev
 * default.
 *
 * Every call site below passes a path that already starts with "/api/..."
 * (the exact same paths apps/api's routers mount, unchanged) — this
 * strips any trailing slash *and* a trailing "/api" from the configured
 * base first, so a base that was mistakenly set to ".../api" still joins
 * to exactly one "/api", never "/api/api".
 */
function resolveApiBaseUrl(): string {
  const configured = process.env.NEXT_PUBLIC_API_URL?.trim();
  const raw = configured || (typeof window !== "undefined" ? window.location.origin : "http://localhost:4000");
  return raw.replace(/\/+$/, "").replace(/\/api$/, "");
}

const API_BASE_URL = resolveApiBaseUrl();

/**
 * A real top-level browser navigation URL (used as an <a href>, never
 * fetched via JS) — OAuth start must be a genuine page navigation so the
 * platform's own consent screen renders and eventually redirects back,
 * not an XHR the app's own fetch() would just follow silently.
 */
export function buildOAuthStartUrl(platform: Platform): string {
  return `${API_BASE_URL}/api/oauth/${platform.toLowerCase()}/start`;
}

/** Thrown for every non-2xx or `{ success: false }` API response. Carries
 * the server's own error code/message unchanged — callers render
 * `error.message` as-is rather than inventing their own copy, so the
 * backend's enumeration-safe generic messages (login, forgot-password)
 * reach the user exactly as designed. */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message = "",
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      credentials: "include",
      headers: { "Content-Type": "application/json", ...init?.headers },
    });
  } catch {
    throw new ApiError(0, "NETWORK_ERROR", "Could not reach the server. Please try again.");
  }

  const body = (await res.json().catch(() => null)) as ApiResponse<T> | null;
  if (!body) {
    throw new ApiError(res.status, "INTERNAL_ERROR", "Unexpected server response.");
  }
  if (!body.success) {
    throw new ApiError(res.status, body.error.code, body.error.message);
  }
  return body.data;
}

export function apiGet<T>(path: string): Promise<T> {
  return apiRequest<T>(path, { method: "GET" });
}

export function apiPost<T>(path: string, data?: unknown): Promise<T> {
  return apiRequest<T>(path, {
    method: "POST",
    body: data === undefined ? undefined : JSON.stringify(data),
  });
}

export function apiPatch<T>(path: string, data: unknown): Promise<T> {
  return apiRequest<T>(path, { method: "PATCH", body: JSON.stringify(data) });
}

export function apiDelete<T>(path: string, data?: unknown): Promise<T> {
  return apiRequest<T>(path, {
    method: "DELETE",
    body: data === undefined ? undefined : JSON.stringify(data),
  });
}

/**
 * Real multipart upload — deliberately not routed through apiRequest():
 * that helper always sets "Content-Type: application/json", which would
 * break the multipart boundary the browser needs to set itself from the
 * FormData object. Used only by the Phase 07 asset-upload form.
 */
export async function apiUpload<T>(path: string, formData: FormData): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, { method: "POST", credentials: "include", body: formData });
  } catch {
    throw new ApiError(0, "NETWORK_ERROR", "Could not reach the server. Please try again.");
  }
  const body = (await res.json().catch(() => null)) as ApiResponse<T> | null;
  if (!body) throw new ApiError(res.status, "INTERNAL_ERROR", "Unexpected server response.");
  if (!body.success) throw new ApiError(res.status, body.error.code, body.error.message);
  return body.data;
}

/** Builds a "?a=1&b=2" query string, skipping undefined/empty values entirely rather than sending "a=undefined". */
export function buildQueryString(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : "";
}

/**
 * View-model types for the JSON shapes apps/api's auth/team routes
 * return. Not re-exports from @socialith/auth or apps/api's own
 * types/auth.ts — apps/web can't import either (one is a workspace
 * package apps/web has no dependency on, the other lives inside another
 * app's src/, not a publishable package) — so these are kept as small,
 * independent string-literal unions, the same pattern @socialith/auth's
 * own `Role` type already uses to stay dependency-free.
 */
export type Role = "OWNER" | "ADMIN" | "EDITOR" | "VIEWER";
export type UserStatus = "ACTIVE" | "INVITED" | "DISABLED" | "REMOVED";

export interface SafeUser {
  id: string;
  organizationId: string;
  name: string;
  email: string;
  role: Role;
  status: UserStatus;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface TeamMember {
  id: string;
  name: string;
  email: string;
  role: Role;
  status: UserStatus;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface PendingInvitation {
  id: string;
  email: string;
  role: Role;
  expiresAt: string;
  createdAt: string;
  invitedById: string;
}

export interface TeamListing {
  members: TeamMember[];
  pendingInvitations: PendingInvitation[];
}

export interface InvitationPreview {
  email: string;
  role: Role;
  organizationName: string;
  expiresAt: string;
}

export interface CreateInvitationResult {
  invitation: { id: string; email: string; role: Role; expiresAt: string; createdAt: string };
  devAcceptUrl?: string;
}

/** Roles an invitation can grant — OWNER is deliberately excluded, mirroring
 * apps/api's invitableRoleSchema (the server rejects it either way; this
 * just keeps the form from offering a choice that always fails). */
export const INVITABLE_ROLES: Role[] = ["ADMIN", "EDITOR", "VIEWER"];

// ── Phase 04: Connected Accounts ──────────────────────────────────────
export type Platform = "TIKTOK" | "INSTAGRAM" | "YOUTUBE";
export type SocialAccountStatus = "CONNECTED" | "DISCONNECTED" | "EXPIRED" | "ERROR";

export const PLATFORMS: Platform[] = ["TIKTOK", "INSTAGRAM", "YOUTUBE"];
export const SOCIAL_ACCOUNT_STATUSES: SocialAccountStatus[] = [
  "CONNECTED",
  "DISCONNECTED",
  "EXPIRED",
  "ERROR",
];

/** Mirrors apps/api's SocialAccount repository type exactly — this table
 * holds no credential fields by design (see schema.prisma), so nothing
 * here needs redacting. */
export interface SocialAccount {
  id: string;
  organizationId: string;
  platform: Platform;
  externalAccountId: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  status: SocialAccountStatus;
  followerCount: number | null;
  lastSyncedAt: string | null;
  lastErrorMessage: string | null;
  providerMetadata: unknown;
  connectedById: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ListSocialAccountsResult {
  items: SocialAccount[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ConnectionSummary {
  scopes: string[];
  tokenExpiresAt: string | null;
  lastRefreshedAt: string | null;
  hasActiveCredential: boolean;
}

export interface SocialAccountDetail extends SocialAccount {
  connection: ConnectionSummary | null;
}

export interface ListSocialAccountsParams {
  search?: string;
  platform?: Platform;
  status?: SocialAccountStatus;
  page?: number;
  pageSize?: number;
}

// ── Phase 05: Campaigns & Content ─────────────────────────────────────
export type CampaignStatus = "DRAFT" | "ACTIVE" | "COMPLETED";
export const CAMPAIGN_STATUSES: CampaignStatus[] = ["DRAFT", "ACTIVE", "COMPLETED"];

export interface Campaign {
  id: string;
  organizationId: string;
  name: string;
  description: string | null;
  status: CampaignStatus;
  startAt: string | null;
  endAt: string | null;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ListCampaignsResult {
  items: Campaign[];
  total: number;
  page: number;
  pageSize: number;
}

export type ContentStatus =
  | "DRAFT"
  | "GENERATED"
  | "READY"
  | "SCHEDULED"
  | "PUBLISHING"
  | "PUBLISHED"
  | "FAILED";
export const CONTENT_STATUSES: ContentStatus[] = [
  "DRAFT",
  "GENERATED",
  "READY",
  "SCHEDULED",
  "PUBLISHING",
  "PUBLISHED",
  "FAILED",
];

export interface Content {
  id: string;
  organizationId: string;
  campaignId: string | null;
  soundId: string | null;
  caption: string | null;
  status: ContentStatus;
  scheduledAt: string | null;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ContentListItem extends Content {
  _count: { targets: number };
}

export interface ListContentResult {
  items: ContentListItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ContentVariation {
  id: string;
  contentId: string;
  platform: Platform;
  title: string | null;
  caption: string | null;
  metadata: unknown;
  createdAt: string;
  updatedAt: string;
}

export type AssetType = "IMAGE" | "VIDEO" | "AUDIO" | "THUMBNAIL";

export interface ContentAsset {
  id: string;
  contentId: string;
  type: AssetType;
  platform: Platform | null;
  url: string;
  metadata: unknown;
  createdAt: string;
}

export interface ContentDetail extends ContentListItem {
  variations: ContentVariation[];
  assets: ContentAsset[];
  sound: Sound | null;
}

export type ContentTargetStatus = "PENDING" | "SCHEDULED" | "PUBLISHING" | "PUBLISHED" | "FAILED";

export interface ContentTarget {
  id: string;
  contentId: string;
  socialAccountId: string;
  status: ContentTargetStatus;
  scheduledAt: string | null;
  publishedAt: string | null;
  externalPostId: string | null;
  externalPostUrl: string | null;
  /** A real, honest caveat when COMPLETE doesn't mean "live" — e.g. TikTok's real Upload/Inbox flow delivers to the account's TikTok inbox, not to public view. Null when PUBLISHED genuinely means live. */
  deliveryNote: string | null;
  errorMessage: string | null;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
  socialAccount: { id: string; platform: Platform; handle: string; displayName: string; status: SocialAccountStatus };
}

export interface ListContentTargetsResult {
  items: ContentTarget[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AssignTargetsResult {
  assigned: number;
  requested: number;
  skipped: string[];
}

// ── Phase 07: content generation + video render ───────────────────────
export type JobStatus = "PENDING" | "PROCESSING" | "SUCCEEDED" | "FAILED";

export interface ContentGenerationJob {
  id: string;
  contentId: string;
  platform: Platform | null;
  status: JobStatus;
  attempts: number;
  errorMessage: string | null;
  resultVariationId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type VideoRenderOperation = "THUMBNAIL";

export interface VideoRenderJob {
  id: string;
  contentId: string;
  sourceAssetId: string;
  operation: VideoRenderOperation;
  status: JobStatus;
  attempts: number;
  errorMessage: string | null;
  resultAssetId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A job list is still "in flight" (worth polling) while any entry is PENDING/PROCESSING. */
export function hasActiveJob(jobs: { status: JobStatus }[]): boolean {
  return jobs.some((j) => j.status === "PENDING" || j.status === "PROCESSING");
}

// ── Phase 08: publishing ────────────────────────────────────────────
export type PublishAttemptStatus = "SUCCEEDED" | "FAILED";

export interface PublishAttempt {
  id: string;
  contentTargetId: string;
  attemptNumber: number;
  status: PublishAttemptStatus;
  errorCode: string | null;
  errorMessage: string | null;
  httpStatusCode: number | null;
  retryable: boolean | null;
  externalPostId: string | null;
  externalPostUrl: string | null;
  rateLimitResetAt: string | null;
  startedAt: string;
  completedAt: string;
  createdAt: string;
}

/** A target's publishing has genuinely stalled (as opposed to not-yet-scheduled) only once it's SCHEDULED/PUBLISHING/FAILED — used to decide whether "still waiting" UI copy applies. */
export function isPublishingInFlight(status: ContentTargetStatus): boolean {
  return status === "SCHEDULED" || status === "PUBLISHING";
}

// ── Phase 09: music/sound library + analytics ──────────────────────────
export type SoundStatus = "ACTIVE" | "ARCHIVED";

export interface Sound {
  id: string;
  organizationId: string;
  title: string;
  artist: string | null;
  platform: Platform;
  externalSoundId: string | null;
  soundUrl: string | null;
  artworkUrl: string | null;
  status: SoundStatus;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SoundUsage {
  contentCount: number;
  targetCount: number;
  publishedTargetCount: number;
}

export interface SoundDetail extends Sound {
  usage: SoundUsage;
}

export interface ListSoundsResult {
  items: Sound[];
  total: number;
  page: number;
  pageSize: number;
}

export interface MetricsRollup {
  targetCount: number;
  publishedCount: number;
  syncedCount: number;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  shareCount: number;
}

export interface PostMetricsSnapshot {
  id: string;
  contentTargetId: string;
  platform: Platform;
  viewCount: number | null;
  likeCount: number | null;
  commentCount: number | null;
  shareCount: number | null;
  fetchedAt: string;
}

// ── Phase 10: OAuth, capabilities, dashboard ───────────────────────────
export type CapabilityStatus = "SUPPORTED" | "PARTIAL" | "REQUIRES_APPROVAL" | "NOT_SUPPORTED" | "NOT_APPLICABLE";

export interface CapabilityDetail {
  status: CapabilityStatus;
  note: string;
}

export interface PlatformCapabilities {
  videoPublishing: CapabilityDetail;
  photoPublishing: CapabilityDetail;
  analytics: CapabilityDetail;
  soundAttachment: CapabilityDetail;
}

export type PlatformCapabilitiesMap = Record<Platform, PlatformCapabilities>;

export interface DashboardData {
  accounts: { total: number; connected: number; expired: number; error: number; disconnected: number };
  activeCampaigns: number;
  scheduledContent: number;
  publishingNow: number;
  publishedLast30d: number;
  failedLast30d: number;
  metrics: MetricsRollup;
  topContent: { id: string; label: string; viewCount: number }[];
  topSounds: { id: string; label: string; viewCount: number }[];
}
