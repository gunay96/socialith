"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { buildQueryString } from "@/lib/api";
import { MappingBadge, PLATFORMS, PlatformChip, StatusChip, type Category, type PageItem, type Paged } from "@/lib/page-network";
import { PLATFORM_LABEL } from "@/lib/publishing";
import { Banner, Card, Chip, Pager, TONES, inputClass, useFetch } from "@/lib/upload-post";

interface Filters {
  search: string;
  status: "ACTIVE" | "ARCHIVED" | "ALL";
  platform: string;
  /** a category id, "none" (pages without one) or "" */
  category: string;
  groupId: string;
  mapping: string;
}
const EMPTY: Filters = { search: "", status: "ACTIVE", platform: "", category: "", groupId: "", mapping: "" };
const PAGE_SIZE = 25;

export default function ManagedPagesPage() {
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [searchInput, setSearchInput] = useState("");
  const [page, setPage] = useState(1);

  // deep links from the overview: ?categoryId=… / ?category=none / ?groupId=…
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const category = q.get("categoryId") ?? (q.get("category") === "none" ? "none" : "");
    const groupId = q.get("groupId") ?? "";
    if (category || groupId) setFilters((f) => ({ ...f, category, groupId }));
  }, []);

  const categories = useFetch<{ items: Category[] }>("/api/page-network/categories?status=ALL");
  const groups = useFetch<{ items: { id: string; name: string }[] }>("/api/page-network/groups");
  const query = buildQueryString({
    page,
    pageSize: PAGE_SIZE,
    search: filters.search || undefined,
    status: filters.status,
    platform: filters.platform || undefined,
    categoryId: filters.category && filters.category !== "none" ? filters.category : undefined,
    category: filters.category === "none" ? "none" : undefined,
    groupId: filters.groupId || undefined,
    mapping: filters.mapping || undefined,
  });
  const { data, error, loading } = useFetch<Paged<PageItem>>(`/api/page-network/pages${query}`);

  const set = (patch: Partial<Filters>) => {
    setFilters({ ...filters, ...patch });
    setPage(1);
  };

  return (
    <div className="flex flex-col gap-4">
      <Card title="Filters" action={<button onClick={() => { setFilters(EMPTY); setSearchInput(""); setPage(1); }} className="text-xs text-muted hover:text-foreground">Reset</button>}>
        <div className="flex flex-wrap items-end gap-3 text-sm">
          <form onSubmit={(e) => { e.preventDefault(); set({ search: searchInput.trim() }); }} className="flex flex-col gap-1">
            <label htmlFor="pn-search">Search</label>
            <input id="pn-search" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} placeholder="name or @username" className={`${inputClass} w-52`} />
          </form>
          <label className="flex flex-col gap-1">
            Category
            <select value={filters.category} onChange={(e) => set({ category: e.target.value })} className={inputClass}>
              <option value="">All</option>
              <option value="none">No category</option>
              {categories.data?.items.map((c) => (
                <option key={c.id} value={c.id}>{c.name}{c.status === "ARCHIVED" ? " (archived)" : ""}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            Platform
            <select value={filters.platform} onChange={(e) => set({ platform: e.target.value })} className={inputClass}>
              <option value="">All</option>
              {PLATFORMS.map((p) => <option key={p} value={p}>{PLATFORM_LABEL[p]}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            Group
            <select value={filters.groupId} onChange={(e) => set({ groupId: e.target.value })} className={inputClass}>
              <option value="">All</option>
              {groups.data?.items.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            Account
            <select value={filters.mapping} onChange={(e) => set({ mapping: e.target.value })} className={inputClass}>
              <option value="">Any</option>
              <option value="LINKED">Has an account</option>
              <option value="UNLINKED">No account</option>
              <option value="PROBLEM">Account has a problem</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            Status
            <select value={filters.status} onChange={(e) => set({ status: e.target.value as Filters["status"] })} className={inputClass}>
              <option value="ACTIVE">Active</option>
              <option value="ARCHIVED">Archived</option>
              <option value="ALL">All</option>
            </select>
          </label>
        </div>
      </Card>

      {error && <Banner tone="error">{error}</Banner>}
      <div className="overflow-x-auto rounded border border-border bg-surface">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-border text-muted">
              <th className="px-4 py-2 font-normal">Page</th>
              <th className="px-4 py-2 font-normal">Platform</th>
              <th className="px-4 py-2 font-normal">Category</th>
              <th className="px-4 py-2 font-normal">Groups</th>
              <th className="px-4 py-2 font-normal">Publishing account</th>
            </tr>
          </thead>
          <tbody>
            {loading && !data && (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-muted">Loading…</td></tr>
            )}
            {data && data.items.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-muted">No pages match. <Link href="/page-network/pages/new" className="underline">Create a page</Link>.</td></tr>
            )}
            {data?.items.map((p) => (
              <tr key={p.id} className="border-b border-border last:border-0 hover:bg-background/40">
                <td className="px-4 py-2">
                  <Link href={`/page-network/pages/${p.id}`} className="font-medium hover:underline">{p.name}</Link>
                  <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
                    {p.username ? `@${p.username}` : "no username"}
                    {p.status === "ARCHIVED" && <StatusChip status="ARCHIVED" />}
                    {p.incomplete.length > 0 && <Chip tone={TONES.AMBER} title={`Missing: ${p.incomplete.join(", ")}`}>incomplete</Chip>}
                  </div>
                </td>
                <td className="px-4 py-2"><PlatformChip platform={p.platform} /></td>
                <td className="px-4 py-2">{p.category ? <>{p.category.name}{p.category.status === "ARCHIVED" && <span className="text-xs text-muted"> (archived)</span>}</> : <span className="text-muted">—</span>}</td>
                <td className="px-4 py-2 text-muted">{p.groups.length ? p.groups.map((g) => g.name).join(", ") : "—"}</td>
                <td className="px-4 py-2">
                  <MappingBadge state={p.mapping.state} label={p.mapping.stateLabel} />
                  {p.mapping.destination && <div className="mt-1 text-xs text-muted">@{p.mapping.destination.handle}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data && <Pager page={page} total={data.total} pageSize={PAGE_SIZE} onPage={setPage} />}
    </div>
  );
}
