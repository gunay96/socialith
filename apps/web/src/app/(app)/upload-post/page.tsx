"use client";

import { useState } from "react";
import Link from "next/link";
import { apiPost, ApiError } from "@/lib/api";
import { useCurrentUser } from "@/lib/auth-context";
import { Banner, Card, Chip, Stat, StatusBadge, TONES, formatDateTime, useFetch, type Overview } from "@/lib/upload-post";
import { PlatformAvailabilityCard } from "./platform-availability";

export default function UploadPostOverviewPage() {
  const me = useCurrentUser();
  const canSync = me.role === "ADMIN" || me.role === "OWNER";
  const { data, error, loading, reload } = useFetch<Overview>("/api/upload-post/overview");
  const [message, setMessage] = useState<{ tone: "ok" | "error" | "info"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function syncNow() {
    setBusy(true);
    setMessage(null);
    try {
      const r = await apiPost<{ queued: boolean; alreadyQueued: boolean }>("/api/upload-post/sync");
      setMessage(r.alreadyQueued ? { tone: "info", text: "A synchronization is already queued." } : { tone: "ok", text: "Synchronization queued. Refresh in a few seconds." });
      setTimeout(reload, 4000);
    } catch (err) {
      setMessage({ tone: "error", text: err instanceof ApiError ? err.message : "Could not queue the synchronization." });
    } finally {
      setBusy(false);
    }
  }

  if (loading && !data) return <p className="text-sm text-muted">Loading…</p>;
  if (error || !data) return <Banner tone="error">{error ?? "Could not load the overview."}</Banner>;

  return (
    <div className="flex flex-col gap-4">
      {!data.configured && (
        <Banner tone="warn">
          Upload-Post is not configured on this server. The API key is a server-side secret: ask whoever runs the server to set <code>UPLOAD_POST_API_KEY</code> in the server environment (it is never entered here).
        </Banner>
      )}
      {data.configured && data.organizationIssue && <Banner tone="warn">{data.organizationIssue}</Banner>}
      {message && <Banner tone={message.tone}>{message.text}</Banner>}
      {data.configured && data.lastSuccessfulSyncAt && data.profiles.active === 0 && (
        <Banner tone="info">Upload-Post reports no profiles yet. Create a profile in Upload-Post, connect a social account to it, then run Sync now.</Banner>
      )}
      {data.configured && data.lastSuccessfulSyncAt && data.profiles.active > 0 && Object.keys(data.accounts.byStatus).length === 0 && (
        <Banner tone="info">
          {data.profiles.active} profile{data.profiles.active === 1 ? "" : "s"} synchronized, but no social account is connected in {data.profiles.active === 1 ? "it" : "them"} yet. Connect accounts in Upload-Post (Instagram and YouTube where your plan allows), then run Sync now. Nothing is shown as connected until Upload-Post reports it.
        </Banner>
      )}

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <StatusBadge status={data.status} />
          <span className="text-sm text-muted">Last successful sync: {formatDateTime(data.lastSuccessfulSyncAt)}</span>
        </div>
        {canSync && (
          <button onClick={syncNow} disabled={busy || !data.configured} className="rounded border border-border px-3 py-2 text-sm hover:border-foreground disabled:opacity-40">
            {busy ? "Queuing…" : "Sync now"}
          </button>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card title="Profiles" action={<Link href="/upload-post/profiles" className="text-xs text-muted hover:text-foreground">View</Link>}>
          <div className="grid grid-cols-2 gap-4">
            <Stat label="Active" value={data.profiles.active} hint={data.profiles.limit !== null ? `plan limit ${data.profiles.limit}` : "limit unknown until the first sync"} />
            <Stat label="Without a page" value={data.profiles.unmapped} />
          </div>
          {data.profiles.removed > 0 && <p className="mt-3 text-xs text-muted">{data.profiles.removed} removed upstream (kept for history).</p>}
        </Card>

        <Card title="Connected accounts" action={<Link href="/upload-post/accounts" className="text-xs text-muted hover:text-foreground">View</Link>}>
          <div className="mb-3 flex flex-wrap gap-2">
            {Object.entries(data.accounts.byStatus).map(([s, n]) => (
              <span key={s} className="flex items-center gap-1 text-xs">
                <StatusBadge status={s} /> {n}
              </span>
            ))}
            {Object.keys(data.accounts.byStatus).length === 0 && <span className="text-sm text-muted">None synchronized yet.</span>}
          </div>
          <div className="flex flex-wrap gap-2">
            {Object.entries(data.accounts.byPlatform).map(([p, n]) => (
              <Chip key={p}>
                {p} · {n}
              </Chip>
            ))}
          </div>
          <p className="mt-3 text-xs text-muted">
            {data.accounts.destinations} publishing destination(s) enabled · {data.accounts.unmapped} account(s) without a creator
          </p>
        </Card>

        <Card title="Publications" action={<Link href="/upload-post/history" className="text-xs text-muted hover:text-foreground">History</Link>}>
          <div className="flex flex-wrap gap-2">
            {Object.entries(data.publications).map(([s, n]) => (
              <span key={s} className="flex items-center gap-1 text-xs">
                <StatusBadge status={s} /> {n}
              </span>
            ))}
            {Object.keys(data.publications).length === 0 && <span className="text-sm text-muted">Nothing published through Upload-Post yet.</span>}
          </div>
        </Card>
      </div>

      <PlatformAvailabilityCard compact />

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Last synchronization">
          {data.lastSync ? (
            <div className="flex flex-col gap-1 text-sm">
              <div className="flex items-center gap-2">
                <StatusBadge status={data.lastSync.status} />
                <span className="text-muted">
                  {data.lastSync.trigger.toLowerCase()} · {formatDateTime(data.lastSync.startedAt)}
                </span>
              </div>
              {data.lastSync.errorMessage && <p className="text-red-400">{data.lastSync.errorKind}: {data.lastSync.errorMessage}</p>}
              <p className="text-xs text-muted">Runs automatically every {data.syncIntervalMinutes} min and when an account connection changes.</p>
            </div>
          ) : (
            <p className="text-sm text-muted">No synchronization has run yet.</p>
          )}
        </Card>

        <Card title="Scheduling and webhooks">
          <ul className="flex flex-col gap-2 text-sm">
            <li className="flex items-center justify-between">
              <span>Socialith owns the master schedule</span>
              <Chip tone={TONES.GREEN}>always</Chip>
            </li>
            <li className="flex items-center justify-between">
              <span>Hand-off to Upload-Post scheduler</span>
              <Chip tone={data.handoff.enabled ? TONES.BLUE : TONES.NEUTRAL}>{data.handoff.enabled ? `on · next ${data.handoff.windowHours} h` : "off"}</Chip>
            </li>
            <li className="flex items-center justify-between">
              <span>Webhook signing secret</span>
              <Chip tone={data.webhookConfigured ? TONES.GREEN : TONES.AMBER}>{data.webhookConfigured ? "configured" : "not configured"}</Chip>
            </li>
          </ul>
        </Card>
      </div>
    </div>
  );
}
