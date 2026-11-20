"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ApiError, apiPost, buildQueryString } from "@/lib/api";
import { PLATFORMS, StatusChip, hintClass, labelClass, useIsAdmin, type Category, type PageItem, type Paged, type Status } from "@/lib/page-network";
import { PLATFORM_LABEL } from "@/lib/publishing";
import { Banner, Card, Chip, inputClass, useFetch } from "@/lib/upload-post";

interface GroupRow {
  id: string;
  name: string;
  description: string | null;
  status: Status;
  pageCount: number;
  stats: { pages: { total: number; active: number }; byPlatform: Record<string, number>; mapping: { ready: number; problem: number; unlinked: number } };
}

export default function PageGroupsPage() {
  const router = useRouter();
  const isAdmin = useIsAdmin();
  const [categoryId, setCategoryId] = useState("");
  const [platform, setPlatform] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const categories = useFetch<{ items: Category[] }>("/api/page-network/categories");
  const { data, error, loading } = useFetch<{ items: GroupRow[] }>(`/api/page-network/groups${buildQueryString({ status: showArchived ? "ALL" : "ACTIVE", categoryId: categoryId || undefined, platform: platform || undefined })}`);
  const pages = useFetch<Paged<PageItem>>("/api/page-network/pages?pageSize=100");
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: "", description: "", pageIds: [] as string[] });
  const [formError, setFormError] = useState<string | null>(null);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    try {
      const g = await apiPost<{ id: string }>("/api/page-network/groups", { name: form.name.trim(), description: form.description.trim() || null, pageIds: form.pageIds });
      router.push(`/page-network/groups/${g.id}`);
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "Could not create the group.");
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3 text-sm">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            Category
            <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className={inputClass}>
              <option value="">All</option>
              {categories.data?.items.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            Platform
            <select value={platform} onChange={(e) => setPlatform(e.target.value)} className={inputClass}>
              <option value="">All</option>
              {PLATFORMS.map((p) => <option key={p} value={p}>{PLATFORM_LABEL[p]}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-2 pb-2 text-muted"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived</label>
        </div>
        {isAdmin && <button onClick={() => setCreating(!creating)} className="rounded bg-accent px-3 py-2 font-medium text-background">New group</button>}
      </div>

      {creating && isAdmin && (
        <Card title="New group">
          <form onSubmit={create} className="flex flex-col gap-3">
            {formError && <Banner tone="error">{formError}</Banner>}
            <div className="grid gap-3 md:grid-cols-2">
              <label className={labelClass}>Name<input required maxLength={120} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="MOTIVATION NETWORK" className={inputClass} /></label>
              <label className={labelClass}>Description<input maxLength={2000} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className={inputClass} /></label>
            </div>
            <div className={labelClass}>
              Pages
              <div className="flex max-h-48 flex-wrap gap-2 overflow-y-auto rounded border border-border p-2">
                {pages.data?.items.length === 0 && <span className="text-xs text-muted">No pages yet.</span>}
                {pages.data?.items.map((p) => {
                  const on = form.pageIds.includes(p.id);
                  return (
                    <label key={p.id} className={`flex cursor-pointer items-center gap-2 rounded border px-2 py-1 text-xs ${on ? "border-accent bg-accent/10" : "border-border"}`}>
                      <input type="checkbox" checked={on} onChange={(e) => setForm({ ...form, pageIds: e.target.checked ? [...form.pageIds, p.id] : form.pageIds.filter((x) => x !== p.id) })} />
                      {p.name} <span className="text-muted">{p.platform ? (PLATFORM_LABEL[p.platform] ?? p.platform) : ""}</span>
                    </label>
                  );
                })}
              </div>
              <span className={hintClass}>A page can be in several groups. You can add and remove pages later.</span>
            </div>
            <div><button disabled={!form.name.trim()} className="rounded bg-accent px-4 py-2 text-sm font-medium text-background disabled:opacity-40">Create group</button></div>
          </form>
        </Card>
      )}

      {error && <Banner tone="error">{error}</Banner>}
      {loading && !data && <p className="text-sm text-muted">Loading…</p>}
      {data && data.items.length === 0 && <p className="text-sm text-muted">No groups match.</p>}
      <div className="grid gap-4 md:grid-cols-2">
        {data?.items.map((g) => (
          <Card key={g.id} title={g.name} action={<StatusChip status={g.status} />}>
            {g.description && <p className="mb-2 text-sm text-muted">{g.description}</p>}
            <div className="flex flex-wrap gap-1.5 text-xs">
              <Chip>{g.pageCount} page{g.pageCount === 1 ? "" : "s"}</Chip>
              {Object.entries(g.stats.byPlatform).map(([p, n]) => <Chip key={p}>{PLATFORM_LABEL[p] ?? "no platform"} {n}</Chip>)}
              <Chip tone={g.stats.mapping.ready ? "border-green-900 bg-green-950/40 text-green-400" : undefined}>{g.stats.mapping.ready} ready</Chip>
              {g.stats.mapping.problem > 0 && <Chip tone="border-red-900 bg-red-950/40 text-red-400">{g.stats.mapping.problem} with a problem</Chip>}
              {g.stats.mapping.unlinked > 0 && <Chip>{g.stats.mapping.unlinked} without account</Chip>}
            </div>
            <Link href={`/page-network/groups/${g.id}`} className="mt-3 inline-block text-sm underline">Open group</Link>
          </Card>
        ))}
      </div>
    </div>
  );
}
