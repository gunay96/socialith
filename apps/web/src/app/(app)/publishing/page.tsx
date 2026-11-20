"use client";

import { useState } from "react";
import Link from "next/link";
import { PUBLICATION_STATES } from "@socialith/publishing";
import { Banner, Card, Chip, Stat, useFetch } from "@/lib/upload-post";
import { EMPTY_FILTERS, FilterBar, OwnerChip, PLATFORM_LABEL, StateBadge, filtersToQuery, fmt, useTimezone, type FilterValues, type PublicationState } from "@/lib/publishing";

interface Overview {
  timezone: string;
  approval: { required: boolean; source: "default" | "configured" };
  metrics: { scheduled: number; published: number; pending: number; failed: number; awaitingApproval: number; connectedAccounts: number; connectedByPlatform: Record<string, number> };
  byState: Record<PublicationState, number>;
  upcoming: { id: string; scheduledAt: string | null; platform: string; handle: string; schedulingOwner: "SOCIALITH" | "PROVIDER" | "NONE"; snippet: string; campaign: { name: string } | null }[];
}

export default function PublishingOverviewPage() {
  const tz = useTimezone();
  const [filters, setFilters] = useState<FilterValues>(EMPTY_FILTERS);
  const { data, error, loading } = useFetch<Overview>(`/api/publishing/overview${filtersToQuery({ ...filters, state: "" }, tz)}`);

  return (
    <div className="flex flex-col gap-4">
      <FilterBar value={filters} onChange={setFilters} hide={["state"]} />
      {error && <Banner tone="error">{error}</Banner>}
      {loading && !data && <p className="text-sm text-muted">Loading…</p>}
      {data && (
        <>
          {!data.approval.required && (
            <Banner tone="info">
              Approval is <strong>switched off</strong> for this organization (an explicit Publishing Settings choice): publications can be scheduled straight from draft. Turn it back on in{" "}
              <Link href="/publishing/settings" className="underline">Publishing Settings</Link> so that every destination must be approved before it can be scheduled — approval is on by default.
            </Banner>
          )}
          <div className="grid gap-4 md:grid-cols-3 lg:grid-cols-6">
            <Card title="Scheduled"><Stat label="total scheduled" value={data.metrics.scheduled} /></Card>
            <Card title="Published"><Stat label="successfully published" value={data.metrics.published} /></Card>
            <Card title="Pending"><Stat label="drafts, review, queued, held" value={data.metrics.pending} /></Card>
            <Card title="Failed"><Stat label="failed or stale" value={data.metrics.failed} /></Card>
            <Card title="Awaiting approval"><Stat label="ready for review" value={data.metrics.awaitingApproval} /></Card>
            <Card title="Connected accounts"><Stat label="publishing accounts" value={data.metrics.connectedAccounts} hint={Object.entries(data.metrics.connectedByPlatform).map(([p, n]) => `${PLATFORM_LABEL[p] ?? p} ${n}`).join(" · ") || "none connected"} /></Card>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <Card title="Upcoming scheduled content" action={<Link href="/publishing/scheduled" className="text-xs text-muted hover:text-foreground">All scheduled</Link>}>
              {data.upcoming.length === 0 ? (
                <p className="text-sm text-muted">Nothing is scheduled. <Link href="/publishing/new" className="underline">Create a publication</Link>.</p>
              ) : (
                <ul className="flex flex-col divide-y divide-border">
                  {data.upcoming.map((u) => (
                    <li key={u.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm first:pt-0 last:pb-0">
                      <div>
                        <Link href={`/publishing/publications/${u.id}`} className="font-medium hover:underline">@{u.handle.replace(/^@/, "")}</Link>
                        <span className="text-muted"> · {PLATFORM_LABEL[u.platform] ?? u.platform}</span>
                        <div className="max-w-sm truncate text-xs text-muted">{u.snippet || "(no text)"}</div>
                      </div>
                      <div className="flex items-center gap-2 text-right"><OwnerChip owner={u.schedulingOwner} /><span className="whitespace-nowrap text-xs">{fmt(u.scheduledAt, tz)}</span></div>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-3 text-xs text-muted">Times are shown in {tz}.</p>
            </Card>

            <Card title="By status">
              <div className="flex flex-wrap gap-3">
                {PUBLICATION_STATES.map((s) => (
                  <Link key={s} href={`/publishing/publications?state=${s}`} className="flex items-center gap-1.5 text-sm">
                    <StateBadge state={s} /> <span className="font-medium">{data.byState[s]}</span>
                  </Link>
                ))}
              </div>
              <p className="mt-3 text-xs text-muted">
                <Chip>QUEUED</Chip> = waiting for the publishing worker, <Chip>PUBLISHING</Chip> = a provider request has been made, <Chip>STALE</Chip> = it missed its slot and was held, never published late.
              </p>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
