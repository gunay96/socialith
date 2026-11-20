"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet, ApiError } from "@/lib/api";

/** Shapes returned by /api/upload-post/* (see apps/api/src/services/upload-post.service.ts). Only what the UI reads. */

export type ProviderStatus = "CONNECTED" | "DISCONNECTED" | "SYNC_PENDING" | "SYNC_FAILED" | "LIMIT_REACHED";
export type AccountStatus = "CONNECTED" | "REAUTH_REQUIRED" | "DISCONNECTED";

export interface UploadPostAccountRow {
  id: string;
  platform: string;
  providerAccountId: string;
  handle: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  status: AccountStatus;
  capabilities: string[] | null;
  creatorId: string | null;
  creator: { id: string; name: string } | null;
  profile: { id: string; username: string; displayName: string | null; status: string };
  socialAccount: { id: string; status: string } | null;
  sharedAcrossProfiles?: boolean;
  publishable?: boolean;
  lastSeenAt: string | null;
}

export interface UploadPostProfileRow {
  id: string;
  username: string;
  displayName: string | null;
  status: "ACTIVE" | "REMOVED";
  blocked?: boolean;
  pendingPlatforms: string[] | null;
  lastSyncedAt: string | null;
  managedPageId: string | null;
  managedPage: { id: string; name: string; slug: string } | null;
  accounts: UploadPostAccountRow[];
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ManagedPageRow {
  id: string;
  name: string;
  slug: string;
  status: "ACTIVE" | "ARCHIVED";
  _count?: { uploadPostProfiles: number };
}
export interface CreatorRow {
  id: string;
  name: string;
  status: "ACTIVE" | "ARCHIVED";
  _count?: { uploadPostAccounts: number };
}

export interface ProviderProbe {
  configured: boolean;
  ok?: boolean;
  latencyMs?: number;
  checkedAt?: string;
  errorKind?: string;
  message?: string;
  retryAfterMs?: number | null;
  account?: { plan: string | null; email: string | null; analyzeShorts: { limit: number; used: number; remaining: number; resetsAt: string | null } | null };
}

export interface IntegrationContext {
  configured: boolean;
  organizationOwnsKey: boolean;
  organizationIssue: string | null;
  handoff: { enabled: boolean; windowHours: number };
  syncIntervalMinutes: number;
  webhookConfigured: boolean;
  provider: ProviderProbe;
}

export interface Overview extends IntegrationContext {
  status: ProviderStatus;
  profiles: { active: number; removed: number; unmapped: number; limit: number | null };
  accounts: { byStatus: Record<string, number>; byPlatform: Record<string, number>; unmapped: number; destinations: number };
  publications: Record<string, number>;
  mapping: { managedPages: number; creators: number };
  lastSync: { id: string; status: string; trigger: string; startedAt: string; finishedAt: string | null; errorKind: string | null; errorMessage: string | null } | null;
  lastSuccessfulSyncAt: string | null;
}

export type PlatformState = "AVAILABLE" | "REAUTH_REQUIRED" | "PENDING" | "UNAVAILABLE";

export interface PlatformAvailability {
  platform: string;
  label: string;
  publishable: boolean;
  state: PlatformState;
  reason: string | null;
  accounts: { connected: number; reauthRequired: number; pending: number; disconnected: number };
  destinations: number;
  connectableProfiles: { id: string; username: string }[];
  features: { key: string; label: string; state: "AVAILABLE" | "UNAVAILABLE"; reason: string | null }[];
}

export interface Capabilities {
  synced: boolean;
  lastSyncedAt: string | null;
  plan: { name: string | null; profileLimit: number | null; profilesUsed: number; profilesRemaining: number | null };
  platforms: PlatformAvailability[];
  notes: string[];
}

export interface PublicationRow {
  id: string;
  status: string;
  mode: string;
  platform: string;
  profileUsername: string;
  externalId: string;
  providerJobId: string | null;
  requestId: string;
  scheduledFor: string | null;
  lastErrorKind: string | null;
  lastErrorMessage: string | null;
  notes: string | null;
  updatedAt: string;
  completedAt: string | null;
  contentTarget: { id: string; status: string; content: { id: string; caption: string | null }; socialAccount: { id: string; handle: string; platform: string } };
}

/** Minimal data hook: loads once, exposes reload, never swallows the server's own error message. */
export function useFetch<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (path === null) return;
    let cancelled = false;
    setLoading(true);
    apiGet<T>(path)
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : "Something went wrong.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}

// ------------------------------------------------------------------------------- presentation --

const BADGE_BASE = "inline-flex items-center rounded border px-2 py-0.5 text-xs font-medium tracking-wide whitespace-nowrap";
const GREEN = "border-green-900 bg-green-950/40 text-green-400";
const RED = "border-red-900 bg-red-950/40 text-red-400";
const AMBER = "border-amber-900 bg-amber-950/40 text-amber-400";
const BLUE = "border-sky-900 bg-sky-950/40 text-sky-400";
const NEUTRAL = "border-border bg-surface text-muted";

const STATUS_STYLES: Record<string, { label: string; tone: string }> = {
  CONNECTED: { label: "CONNECTED", tone: GREEN },
  DISCONNECTED: { label: "DISCONNECTED", tone: RED },
  REAUTH_REQUIRED: { label: "REAUTH REQUIRED", tone: AMBER },
  SYNC_PENDING: { label: "SYNC PENDING", tone: BLUE },
  SYNC_FAILED: { label: "SYNC FAILED", tone: RED },
  LIMIT_REACHED: { label: "LIMIT REACHED", tone: AMBER },
  // publication / target states
  COMPLETED: { label: "COMPLETED", tone: GREEN },
  PUBLISHED: { label: "PUBLISHED", tone: GREEN },
  PROCESSING: { label: "PROCESSING", tone: BLUE },
  PENDING: { label: "PENDING", tone: NEUTRAL },
  SCHEDULED_AT_PROVIDER: { label: "SCHEDULED AT PROVIDER", tone: BLUE },
  FAILED: { label: "FAILED", tone: RED },
  CANCELLED: { label: "CANCELLED", tone: NEUTRAL },
  UNKNOWN_OUTCOME: { label: "OUTCOME UNKNOWN", tone: AMBER },
  ACTIVE: { label: "ACTIVE", tone: GREEN },
  REMOVED: { label: "REMOVED", tone: RED },
  SUCCEEDED: { label: "SUCCEEDED", tone: GREEN },
  RUNNING: { label: "RUNNING", tone: BLUE },
  VERIFIED_AVAILABLE: { label: "VERIFIED AVAILABLE", tone: GREEN },
  UNVERIFIED: { label: "UNVERIFIED", tone: NEUTRAL },
  UNAVAILABLE: { label: "UNAVAILABLE", tone: RED },
  AVAILABLE: { label: "AVAILABLE", tone: GREEN },
};

/** The provider reports the plan in varying case ("Default" on one endpoint, "default" on another); show it uniformly. */
export function formatPlan(plan: string | null | undefined): string {
  if (!plan) return "—";
  return plan.charAt(0).toUpperCase() + plan.slice(1).toLowerCase();
}

export function StatusBadge({ status }: { status: string }) {
  const style = STATUS_STYLES[status] ?? { label: status.replace(/_/g, " "), tone: NEUTRAL };
  return <span className={`${BADGE_BASE} ${style.tone}`}>{style.label}</span>;
}

export function Chip({ children, tone = NEUTRAL, title }: { children: React.ReactNode; tone?: string; title?: string }) {
  return (
    <span title={title} className={`${BADGE_BASE} ${tone}`}>
      {children}
    </span>
  );
}
export const TONES = { GREEN, RED, AMBER, BLUE, NEUTRAL };

export function Card({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="rounded border border-border bg-surface p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Banner({ tone, children }: { tone: "error" | "warn" | "ok" | "info"; children: React.ReactNode }) {
  const cls = { error: RED, warn: AMBER, ok: GREEN, info: BLUE }[tone];
  return <p className={`mb-4 rounded border px-3 py-2 text-sm ${cls}`}>{children}</p>;
}

export function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div>
      <div className="text-xs text-muted">{label}</div>
      <div className="text-2xl font-semibold tracking-tight">{value}</div>
      {hint && <div className="text-xs text-muted">{hint}</div>}
    </div>
  );
}

export function Pager({ page, total, pageSize, onPage }: { page: number; total: number; pageSize: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="mt-4 flex items-center justify-between text-sm text-muted">
      <span>
        {total} result{total === 1 ? "" : "s"} — page {page} of {pages}
      </span>
      <span className="flex gap-2">
        <button disabled={page <= 1} onClick={() => onPage(page - 1)} className="rounded border border-border px-3 py-1 disabled:opacity-40">
          Previous
        </button>
        <button disabled={page >= pages} onClick={() => onPage(page + 1)} className="rounded border border-border px-3 py-1 disabled:opacity-40">
          Next
        </button>
      </span>
    </div>
  );
}

export const inputClass = "rounded border border-border bg-surface px-3 py-2 text-foreground outline-none focus:border-foreground";

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

/** Human explanation for provider error kinds shown on Health. */
export const PROVIDER_ERROR_HELP: Record<string, string> = {
  AUTH: "Upload-Post rejected the API key. The server owner must replace UPLOAD_POST_API_KEY in the server environment.",
  NOT_CONFIGURED: "No API key is configured on the server.",
  TIMEOUT: "Upload-Post did not answer in time.",
  NETWORK: "The server could not reach Upload-Post.",
  SERVER: "Upload-Post reported a server error.",
  RATE_LIMITED: "Upload-Post is rate limiting requests; this clears by itself.",
  FORBIDDEN_PLAN: "The current Upload-Post plan does not allow this.",
  QUOTA_EXCEEDED: "An Upload-Post plan limit was reached.",
};
