"use client";

import { useState } from "react";
import { apiGet, ApiError } from "@/lib/api";
import { Banner, Card, Chip, PROVIDER_ERROR_HELP, Stat, StatusBadge, TONES, formatDateTime, useFetch, type IntegrationContext, type Overview } from "@/lib/upload-post";

export default function HealthPage() {
  const { data, error, loading, reload } = useFetch<IntegrationContext>("/api/upload-post/health");
  const overview = useFetch<Overview>("/api/upload-post/overview");
  const [checking, setChecking] = useState(false);
  const [fresh, setFresh] = useState<IntegrationContext | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);

  async function checkNow() {
    setChecking(true);
    setCheckError(null);
    try {
      setFresh(await apiGet<IntegrationContext>("/api/upload-post/health?refresh=true"));
    } catch (err) {
      setCheckError(err instanceof ApiError ? err.message : "Health check failed.");
    } finally {
      setChecking(false);
    }
  }

  const current = fresh ?? data;
  if (loading && !current) return <p className="text-sm text-muted">Loading…</p>;
  if (error && !current) return <Banner tone="error">{error}</Banner>;
  if (!current) return null;
  const p = current.provider;

  return (
    <div className="flex flex-col gap-4">
      {checkError && <Banner tone="error">{checkError}</Banner>}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {overview.data ? <StatusBadge status={overview.data.status} /> : null}
          <span className="text-sm text-muted">Live check against Upload-Post (cached for 30 s).</span>
        </div>
        <button onClick={() => { setFresh(null); void checkNow().then(reload); }} disabled={checking} className="rounded border border-border px-3 py-2 text-sm hover:border-foreground disabled:opacity-40">
          {checking ? "Checking…" : "Check now"}
        </button>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="API connection">
          {!p.configured ? (
            <div className="text-sm">
              <Chip tone={TONES.AMBER}>not configured</Chip>
              <p className="mt-2 text-muted">{PROVIDER_ERROR_HELP.NOT_CONFIGURED} The key is set on the server, never in this interface.</p>
            </div>
          ) : p.ok ? (
            <div className="grid grid-cols-2 gap-4">
              <Stat label="Credentials" value={<Chip tone={TONES.GREEN}>valid</Chip>} />
              <Stat label="Round-trip" value={`${p.latencyMs} ms`} hint={`checked ${formatDateTime(p.checkedAt)}`} />
              <Stat label="Plan" value={p.account?.plan ?? "—"} />
              <Stat label="Account" value={<span className="text-base">{p.account?.email ?? "hidden (admins only)"}</span>} />
            </div>
          ) : (
            <div className="text-sm">
              <Chip tone={TONES.RED}>{p.errorKind}</Chip>
              <p className="mt-2 text-red-400">{p.message}</p>
              <p className="mt-1 text-muted">{PROVIDER_ERROR_HELP[p.errorKind ?? ""] ?? ""}</p>
              {p.retryAfterMs ? <p className="mt-1 text-xs text-muted">Retry after about {Math.ceil(p.retryAfterMs / 1000)} s.</p> : null}
            </div>
          )}
        </Card>

        <Card title="Integration wiring">
          <ul className="flex flex-col gap-2 text-sm">
            <li className="flex items-center justify-between"><span>Server configuration</span><Chip tone={current.configured ? TONES.GREEN : TONES.AMBER}>{current.configured ? "API key present" : "no API key"}</Chip></li>
            <li className="flex items-center justify-between"><span>Owned by this organization</span><Chip tone={current.organizationOwnsKey ? TONES.GREEN : TONES.AMBER}>{current.organizationOwnsKey ? "yes" : "no"}</Chip></li>
            <li className="flex items-center justify-between"><span>Webhook signing secret</span><Chip tone={current.webhookConfigured ? TONES.GREEN : TONES.AMBER}>{current.webhookConfigured ? "configured" : "not configured"}</Chip></li>
            <li className="flex items-center justify-between"><span>Automatic synchronization</span><Chip>every {current.syncIntervalMinutes} min</Chip></li>
            <li className="flex items-center justify-between"><span>Scheduler hand-off</span><Chip tone={current.handoff.enabled ? TONES.BLUE : TONES.NEUTRAL}>{current.handoff.enabled ? `on · ${current.handoff.windowHours} h` : "off"}</Chip></li>
          </ul>
          {current.organizationIssue && <p className="mt-3 text-sm text-amber-400">{current.organizationIssue}</p>}
          {!current.webhookConfigured && <p className="mt-3 text-xs text-muted">Without a webhook secret, results are still reconciled by polling and the periodic sweep; webhooks only make them faster.</p>}
        </Card>
      </div>
    </div>
  );
}
