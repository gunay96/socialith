"use client";

import { useEffect, useState } from "react";
import { Banner, useFetch } from "@/lib/upload-post";
import { EMPTY_FILTERS, FilterBar, filtersToQuery, useTimezone, type FilterValues, type PubPage } from "@/lib/publishing";
import { PublicationTable } from "./publication-table";

/**
 * One list view of the Publishing Center. The queue, scheduled and failed pages are presets of this (a fixed set of
 * lifecycle states + sort); "All publications" has the free status filter and reads `?state=` so the overview's
 * counters can link into it.
 */
export function PublicationListPage({
  presetStates,
  sort,
  showReason = false,
  ownerTabs = false,
  emptyText,
  intro,
}: {
  presetStates?: string;
  sort: "scheduledAt_asc" | "scheduledAt_desc" | "updatedAt_desc";
  showReason?: boolean;
  ownerTabs?: boolean;
  emptyText?: string;
  intro?: React.ReactNode;
}) {
  const tz = useTimezone();
  const [filters, setFilters] = useState<FilterValues>(EMPTY_FILTERS);
  const [owner, setOwner] = useState<"" | "SOCIALITH" | "PROVIDER">("");
  const [page, setPage] = useState(1);

  useEffect(() => {
    if (presetStates) return;
    const s = new URLSearchParams(window.location.search).get("state");
    if (s) setFilters((f) => ({ ...f, state: s }));
  }, [presetStates]);

  const query = filtersToQuery({ ...filters, state: presetStates ?? filters.state }, tz, { page, pageSize: 25, sort, owner: owner || undefined });
  const { data, error, loading, reload } = useFetch<PubPage>(`/api/publishing/publications${query}`);

  return (
    <div>
      {intro && <p className="mb-4 text-sm text-muted">{intro}</p>}
      <FilterBar value={filters} onChange={(v) => { setFilters(v); setPage(1); }} hide={presetStates ? ["state"] : []} />
      {ownerTabs && (
        <div className="mb-3 flex gap-1 text-sm">
          {([["", "All"], ["SOCIALITH", "Socialith queue"], ["PROVIDER", "Upload-Post scheduler"]] as const).map(([v, l]) => (
            <button key={v} onClick={() => { setOwner(v); setPage(1); }} className={`rounded px-3 py-1 ${owner === v ? "bg-accent/15 text-foreground" : "text-muted hover:text-foreground"}`}>{l}</button>
          ))}
        </div>
      )}
      {error && <Banner tone="error">{error}</Banner>}
      {loading && !data && <p className="text-sm text-muted">Loading…</p>}
      {data && <PublicationTable items={data.items} tz={tz} onChanged={reload} showReason={showReason} total={data.total} page={data.page} pageSize={data.pageSize} onPage={setPage} emptyText={emptyText} />}
    </div>
  );
}
