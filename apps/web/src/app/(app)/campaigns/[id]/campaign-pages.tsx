"use client";

import { useState } from "react";
import Link from "next/link";
import { ApiError, apiDelete, apiPost, buildQueryString } from "@/lib/api";
import { PlatformChip, StatusChip, useIsAdmin, type Category, type PageItem, type Paged, type Status } from "@/lib/page-network";
import { Banner, Chip, inputClass, useFetch } from "@/lib/upload-post";

interface CampaignPages {
  directPages: PageItem[];
  groups: { id: string; name: string; status: Status; pageCount: number }[];
  effectivePages: (PageItem & { via: ({ kind: "direct" } | { kind: "group"; groupName: string })[] })[];
  byCategory: { name: string; count: number }[];
}
interface CampaignContent {
  items: { id: string; caption: string | null; status: string; pages: { id: string; name: string; category: { id: string; name: string } | null }[] }[];
  total: number;
}

/**
 * Page Network section of the campaign screen: which thematic pages (directly or through a group) the campaign runs on,
 * and the campaign's content narrowed to a page category. A relationship record only: it publishes nothing.
 */
export function CampaignPageNetwork({ campaignId }: { campaignId: string }) {
  const isAdmin = useIsAdmin();
  const { data, error, reload } = useFetch<CampaignPages>(`/api/page-network/campaigns/${campaignId}`);
  const pages = useFetch<Paged<PageItem>>("/api/page-network/pages?pageSize=100");
  const groups = useFetch<{ items: { id: string; name: string }[] }>("/api/page-network/groups");
  const categories = useFetch<{ items: Category[] }>("/api/page-network/categories");
  const [categoryId, setCategoryId] = useState("");
  const content = useFetch<CampaignContent>(categoryId ? `/api/page-network/campaigns/${campaignId}/content${buildQueryString({ categoryId, pageSize: 50 })}` : null);
  const [pickPage, setPickPage] = useState("");
  const [pickGroup, setPickGroup] = useState("");
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  async function run(okText: string, fn: () => Promise<unknown>) {
    setMessage(null);
    try {
      await fn();
      setMessage({ tone: "ok", text: okText });
      reload();
    } catch (err) {
      setMessage({ tone: "error", text: err instanceof ApiError ? err.message : "Something went wrong." });
    }
  }

  if (error) return <Banner tone="error">{error}</Banner>;
  if (!data) return null;
  const freePages = (pages.data?.items ?? []).filter((p) => !data.directPages.some((d) => d.id === p.id));
  const freeGroups = (groups.data?.items ?? []).filter((g) => !data.groups.some((x) => x.id === g.id));

  return (
    <section className="mb-6 rounded border border-border bg-surface p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold tracking-tight">Pages in this campaign</h2>
        <Link href="/page-network" className="text-xs text-muted hover:text-foreground">Page Network</Link>
      </div>
      {message && <Banner tone={message.tone}>{message.text}</Banner>}

      {data.effectivePages.length === 0 ? (
        <p className="text-sm text-muted">No thematic pages are assigned to this campaign yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {data.effectivePages.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm first:pt-0 last:pb-0">
              <div>
                <Link href={`/page-network/pages/${p.id}`} className="font-medium hover:underline">{p.name}</Link>
                <span className="ml-2 text-xs text-muted">{p.category?.name ?? "no category"}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <PlatformChip platform={p.platform} />
                {p.via.map((v, i) => <Chip key={i}>{v.kind === "direct" ? "direct" : `group: ${v.groupName}`}</Chip>)}
                {isAdmin && p.via.some((v) => v.kind === "direct") && (
                  <button onClick={() => run("Page removed from the campaign.", () => apiDelete(`/api/page-network/campaigns/${campaignId}/pages/${p.id}`))} className="text-xs text-muted hover:text-foreground">Remove</button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {data.groups.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3 text-sm">
          <span className="text-muted">Groups:</span>
          {data.groups.map((g) => (
            <span key={g.id} className="flex items-center gap-1.5 rounded border border-border px-2 py-1">
              <Link href={`/page-network/groups/${g.id}`} className="hover:underline">{g.name}</Link>
              <span className="text-xs text-muted">{g.pageCount} pages</span>
              {g.status === "ARCHIVED" && <StatusChip status="ARCHIVED" />}
              {isAdmin && <button onClick={() => run("Group removed from the campaign.", () => apiDelete(`/api/page-network/campaigns/${campaignId}/groups/${g.id}`))} className="text-xs text-muted hover:text-foreground">×</button>}
            </span>
          ))}
        </div>
      )}

      {isAdmin && (
        <div className="mt-3 grid gap-2 border-t border-border pt-3 text-sm md:grid-cols-2">
          <div className="flex gap-2">
            <select value={pickPage} onChange={(e) => setPickPage(e.target.value)} className={`${inputClass} min-w-0 flex-1`}>
              <option value="">Assign a page…</option>
              {freePages.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <button disabled={!pickPage} onClick={() => { const id = pickPage; setPickPage(""); void run("Page assigned.", () => apiPost(`/api/page-network/campaigns/${campaignId}/assignments`, { pageIds: [id] })); }} className="rounded border border-border px-3 py-2 disabled:opacity-40">Assign</button>
          </div>
          <div className="flex gap-2">
            <select value={pickGroup} onChange={(e) => setPickGroup(e.target.value)} className={`${inputClass} min-w-0 flex-1`}>
              <option value="">Assign a page group…</option>
              {freeGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
            <button disabled={!pickGroup} onClick={() => { const id = pickGroup; setPickGroup(""); void run("Group assigned.", () => apiPost(`/api/page-network/campaigns/${campaignId}/assignments`, { groupIds: [id] })); }} className="rounded border border-border px-3 py-2 disabled:opacity-40">Assign</button>
          </div>
        </div>
      )}

      <div className="mt-4 border-t border-border pt-3 text-sm">
        <label className="flex items-center gap-2">
          <span className="text-muted">Content aimed at page category</span>
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className={`${inputClass} py-1`}>
            <option value="">— choose to filter —</option>
            {categories.data?.items.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        {categoryId && content.data && (
          <ul className="mt-2 flex flex-col divide-y divide-border">
            {content.data.items.length === 0 && <li className="py-2 text-muted">No content in this campaign targets a page of that category.</li>}
            {content.data.items.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <Link href={`/content/${c.id}`} className="hover:underline">{c.caption ?? <span className="text-muted">(no caption)</span>}</Link>
                <span className="text-xs text-muted">{c.status.toLowerCase()} · {c.pages.map((p) => p.name).join(", ")}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
