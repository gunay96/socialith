"use client";

import { useState } from "react";
import { buildQueryString } from "@/lib/api";
import { Banner, Chip, Pager, StatusBadge, TONES, formatDateTime, inputClass, useFetch, type Paged, type PublicationRow } from "@/lib/upload-post";

const PAGE_SIZE = 25;
const STATUSES = ["PENDING", "PROCESSING", "SCHEDULED_AT_PROVIDER", "COMPLETED", "FAILED", "CANCELLED", "UNKNOWN_OUTCOME"];

export default function HistoryPage() {
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const { data, error, loading } = useFetch<Paged<PublicationRow>>(`/api/upload-post/publications${buildQueryString({ status: status || undefined, page, pageSize: PAGE_SIZE })}`);

  return (
    <div>
      <p className="mb-4 text-sm text-muted">
        Every publication Socialith sent through Upload-Post. Each one is matched to the provider&apos;s record by its <code>external_id</code> — never by the post title.
      </p>
      <label className="mb-4 flex w-56 flex-col gap-1 text-sm">
        Status
        <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className={inputClass}>
          <option value="">All</option>
          {STATUSES.map((s) => (<option key={s} value={s}>{s.replace(/_/g, " ")}</option>))}
        </select>
      </label>

      {error && <Banner tone="error">{error}</Banner>}
      {loading && !data && <p className="text-sm text-muted">Loading…</p>}
      {data && (
        <>
          <div className="overflow-x-auto rounded border border-border">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-border text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-3 py-2">Updated</th>
                  <th className="px-3 py-2">Content</th>
                  <th className="px-3 py-2">Destination</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Provider correlation</th>
                  <th className="px-3 py-2">Result</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((p) => (
                  <tr key={p.id} className="border-b border-border last:border-0 align-top">
                    <td className="px-3 py-2 text-muted">{formatDateTime(p.updatedAt)}</td>
                    <td className="max-w-[16rem] px-3 py-2">
                      <div className="truncate" title={p.contentTarget.content.caption ?? ""}>{p.contentTarget.content.caption ?? "(no caption)"}</div>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2"><Chip>{p.platform}</Chip>@{p.contentTarget.socialAccount.handle.replace(/^@/, "")}</div>
                      <div className="font-mono text-xs text-muted">{p.profileUsername}</div>
                    </td>
                    <td className="px-3 py-2">
                      <StatusBadge status={p.status} />
                      <div className="mt-1"><Chip tone={p.mode === "PROVIDER_SCHEDULED" ? TONES.BLUE : TONES.NEUTRAL}>{p.mode === "PROVIDER_SCHEDULED" ? "provider schedule" : "immediate"}</Chip></div>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-muted">
                      <div className="max-w-[16rem] truncate" title={p.externalId}>ext {p.externalId}</div>
                      {p.providerJobId && <div>job {p.providerJobId}</div>}
                    </td>
                    <td className="max-w-[18rem] px-3 py-2 text-xs">
                      {p.lastErrorMessage && <div className="text-red-400">{p.lastErrorKind}: {p.lastErrorMessage}</div>}
                      {p.notes && <div className="text-amber-400">{p.notes}</div>}
                      {!p.lastErrorMessage && !p.notes && <span className="text-muted">—</span>}
                    </td>
                  </tr>
                ))}
                {data.items.length === 0 && (<tr><td colSpan={6} className="px-3 py-6 text-center text-muted">No publications yet.</td></tr>)}
              </tbody>
            </table>
          </div>
          <Pager page={page} total={data.total} pageSize={data.pageSize} onPage={setPage} />
        </>
      )}
    </div>
  );
}
