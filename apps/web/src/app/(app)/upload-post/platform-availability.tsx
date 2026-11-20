"use client";

import { Banner, Card, Chip, StatusBadge, TONES, formatPlan, useFetch, type Capabilities, type PlatformAvailability } from "@/lib/upload-post";

/**
 * What Socialith can use through Upload-Post right now, as CONFIRMED by the provider. A platform is "available"
 * only when a connected account for it was synchronized; everything else says exactly why it is not.
 */
export function PlatformAvailabilityCard({ compact = false }: { compact?: boolean }) {
  const { data, error, loading } = useFetch<Capabilities>("/api/upload-post/capabilities");
  if (loading && !data) return <p className="text-sm text-muted">Loading platform availability…</p>;
  if (error || !data) return <Banner tone="error">{error ?? "Could not load platform availability."}</Banner>;

  const publishable = data.platforms.filter((p) => p.publishable);
  const syncOnly = data.platforms.filter((p) => !p.publishable);

  return (
    <Card title="Platform availability">
      <p className="mb-3 text-xs text-muted">
        {data.synced
          ? `Plan ${formatPlan(data.plan.name)} · ${data.plan.profilesUsed} of ${data.plan.profileLimit ?? "?"} profiles used (reported by Upload-Post).`
          : "Not synchronized yet — nothing is confirmed, so every platform is shown as unavailable."}
      </p>
      <ul className="flex flex-col divide-y divide-border">
        {publishable.map((p) => (
          <PlatformRow key={p.platform} p={p} compact={compact} />
        ))}
      </ul>
      {syncOnly.length > 0 && (
        <p className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted">
          Synchronized for display only (not publishable yet):
          {syncOnly.map((p) => (
            <Chip key={p.platform} tone={p.state === "AVAILABLE" ? TONES.NEUTRAL : TONES.AMBER}>
              {p.label} · {p.accounts.connected}
            </Chip>
          ))}
        </p>
      )}
      {!compact && data.notes.map((n) => (
        <p key={n} className="mt-3 text-xs text-muted">
          {n}
        </p>
      ))}
    </Card>
  );
}

function PlatformRow({ p, compact }: { p: PlatformAvailability; compact: boolean }) {
  return (
    <li className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-24 text-sm font-medium">{p.label}</span>
        <StatusBadge status={p.state} />
        {p.accounts.connected > 0 && <Chip>{p.accounts.connected} connected</Chip>}
        {p.accounts.reauthRequired > 0 && <Chip tone={TONES.AMBER}>{p.accounts.reauthRequired} need reconnecting</Chip>}
        {p.destinations > 0 && <Chip tone={TONES.GREEN}>{p.destinations} destination{p.destinations === 1 ? "" : "s"} enabled</Chip>}
        {p.features.map((f) => (
          <Chip key={f.key} tone={f.state === "AVAILABLE" ? TONES.GREEN : TONES.NEUTRAL} title={f.reason ?? undefined}>
            {f.label}: {f.state === "AVAILABLE" ? "available" : "unavailable"}
          </Chip>
        ))}
      </div>
      {p.reason && <p className="text-xs text-muted">{p.reason}</p>}
      {!compact && p.state !== "AVAILABLE" && p.connectableProfiles.length > 0 && (
        <p className="text-xs text-muted">
          Can be connected in Upload-Post to profile: <span className="font-mono">{p.connectableProfiles.map((c) => c.username).join(", ")}</span>
        </p>
      )}
    </li>
  );
}
