"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import {
  apiGet,
  apiPost,
  buildQueryString,
  ApiError,
  CAMPAIGN_STATUSES,
  type Campaign,
  type CampaignStatus,
  type ListCampaignsResult,
} from "@/lib/api";
import { useCurrentUser } from "@/lib/auth-context";

const PAGE_SIZE = 25;

export default function CampaignsPage() {
  const me = useCurrentUser();
  const canEdit = me.role !== "VIEWER";

  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<CampaignStatus | "">("");
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<ListCampaignsResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  function load() {
    const query = buildQueryString({ search: search || undefined, status: status || undefined, page, pageSize: PAGE_SIZE });
    apiGet<ListCampaignsResult>(`/api/campaigns${query}`)
      .then(setResult)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Something went wrong."));
  }

  useEffect(load, [search, status, page]);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setCreateError(null);
    setCreating(true);
    try {
      await apiPost<Campaign>("/api/campaigns", { name: newName, description: newDescription || undefined });
      setNewName("");
      setNewDescription("");
      setShowCreate(false);
      setPage(1);
      load();
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setCreating(false);
    }
  }

  const totalPages = result ? Math.max(1, Math.ceil(result.total / result.pageSize)) : 1;

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Campaigns</h1>
        {canEdit && (
          <button
            onClick={() => setShowCreate((v) => !v)}
            className="rounded bg-foreground px-3 py-2 text-sm font-medium text-background"
          >
            {showCreate ? "Cancel" : "New campaign"}
          </button>
        )}
      </div>

      {showCreate && (
        <form onSubmit={handleCreate} className="mb-6 flex flex-col gap-3 rounded border border-border bg-surface p-4">
          <label className="flex flex-col gap-1 text-sm">
            Name
            <input
              type="text"
              required
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              className="rounded border border-border bg-background px-3 py-2 text-foreground outline-none focus:border-foreground"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Description
            <textarea
              value={newDescription}
              onChange={(e) => setNewDescription(e.target.value)}
              className="rounded border border-border bg-background px-3 py-2 text-foreground outline-none focus:border-foreground"
              rows={2}
            />
          </label>
          {createError && <p className="text-sm text-red-400">{createError}</p>}
          <button
            type="submit"
            disabled={creating}
            className="w-fit rounded bg-foreground px-3 py-2 text-sm font-medium text-background disabled:opacity-50"
          >
            {creating ? "Creating…" : "Create campaign"}
          </button>
        </form>
      )}

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          Search
          <input
            type="text"
            placeholder="Campaign name…"
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
              setStatus(e.target.value as CampaignStatus | "");
              setPage(1);
            }}
            className="rounded border border-border bg-surface px-3 py-2 text-foreground outline-none focus:border-foreground"
          >
            <option value="">All</option>
            {CAMPAIGN_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
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
                  <th className="px-4 py-2 font-normal">Name</th>
                  <th className="px-4 py-2 font-normal">Status</th>
                  <th className="px-4 py-2 font-normal">Created</th>
                </tr>
              </thead>
              <tbody>
                {result.items.length === 0 && (
                  <tr>
                    <td colSpan={3} className="px-4 py-6 text-center text-muted">
                      No campaigns match these filters.
                    </td>
                  </tr>
                )}
                {result.items.map((c) => (
                  <tr key={c.id} className="border-b border-border last:border-0 hover:bg-background/40">
                    <td className="px-4 py-2">
                      <Link href={`/campaigns/${c.id}`} className="hover:underline">
                        {c.name}
                      </Link>
                    </td>
                    <td className="px-4 py-2">{c.status}</td>
                    <td className="px-4 py-2 text-muted">{new Date(c.createdAt).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-4 flex items-center justify-between text-sm text-muted">
            <span>
              {result.total} campaign{result.total === 1 ? "" : "s"} — page {result.page} of {totalPages}
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
