"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import {
  apiGet,
  apiPost,
  buildQueryString,
  ApiError,
  CONTENT_STATUSES,
  PLATFORMS,
  type Content,
  type ContentStatus,
  type ListCampaignsResult,
  type ListContentResult,
  type Platform,
} from "@/lib/api";
import { useCurrentUser } from "@/lib/auth-context";

const PAGE_SIZE = 25;

export default function ContentListPage() {
  const me = useCurrentUser();
  const canEdit = me.role !== "VIEWER";

  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<ContentStatus | "">("");
  const [platform, setPlatform] = useState<Platform | "">("");
  const [campaignId, setCampaignId] = useState("");
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<ListContentResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [campaigns, setCampaigns] = useState<ListCampaignsResult | null>(null);

  const [showCreate, setShowCreate] = useState(false);
  const [newCaption, setNewCaption] = useState("");
  const [newCampaignId, setNewCampaignId] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    apiGet<ListCampaignsResult>(`/api/campaigns${buildQueryString({ pageSize: 100 })}`).then(setCampaigns);
  }, []);

  function load() {
    const query = buildQueryString({
      search: search || undefined,
      status: status || undefined,
      platform: platform || undefined,
      campaignId: campaignId || undefined,
      page,
      pageSize: PAGE_SIZE,
    });
    apiGet<ListContentResult>(`/api/content${query}`)
      .then(setResult)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Something went wrong."));
  }

  useEffect(load, [search, status, platform, campaignId, page]);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setCreateError(null);
    setCreating(true);
    try {
      const created = await apiPost<Content>("/api/content", {
        caption: newCaption || undefined,
        campaignId: newCampaignId || undefined,
      });
      window.location.href = `/content/${created.id}`;
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : "Something went wrong.");
      setCreating(false);
    }
  }

  const totalPages = result ? Math.max(1, Math.ceil(result.total / result.pageSize)) : 1;

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Content</h1>
        {canEdit && (
          <button
            onClick={() => setShowCreate((v) => !v)}
            className="rounded bg-foreground px-3 py-2 text-sm font-medium text-background"
          >
            {showCreate ? "Cancel" : "New content"}
          </button>
        )}
      </div>

      {showCreate && (
        <form onSubmit={handleCreate} className="mb-6 flex flex-col gap-3 rounded border border-border bg-surface p-4">
          <label className="flex flex-col gap-1 text-sm">
            Caption
            <textarea
              value={newCaption}
              onChange={(e) => setNewCaption(e.target.value)}
              className="rounded border border-border bg-background px-3 py-2 text-foreground outline-none focus:border-foreground"
              rows={2}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Campaign (optional)
            <select
              value={newCampaignId}
              onChange={(e) => setNewCampaignId(e.target.value)}
              className="rounded border border-border bg-background px-3 py-2 text-foreground outline-none focus:border-foreground"
            >
              <option value="">None</option>
              {campaigns?.items.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          {createError && <p className="text-sm text-red-400">{createError}</p>}
          <button
            type="submit"
            disabled={creating}
            className="w-fit rounded bg-foreground px-3 py-2 text-sm font-medium text-background disabled:opacity-50"
          >
            {creating ? "Creating…" : "Create content"}
          </button>
        </form>
      )}

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          Search
          <input
            type="text"
            placeholder="Caption…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="w-56 rounded border border-border bg-surface px-3 py-2 text-foreground outline-none focus:border-foreground"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Status
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as ContentStatus | "");
              setPage(1);
            }}
            className="rounded border border-border bg-surface px-3 py-2 text-foreground outline-none focus:border-foreground"
          >
            <option value="">All</option>
            {CONTENT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Platform
          <select
            value={platform}
            onChange={(e) => {
              setPlatform(e.target.value as Platform | "");
              setPage(1);
            }}
            className="rounded border border-border bg-surface px-3 py-2 text-foreground outline-none focus:border-foreground"
          >
            <option value="">All</option>
            {PLATFORMS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Campaign
          <select
            value={campaignId}
            onChange={(e) => {
              setCampaignId(e.target.value);
              setPage(1);
            }}
            className="rounded border border-border bg-surface px-3 py-2 text-foreground outline-none focus:border-foreground"
          >
            <option value="">All</option>
            {campaigns?.items.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error && <p className="mb-4 text-sm text-red-400">{error}</p>}
      {!result && !error && <p className="text-sm text-muted">Loading…</p>}

      {result && (
        <>
          <div className="rounded border border-border bg-surface">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-border text-muted">
                  <th className="px-4 py-2 font-normal">Caption</th>
                  <th className="px-4 py-2 font-normal">Status</th>
                  <th className="px-4 py-2 font-normal">Targets</th>
                  <th className="px-4 py-2 font-normal">Scheduled</th>
                </tr>
              </thead>
              <tbody>
                {result.items.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-4 py-6 text-center text-muted">
                      No content matches these filters.
                    </td>
                  </tr>
                )}
                {result.items.map((item) => (
                  <tr key={item.id} className="border-b border-border last:border-0 hover:bg-background/40">
                    <td className="max-w-xs truncate px-4 py-2">
                      <Link href={`/content/${item.id}`} className="hover:underline">
                        {item.caption ?? <span className="text-muted">(no caption)</span>}
                      </Link>
                    </td>
                    <td className="px-4 py-2">{item.status}</td>
                    <td className="px-4 py-2">{item._count.targets}</td>
                    <td className="px-4 py-2 text-muted">
                      {item.scheduledAt ? new Date(item.scheduledAt).toLocaleString() : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-4 flex items-center justify-between text-sm text-muted">
            <span>
              {result.total} item{result.total === 1 ? "" : "s"} — page {result.page} of {totalPages}
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="rounded border border-border px-3 py-1.5 disabled:opacity-40"
              >
                Previous
              </button>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                className="rounded border border-border px-3 py-1.5 disabled:opacity-40"
              >
                Next
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
