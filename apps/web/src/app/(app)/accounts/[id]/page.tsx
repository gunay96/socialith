"use client";

import { useEffect, useState } from "react";
import { apiGet, apiPost, buildOAuthStartUrl, ApiError, type SocialAccountDetail } from "@/lib/api";
import { useCurrentUser } from "@/lib/auth-context";

const STATUS_LABEL: Record<string, string> = {
  CONNECTED: "Connected",
  DISCONNECTED: "Disconnected",
  EXPIRED: "Expired — reconnect required",
  ERROR: "Error — reauthorization required",
};

export default function AccountOverviewPage({ params }: { params: { id: string } }) {
  const me = useCurrentUser();
  const [account, setAccount] = useState<SocialAccountDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);

  function load() {
    apiGet<SocialAccountDetail>(`/api/accounts/${params.id}`)
      .then(setAccount)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Something went wrong."));
  }

  useEffect(load, [params.id]);

  async function handleDisconnect() {
    setDisconnectError(null);
    setDisconnecting(true);
    try {
      await apiPost<SocialAccountDetail>(`/api/accounts/${params.id}/disconnect`);
      load();
    } catch (err) {
      setDisconnectError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setDisconnecting(false);
    }
  }

  if (error) {
    return <p className="text-sm text-red-400">{error}</p>;
  }

  if (!account) {
    return <p className="text-sm text-muted">Loading…</p>;
  }

  const canManageAccounts = me.role === "OWNER" || me.role === "ADMIN";

  return (
    <div className="max-w-xl">
      <div className="mb-6 rounded border border-border bg-surface p-6">
        <div className="flex items-center gap-3">
          {account.avatarUrl ? (
            <img src={account.avatarUrl} alt="" className="h-12 w-12 rounded-full object-cover" />
          ) : (
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-border text-sm text-muted">
              {account.displayName.slice(0, 1).toUpperCase()}
            </div>
          )}
          <div>
            <h1 className="text-xl font-semibold tracking-tight">{account.displayName}</h1>
            <p className="text-sm text-muted">
              {account.handle} — {account.platform}
            </p>
          </div>
        </div>

        <dl className="mt-4 grid grid-cols-2 gap-y-2 text-sm">
          <dt className="text-muted">Status</dt>
          <dd>{STATUS_LABEL[account.status] ?? account.status}</dd>
          <dt className="text-muted">Followers</dt>
          <dd>{account.followerCount?.toLocaleString() ?? "—"}</dd>
          <dt className="text-muted">Last synced</dt>
          <dd>{account.lastSyncedAt ? new Date(account.lastSyncedAt).toLocaleString() : "Never"}</dd>
          <dt className="text-muted">Connected since</dt>
          <dd>{new Date(account.createdAt).toLocaleDateString()}</dd>
          <dt className="text-muted">Permissions</dt>
          <dd>{account.connection?.scopes.length ? account.connection.scopes.join(", ") : "—"}</dd>
          <dt className="text-muted">Token expires</dt>
          <dd>{account.connection?.tokenExpiresAt ? new Date(account.connection.tokenExpiresAt).toLocaleString() : "—"}</dd>
          <dt className="text-muted">Last token refresh</dt>
          <dd>{account.connection?.lastRefreshedAt ? new Date(account.connection.lastRefreshedAt).toLocaleString() : "Never"}</dd>
        </dl>

        {account.lastErrorMessage && (
          <p className="mt-4 rounded border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-400">
            {account.lastErrorMessage}
          </p>
        )}

        {canManageAccounts && (
          <div className="mt-6 flex items-center gap-3">
            {(account.status === "DISCONNECTED" || account.status === "EXPIRED" || account.status === "ERROR") && (
              <a
                href={buildOAuthStartUrl(account.platform)}
                className="rounded bg-foreground px-3 py-2 text-sm font-medium text-background"
              >
                {account.status === "DISCONNECTED" ? "Reconnect" : "Reconnect / reauthorize"}
              </a>
            )}
            {account.status !== "DISCONNECTED" && (
              <button
                onClick={handleDisconnect}
                disabled={disconnecting}
                className="rounded border border-border px-3 py-2 text-sm text-red-400 hover:border-red-400 disabled:opacity-50"
              >
                {disconnecting ? "Disconnecting…" : "Disconnect account"}
              </button>
            )}
          </div>
        )}
        {disconnectError && <p className="mt-2 text-sm text-red-400">{disconnectError}</p>}
      </div>
    </div>
  );
}
