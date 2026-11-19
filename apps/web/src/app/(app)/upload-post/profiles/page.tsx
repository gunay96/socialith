"use client";

import { useEffect, useState } from "react";
import { buildQueryString } from "@/lib/api";
import { Banner, Chip, Pager, StatusBadge, TONES, formatDateTime, inputClass, useFetch, type Paged, type UploadPostProfileRow } from "@/lib/upload-post";

const PAGE_SIZE = 25;

export default function ProfilesPage() {
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [mapped, setMapped] = useState("");
  const [page, setPage] = useState(1);

  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(searchInput);
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const query = buildQueryString({ search: search || undefined, status: status || undefined, mapped: mapped || undefined, page, pageSize: PAGE_SIZE });
  const { data, error, loading } = useFetch<Paged<UploadPostProfileRow>>(`/api/upload-post/profiles${query}`);

  return (
    <div>
      <p className="mb-4 text-sm text-muted">
        A profile is Upload-Post&apos;s container: it can hold one account per platform. It is not a single social account.
      </p>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          Search
          <input type="text" placeholder="Profile, handle or name…" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} className={`w-64 ${inputClass}`} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Status
          <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className={inputClass}>
            <option value="">All</option>
            <option value="ACTIVE">Active</option>
            <option value="REMOVED">Removed upstream</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Page mapping
          <select value={mapped} onChange={(e) => { setMapped(e.target.value); setPage(1); }} className={inputClass}>
            <option value="">All</option>
            <option value="true">Assigned to a page</option>
            <option value="false">Not assigned</option>
          </select>
        </label>
      </div>

      {error && <Banner tone="error">{error}</Banner>}
      {loading && !data && <p className="text-sm text-muted">Loading…</p>}

      {data && (
        <>
          <div className="overflow-x-auto rounded border border-border">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-border text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-3 py-2">Profile</th>
                  <th className="px-3 py-2">Connected accounts</th>
                  <th className="px-3 py-2">Thematic page</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Last synced</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((p) => (
                  <tr key={p.id} className="border-b border-border last:border-0 align-top">
                    <td className="px-3 py-2">
                      <div className="font-medium">{p.displayName ?? p.username}</div>
                      <div className="font-mono text-xs text-muted">{p.username}</div>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-1">
                        {p.accounts.map((a) => (
                          <Chip key={a.id} tone={a.status === "CONNECTED" ? TONES.GREEN : a.status === "REAUTH_REQUIRED" ? TONES.AMBER : TONES.RED} title={`${a.platform} · ${a.status}`}>
                            {a.platform}
                            {a.handle ? ` @${a.handle.replace(/^@/, "")}` : ""}
                          </Chip>
                        ))}
                        {(p.pendingPlatforms ?? []).map((pl) => (
                          <Chip key={pl} tone={TONES.BLUE} title="Started but not finished at the provider">
                            {pl} pending
                          </Chip>
                        ))}
                        {p.accounts.length === 0 && !(p.pendingPlatforms ?? []).length && <span className="text-muted">No accounts connected</span>}
                      </div>
                    </td>
                    <td className="px-3 py-2">{p.managedPage ? p.managedPage.name : <span className="text-muted">—</span>}</td>
                    <td className="px-3 py-2">
                      <StatusBadge status={p.status} />
                    </td>
                    <td className="px-3 py-2 text-muted">{formatDateTime(p.lastSyncedAt)}</td>
                  </tr>
                ))}
                {data.items.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-3 py-6 text-center text-muted">
                      No profiles match. Run a synchronization from the Overview if none were imported yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <Pager page={page} total={data.total} pageSize={data.pageSize} onPage={setPage} />
        </>
      )}
    </div>
  );
}
