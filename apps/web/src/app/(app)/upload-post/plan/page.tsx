"use client";

import { Banner, Card, Chip, Stat, StatusBadge, TONES, formatDateTime, formatPlan, useFetch } from "@/lib/upload-post";
import { PlatformAvailabilityCard } from "../platform-availability";

interface Plan {
  plan: string | null;
  profileLimit: number | null;
  profilesUsed: number;
  profilesRemaining: number | null;
  limitReached: boolean;
  analyzeShorts: { limit: number; used: number; remaining: number; resetsAt: string | null } | null;
  source: "live" | "last-sync" | "none";
  lastSyncedAt: string | null;
  recentSyncRuns: { id: string; status: string; trigger: string; startedAt: string; finishedAt: string | null; profilesSeen: number; accountsSeen: number; errorKind: string | null; errorMessage: string | null }[];
}

export default function PlanPage() {
  const { data, error, loading } = useFetch<Plan>("/api/upload-post/plan");
  if (loading && !data) return <p className="text-sm text-muted">Loading…</p>;
  if (error || !data) return <Banner tone="error">{error ?? "Could not load plan information."}</Banner>;

  const pct = data.profileLimit ? Math.min(100, Math.round((data.profilesUsed / data.profileLimit) * 100)) : null;

  return (
    <div className="flex flex-col gap-4">
      {data.source === "none" && <Banner tone="info">Plan and capacity are reported by Upload-Post. They appear here after the first successful connection or synchronization — nothing is assumed.</Banner>}
      {data.source === "last-sync" && <Banner tone="warn">The live check failed; showing the values from the last synchronization ({formatDateTime(data.lastSyncedAt)}).</Banner>}
      {data.limitReached && <Banner tone="warn">The profile limit of the current plan is used up. New profiles cannot be created until the plan changes or profiles are removed.</Banner>}

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Plan and profile capacity">
          <div className="grid grid-cols-2 gap-4">
            <Stat label="Plan" value={formatPlan(data.plan)} hint={`source: ${data.source}`} />
            <Stat label="Profile limit" value={data.profileLimit ?? "unknown"} hint="as reported by the provider" />
            <Stat label="Profiles in use" value={data.profilesUsed} />
            <Stat label="Remaining" value={data.profilesRemaining ?? "—"} />
          </div>
          {pct !== null && (
            <div className="mt-4">
              <div className="h-2 w-full overflow-hidden rounded bg-border">
                <div className={`h-full ${data.limitReached ? "bg-amber-500" : "bg-accent"}`} style={{ width: `${pct}%` }} />
              </div>
              <div className="mt-1 text-xs text-muted">{pct}% of the plan&apos;s profiles</div>
            </div>
          )}
        </Card>

        <Card title="AI Shorts quota (30-day window)">
          {data.analyzeShorts ? (
            <div className="grid grid-cols-3 gap-4">
              <Stat label="Included" value={data.analyzeShorts.limit} />
              <Stat label="Used" value={data.analyzeShorts.used} />
              <Stat label="Remaining" value={data.analyzeShorts.remaining} hint={data.analyzeShorts.resetsAt ? `resets ${formatDateTime(data.analyzeShorts.resetsAt)}` : "no window running"} />
            </div>
          ) : (
            <p className="text-sm text-muted">Not available (requires a live connection).</p>
          )}
          <p className="mt-3 text-xs text-muted">Socialith does not use AI Shorts in this phase; the figure is shown for plan awareness only. Monthly upload limits are enforced by Upload-Post and surface as a clear failure on the publication.</p>
        </Card>
      </div>

      <PlatformAvailabilityCard />

      <Card title="Recent synchronizations">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border text-xs uppercase tracking-wide text-muted">
              <tr><th className="py-2 pr-3">Started</th><th className="pr-3">Trigger</th><th className="pr-3">Result</th><th className="pr-3">Profiles</th><th className="pr-3">Accounts</th><th>Error</th></tr>
            </thead>
            <tbody>
              {data.recentSyncRuns.map((r) => (
                <tr key={r.id} className="border-b border-border last:border-0">
                  <td className="py-2 pr-3 text-muted">{formatDateTime(r.startedAt)}</td>
                  <td className="pr-3"><Chip>{r.trigger.toLowerCase()}</Chip></td>
                  <td className="pr-3"><StatusBadge status={r.status} /></td>
                  <td className="pr-3">{r.profilesSeen}</td>
                  <td className="pr-3">{r.accountsSeen}</td>
                  <td className="text-xs text-red-400">{r.errorMessage ? `${r.errorKind}: ${r.errorMessage}` : ""}</td>
                </tr>
              ))}
              {data.recentSyncRuns.length === 0 && (<tr><td colSpan={6} className="py-4 text-center text-muted">No synchronization yet.</td></tr>)}
            </tbody>
          </table>
        </div>
        <div className="mt-2"><Chip tone={TONES.NEUTRAL}>last 10 runs</Chip></div>
      </Card>
    </div>
  );
}
