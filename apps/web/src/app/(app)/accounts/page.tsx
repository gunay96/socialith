"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  apiGet,
  buildOAuthStartUrl,
  buildQueryString,
  ApiError,
  PLATFORMS,
  SOCIAL_ACCOUNT_STATUSES,
  type ListSocialAccountsResult,
  type Platform,
  type SocialAccountStatus,
  type PlatformCapabilitiesMap,
  type CapabilityStatus,
} from "@/lib/api";
import { useCurrentUser } from "@/lib/auth-context";

const PAGE_SIZE = 25;

const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  access_denied: "You declined the platform's consent screen — nothing was connected.",
  invalid_state: "The connection attempt expired or was invalid. Please try connecting again.",
  configuration_error: "This platform isn't configured on the server yet (missing OAuth app credentials).",
  auth_error: "The platform rejected the authorization. Please try again.",
  platform_error: "The platform returned an unexpected error. Please try again.",
  invalid_platform: "Unknown platform.",
};

function OAuthResultBanner() {
  const params = useSearchParams();
  const connected = params.get("connected");
  const oauthError = params.get("oauthError");
  if (connected) {
    return (
      <p className="mb-4 rounded border border-green-900 bg-green-950/40 px-3 py-2 text-sm text-green-400">
        {connected} account connected successfully.
      </p>
    );
  }
  if (oauthError) {
    return (
      <p className="mb-4 rounded border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-400">
        {OAUTH_ERROR_MESSAGES[oauthError] ?? "Could not connect this account."}
      </p>
    );
  }
  return null;
}

export default function AccountsPage() {
  const me = useCurrentUser();
  const canConnect = me.role !== "VIEWER";
  const initialParams = useSearchParams();
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [platform, setPlatform] = useState<Platform | "">(() => (initialParams.get("platform") as Platform | null) ?? "");
  const [status, setStatus] = useState<SocialAccountStatus | "">(
    () => (initialParams.get("status") as SocialAccountStatus | null) ?? "",
  );
  const [page, setPage] = useState(1);

  const [result, setResult] = useState<ListSocialAccountsResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<PlatformCapabilitiesMap | null>(null);
  const [showCapabilities, setShowCapabilities] = useState(false);

  useEffect(() => {
    apiGet<PlatformCapabilitiesMap>("/api/platform-capabilities")
      .then(setCapabilities)
      .catch(() => {
        // Non-critical panel — a failed fetch just leaves it collapsed/empty rather than blocking the page.
      });
  }, []);

  // Small debounce on free-text search only — platform/status/page changes
  // (below) refetch immediately since they're discrete, not typed.
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    const query = buildQueryString({
      search: search || undefined,
      platform: platform || undefined,
      status: status || undefined,
      page,
      pageSize: PAGE_SIZE,
    });
    apiGet<ListSocialAccountsResult>(`/api/accounts${query}`)
      .then(setResult)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Something went wrong."));
  }, [search, platform, status, page]);

  const totalPages = result ? Math.max(1, Math.ceil(result.total / result.pageSize)) : 1;

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Connected Accounts</h1>
        <div className="flex gap-2">
          <button
            onClick={() => setShowCapabilities((v) => !v)}
            className="rounded border border-border px-3 py-2 text-sm text-muted hover:border-foreground hover:text-foreground"
          >
            {showCapabilities ? "Hide" : "What's supported?"}
          </button>
          {canConnect &&
            PLATFORMS.map((p) => (
              <a
                key={p}
                href={buildOAuthStartUrl(p)}
                className="rounded border border-border px-3 py-2 text-sm hover:border-foreground"
              >
                Connect {p}
              </a>
            ))}
        </div>
      </div>

      {showCapabilities && <CapabilitiesPanel capabilities={capabilities} />}

      <OAuthResultBanner />

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          Search
          <input
            type="text"
            placeholder="Handle or name…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="w-56 rounded border border-border bg-surface px-3 py-2 text-foreground outline-none focus:border-foreground"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Platform
          <select
            value={platform}
            onChange={(e) => {
              setPlatform(e.target.value as Platform | "");
              setPage(1);
            }}
            className="rounded border border-border bg-surface px-3 py-2 text-foreground outline-none focus:border-foreground"
          >
            <option value="">All</option>
            {PLATFORMS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Status
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as SocialAccountStatus | "");
              setPage(1);
            }}
            className="rounded border border-border bg-surface px-3 py-2 text-foreground outline-none focus:border-foreground"
          >
            <option value="">All</option>
            {SOCIAL_ACCOUNT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error && <p className="mb-4 text-sm text-red-400">{error}</p>}

      {!result && !error && <p className="text-sm text-muted">Loading…</p>}

      {result && (
        <>
          <div className="rounded border border-border bg-surface">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-border text-muted">
                  <th className="px-4 py-2 font-normal">Account</th>
                  <th className="px-4 py-2 font-normal">Platform</th>
                  <th className="px-4 py-2 font-normal">Status</th>
                  <th className="px-4 py-2 font-normal">Followers</th>
                  <th className="px-4 py-2 font-normal">Last synced</th>
                </tr>
              </thead>
              <tbody>
                {result.items.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-6 text-center text-muted">
                      No connected accounts match these filters.
                    </td>
                  </tr>
                )}
                {result.items.map((account) => (
                  <tr key={account.id} className="border-b border-border last:border-0 hover:bg-background/40">
                    <td className="px-4 py-2">
                      <Link href={`/accounts/${account.id}`} className="flex items-center gap-2 hover:underline">
                        {account.avatarUrl ? (
                          <img src={account.avatarUrl} alt="" className="h-8 w-8 shrink-0 rounded-full object-cover" />
                        ) : (
                          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-border text-xs text-muted">
                            {account.displayName.slice(0, 1).toUpperCase()}
                          </div>
                        )}
                        <div>
                          <div className="text-foreground">{account.displayName}</div>
                          <div className="text-xs text-muted">{account.handle}</div>
                        </div>
                      </Link>
                    </td>
                    <td className="px-4 py-2">{account.platform}</td>
                    <td className="px-4 py-2">
                      <StatusBadge status={account.status} />
                    </td>
                    <td className="px-4 py-2">{account.followerCount?.toLocaleString() ?? "—"}</td>
                    <td className="px-4 py-2 text-muted">
                      {account.lastSyncedAt ? new Date(account.lastSyncedAt).toLocaleDateString() : "Never"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-4 flex items-center justify-between text-sm text-muted">
            <span>
              {result.total} account{result.total === 1 ? "" : "s"} — page {result.page} of {totalPages}
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="rounded border border-border px-3 py-1.5 disabled:opacity-40"
              >
                Previous
              </button>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                className="rounded border border-border px-3 py-1.5 disabled:opacity-40"
              >
                Next
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: SocialAccountStatus }) {
  const color =
    status === "CONNECTED"
      ? "text-green-400"
      : status === "ERROR"
        ? "text-red-400"
        : status === "EXPIRED"
          ? "text-yellow-400"
          : "text-muted";
  return <span className={color}>{status}</span>;
}

const CAPABILITY_ROWS: { key: "videoPublishing" | "photoPublishing" | "analytics" | "soundAttachment"; label: string }[] = [
  { key: "videoPublishing", label: "Video publishing" },
  { key: "photoPublishing", label: "Photo publishing" },
  { key: "analytics", label: "Analytics" },
  { key: "soundAttachment", label: "Sound attachment" },
];

function CapabilitiesPanel({ capabilities }: { capabilities: PlatformCapabilitiesMap | null }) {
  if (!capabilities) {
    return <p className="mb-4 text-sm text-muted">Loading platform capabilities…</p>;
  }
  return (
    <div className="mb-4 overflow-x-auto rounded border border-border bg-surface">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-border text-muted">
            <th className="px-4 py-2 font-normal">Capability</th>
            {PLATFORMS.map((p) => (
              <th key={p} className="px-4 py-2 font-normal">
                {p}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {CAPABILITY_ROWS.map((row) => (
            <tr key={row.key} className="border-b border-border last:border-0">
              <td className="px-4 py-2 text-muted">{row.label}</td>
              {PLATFORMS.map((p) => {
                const detail = capabilities[p]?.[row.key];
                return (
                  <td key={p} className="px-4 py-2 align-top">
                    {detail ? <CapabilityBadge detail={detail} /> : "—"}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const CAPABILITY_LABEL: Record<CapabilityStatus, string> = {
  SUPPORTED: "Supported",
  PARTIAL: "Partial",
  REQUIRES_APPROVAL: "Requires approval",
  NOT_SUPPORTED: "Not supported",
  NOT_APPLICABLE: "Not applicable",
};

const CAPABILITY_COLOR: Record<CapabilityStatus, string> = {
  SUPPORTED: "text-green-400",
  PARTIAL: "text-yellow-400",
  REQUIRES_APPROVAL: "text-yellow-400",
  NOT_SUPPORTED: "text-red-400",
  NOT_APPLICABLE: "text-muted",
};

function CapabilityBadge({ detail }: { detail: { status: CapabilityStatus; note: string } }) {
  return (
    <div>
      <span className={CAPABILITY_COLOR[detail.status]}>{CAPABILITY_LABEL[detail.status]}</span>
      <p className="mt-0.5 max-w-xs text-xs text-muted">{detail.note}</p>
    </div>
  );
}
