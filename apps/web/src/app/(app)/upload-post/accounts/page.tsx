"use client";

import { useEffect, useState } from "react";
import { apiDelete, apiPost, buildQueryString, ApiError } from "@/lib/api";
import { useCurrentUser } from "@/lib/auth-context";
import { Banner, Chip, Pager, StatusBadge, TONES, formatDateTime, inputClass, useFetch, type Paged, type UploadPostAccountRow } from "@/lib/upload-post";

const PAGE_SIZE = 25;
const PLATFORM_OPTIONS = ["tiktok", "instagram", "youtube", "facebook", "x", "linkedin", "threads", "pinterest", "bluesky"];

export default function AccountsPage() {
  const me = useCurrentUser();
  const isAdmin = me.role === "ADMIN" || me.role === "OWNER";
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [platform, setPlatform] = useState("");
  const [status, setStatus] = useState("");
  const [mapped, setMapped] = useState("");
  const [destination, setDestination] = useState("");
  const [page, setPage] = useState(1);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(searchInput);
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const query = buildQueryString({ search: search || undefined, platform: platform || undefined, status: status || undefined, mapped: mapped || undefined, destination: destination || undefined, page, pageSize: PAGE_SIZE });
  const { data, error, loading, reload } = useFetch<Paged<UploadPostAccountRow>>(`/api/upload-post/accounts${query}`);

  async function toggleDestination(a: UploadPostAccountRow) {
    setBusyId(a.id);
    setNotice(null);
    try {
      if (a.socialAccount) await apiDelete(`/api/upload-post/accounts/${a.id}/destination`);
      else await apiPost(`/api/upload-post/accounts/${a.id}/destination`);
      setNotice({ tone: "ok", text: a.socialAccount ? "Publishing destination disabled." : "Publishing destination enabled — content can now target this account." });
      reload();
    } catch (err) {
      setNotice({ tone: "error", text: err instanceof ApiError ? err.message : "Could not change the destination." });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <p className="mb-4 text-sm text-muted">
        Accounts are keyed by the provider&apos;s stable account id. The public @handle can change when the owner renames or reconnects, so it is shown for reading only.
      </p>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          Search
          <input type="text" placeholder="Handle, name, id or profile…" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} className={`w-60 ${inputClass}`} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Platform
          <select value={platform} onChange={(e) => { setPlatform(e.target.value); setPage(1); }} className={inputClass}>
            <option value="">All</option>
            {PLATFORM_OPTIONS.map((p) => (<option key={p} value={p}>{p}</option>))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Authorization
          <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className={inputClass}>
            <option value="">All</option>
            <option value="CONNECTED">Connected</option>
            <option value="REAUTH_REQUIRED">Reauthorization required</option>
            <option value="DISCONNECTED">Disconnected</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Creator
          <select value={mapped} onChange={(e) => { setMapped(e.target.value); setPage(1); }} className={inputClass}>
            <option value="">All</option>
            <option value="true">Assigned</option>
            <option value="false">Unassigned</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Destination
          <select value={destination} onChange={(e) => { setDestination(e.target.value); setPage(1); }} className={inputClass}>
            <option value="">All</option>
            <option value="true">Enabled</option>
            <option value="false">Not enabled</option>
          </select>
        </label>
      </div>

      {notice && <Banner tone={notice.tone}>{notice.text}</Banner>}
      {error && <Banner tone="error">{error}</Banner>}
      {loading && !data && <p className="text-sm text-muted">Loading…</p>}

      {data && (
        <>
          <div className="overflow-x-auto rounded border border-border">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-border text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-3 py-2">Account</th>
                  <th className="px-3 py-2">Profile</th>
                  <th className="px-3 py-2">Authorization</th>
                  <th className="px-3 py-2">Capabilities</th>
                  <th className="px-3 py-2">Creator</th>
                  <th className="px-3 py-2">Destination</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((a) => (
                  <tr key={a.id} className="border-b border-border last:border-0 align-top">
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <Chip>{a.platform}</Chip>
                        <span className="font-medium">{a.handle ? `@${a.handle.replace(/^@/, "")}` : a.displayName ?? "—"}</span>
                      </div>
                      <div className="mt-1 max-w-[16rem] truncate font-mono text-xs text-muted" title={a.providerAccountId}>
                        id {a.providerAccountId}
                      </div>
                      {a.sharedAcrossProfiles && (
                        <div className="mt-1">
                          <Chip tone={TONES.AMBER} title="The same real account is connected in more than one Upload-Post profile">shared across profiles</Chip>
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <div>{a.profile.displayName ?? a.profile.username}</div>
                      <div className="font-mono text-xs text-muted">{a.profile.username}</div>
                    </td>
                    <td className="px-3 py-2">
                      <StatusBadge status={a.status} />
                      <div className="mt-1 text-xs text-muted">seen {formatDateTime(a.lastSeenAt)}</div>
                      {a.status === "REAUTH_REQUIRED" && <div className="mt-1 text-xs text-amber-400">The owner must reconnect it in Upload-Post.</div>}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex max-w-[14rem] flex-wrap gap-1">
                        {(a.capabilities ?? []).map((c) => (<Chip key={c}>{c}</Chip>))}
                        {(a.capabilities ?? []).length === 0 && <span className="text-muted">—</span>}
                      </div>
                    </td>
                    <td className="px-3 py-2">{a.creator ? a.creator.name : <span className="text-muted">—</span>}</td>
                    <td className="px-3 py-2">
                      {a.publishable === false ? (
                        <span className="text-xs text-muted">{a.platform} is not publishable from Socialith yet</span>
                      ) : a.socialAccount ? (
                        <div className="flex flex-col items-start gap-1">
                          <Chip tone={TONES.GREEN}>enabled</Chip>
                          {isAdmin && (
                            <button disabled={busyId === a.id} onClick={() => toggleDestination(a)} className="text-xs text-muted underline hover:text-foreground disabled:opacity-40">
                              Disable
                            </button>
                          )}
                        </div>
                      ) : isAdmin ? (
                        <button disabled={busyId === a.id || a.status !== "CONNECTED"} onClick={() => toggleDestination(a)} className="rounded border border-border px-2 py-1 text-xs hover:border-foreground disabled:opacity-40" title={a.status !== "CONNECTED" ? "Only connected accounts can be enabled" : undefined}>
                          Enable
                        </button>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
                {data.items.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-3 py-6 text-center text-muted">No accounts match.</td>
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
