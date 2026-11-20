"use client";

import { useState } from "react";
import Link from "next/link";
import { ApiError, apiPost } from "@/lib/api";
import { MappingBadge, useIsAdmin, type MappingState } from "@/lib/page-network";
import { PLATFORM_LABEL } from "@/lib/publishing";
import { Banner, Card, Stat, useFetch } from "@/lib/upload-post";

interface Overview {
  counts: { categories: number; pages: number; archivedPages: number; groups: number; campaignsWithPages: number; unlinkedDestinations: number };
  byPlatform: Record<string, number>;
  byCategory: { id: string | null; name: string; count: number }[];
  mapping: Record<MappingState, number> & { labels: Record<MappingState, string> };
  attention: { id: string; name: string; platform: string | null; state: MappingState; stateLabel: string; reasons: string[] }[];
  groups: { id: string; name: string; pageCount: number }[];
  missingStarterCategories: string[];
}

const STATES: MappingState[] = ["READY", "REAUTH_REQUIRED", "DISCONNECTED", "UNAVAILABLE", "NO_DESTINATION"];

export default function PageNetworkOverviewPage() {
  const isAdmin = useIsAdmin();
  const { data, error, loading, reload } = useFetch<Overview>("/api/page-network/overview");
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  async function addStarters() {
    try {
      const r = await apiPost<{ created: string[] }>("/api/page-network/categories/starters", {});
      setMessage({ tone: "ok", text: r.created.length ? `Added: ${r.created.join(", ")}.` : "Nothing to add - every starter category already exists." });
      reload();
    } catch (err) {
      setMessage({ tone: "error", text: err instanceof ApiError ? err.message : "Could not add the categories." });
    }
  }

  if (loading && !data) return <p className="text-sm text-muted">Loading…</p>;
  if (error || !data) return <Banner tone="error">{error ?? "Could not load the overview."}</Banner>;

  return (
    <div className="flex flex-col gap-4">
      {message && <Banner tone={message.tone}>{message.text}</Banner>}
      {data.counts.categories === 0 && (
        <Banner tone="info">
          No page categories yet.{" "}
          {isAdmin ? (
            <>
              <button onClick={addStarters} className="underline">Add the starter categories</button> (Motivation, Football, Humor / Memes, Relationships, Lifestyle, Entertainment) or{" "}
              <Link href="/page-network/categories" className="underline">create your own</Link>.
            </>
          ) : (
            "An administrator can add them."
          )}
        </Banner>
      )}

      <div className="grid gap-4 md:grid-cols-3 lg:grid-cols-6">
        <Card title="Pages"><Stat label="active pages" value={data.counts.pages} hint={data.counts.archivedPages ? `${data.counts.archivedPages} archived` : undefined} /></Card>
        <Card title="Categories"><Stat label="active categories" value={data.counts.categories} /></Card>
        <Card title="Groups"><Stat label="active groups" value={data.counts.groups} /></Card>
        <Card title="Ready"><Stat label="can publish now" value={data.mapping.READY} /></Card>
        <Card title="Attention"><Stat label="pages needing attention" value={data.attention.length} /></Card>
        <Card title="Unused accounts"><Stat label="destinations without a page" value={data.counts.unlinkedDestinations} /></Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Pages by category" action={<Link href="/page-network/categories" className="text-xs text-muted hover:text-foreground">Manage</Link>}>
          {data.byCategory.length === 0 ? (
            <p className="text-sm text-muted">No pages yet. <Link href="/page-network/pages/new" className="underline">Create the first page</Link>.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {data.byCategory.map((c) => (
                <li key={c.id ?? "none"} className="flex items-center justify-between py-2 text-sm first:pt-0 last:pb-0">
                  <Link href={c.id ? `/page-network/pages?categoryId=${c.id}` : "/page-network/pages?category=none"} className="hover:underline">{c.name}</Link>
                  <span className="font-medium">{c.count}</span>
                </li>
              ))}
            </ul>
          )}
          {Object.keys(data.byPlatform).length > 0 && (
            <p className="mt-3 text-xs text-muted">{Object.entries(data.byPlatform).map(([p, n]) => `${PLATFORM_LABEL[p] ?? "No platform"} ${n}`).join(" · ")}</p>
          )}
        </Card>

        <Card title="Publishing accounts" action={<Link href="/page-network/mapping" className="text-xs text-muted hover:text-foreground">Account mapping</Link>}>
          <ul className="flex flex-col gap-2">
            {STATES.map((s) => (
              <li key={s} className="flex items-center justify-between text-sm">
                <MappingBadge state={s} label={data.mapping.labels[s]} />
                <span className="font-medium">{data.mapping[s]}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-muted">Read live from Upload-Post synchronization; an account is never shown as connected unless it is.</p>
        </Card>
      </div>

      <Card title="Needs attention">
        {data.attention.length === 0 ? (
          <p className="text-sm text-muted">Every page is set up and its account is ready.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {data.attention.map((a) => (
              <li key={a.id} className="flex flex-wrap items-start justify-between gap-2 py-2 text-sm first:pt-0 last:pb-0">
                <div>
                  <Link href={`/page-network/pages/${a.id}`} className="font-medium hover:underline">{a.name}</Link>
                  <span className="text-muted"> · {a.platform ? (PLATFORM_LABEL[a.platform] ?? a.platform) : "no platform"}</span>
                  <div className="max-w-xl text-xs text-muted">{a.reasons.join(" ")}</div>
                </div>
                <MappingBadge state={a.state} label={a.stateLabel} />
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Page groups" action={<Link href="/page-network/groups" className="text-xs text-muted hover:text-foreground">All groups</Link>}>
        {data.groups.length === 0 ? (
          <p className="text-sm text-muted">No groups yet.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {data.groups.map((g) => (
              <Link key={g.id} href={`/page-network/groups/${g.id}`} className="rounded border border-border px-3 py-1.5 text-sm hover:border-foreground">
                {g.name} <span className="text-muted">· {g.pageCount}</span>
              </Link>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
