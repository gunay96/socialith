"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { buildQueryString } from "@/lib/api";
import { AssetStatusChip, Freshness, KIND_LABEL, factsLine, formatBytes, mediaUrl, usePolling, type AssetDto, type AssetKind, type AssetStatus, type PackDto, type Paged } from "@/lib/studio";
import { Banner, Card, Chip, Pager, TONES, inputClass, useFetch } from "@/lib/upload-post";

interface Facets {
  total: number;
  kinds: { kind: AssetKind; count: number }[];
  tags: { tag: string; count: number }[];
  aspects: { aspectRatio: string; count: number }[];
}

const PAGE_SIZE = 24;
const POLL_MS = 3000;
type StatusFilter = "ACTIVE" | AssetStatus | "ALL";

function AssetCard({ asset }: { asset: AssetDto }) {
  const thumb = mediaUrl(asset.thumbnailUrl);
  const facts = factsLine(asset);
  return (
    <li>
      <Link href={`/studio/assets/${asset.id}`} className="group block rounded border border-border bg-surface transition-colors hover:border-foreground/40 focus-visible:border-foreground focus-visible:outline-none">
        <div className="flex aspect-video items-center justify-center overflow-hidden rounded-t bg-background">
          {thumb ? (
            <img src={thumb} alt="" loading="lazy" className="h-full w-full object-contain" />
          ) : (
            <span className="text-xs uppercase tracking-widest text-muted">{asset.status === "ANALYZING" ? "analyzing…" : KIND_LABEL[asset.kind]}</span>
          )}
        </div>
        <div className="flex flex-col gap-1.5 p-3">
          <div className="truncate text-sm font-medium group-hover:underline" title={asset.originalName}>{asset.originalName}</div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Chip>{KIND_LABEL[asset.kind]}</Chip>
            {asset.status !== "READY" && <AssetStatusChip status={asset.status} />}
            {asset.rights.status === "CONFIRMED" && <Chip tone={TONES.GREEN}>rights confirmed</Chip>}
          </div>
          <div className="text-xs text-muted">{facts || (asset.status === "READY" && !asset.downloadOnly ? "facts not measured" : formatBytes(asset.sizeBytes))}</div>
          {asset.tags.length > 0 && <div className="truncate text-xs text-muted">{asset.tags.slice(0, 4).map((t) => `#${t}`).join(" ")}</div>}
          {asset.rejection && <div className="line-clamp-2 text-xs text-red-400">{asset.rejection.reason}</div>}
        </div>
      </Link>
    </li>
  );
}

export default function MediaLibraryPage() {
  const [searchInput, setSearchInput] = useState("");
  const [q, setQ] = useState("");
  const [kind, setKind] = useState("");
  const [status, setStatus] = useState<StatusFilter>("ACTIVE");
  const [orientation, setOrientation] = useState("");
  const [tag, setTag] = useState("");
  const [packId, setPackId] = useState("");
  const [sort, setSort] = useState("newest");
  const [page, setPage] = useState(1);

  // deep links: /studio?packId=…
  useEffect(() => {
    const p = new URLSearchParams(window.location.search).get("packId");
    if (p) setPackId(p);
  }, []);
  // search as you type, but not on every keystroke
  useEffect(() => {
    const t = setTimeout(() => {
      setQ(searchInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const path = `/api/media/assets${buildQueryString({ q: q || undefined, kind: kind || undefined, status, orientation: orientation || undefined, tag: tag || undefined, packId: packId || undefined, sort, page, pageSize: PAGE_SIZE })}`;
  // keeps refreshing (the tab pauses it while hidden) so files added from elsewhere and finished analyses show up without a reload
  const list = usePolling<Paged<AssetDto>>(path, POLL_MS);
  const facets = useFetch<Facets>("/api/media/facets");
  const packs = useFetch<Paged<PackDto>>("/api/media/packs?pageSize=50");

  const reset = (fn: () => void) => {
    fn();
    setPage(1);
  };
  const processing = packs.data?.items.filter((p) => p.status === "PROCESSING") ?? [];
  const filtered = Boolean(q || kind || orientation || tag || packId || status !== "ACTIVE");

  return (
    <div className="flex flex-col gap-4">
      {processing.length > 0 && (
        <Banner tone="info">
          {processing.length} pack{processing.length === 1 ? " is" : "s are"} still being processed. <Link href="/studio/queue" className="underline">See the progress</Link>.
        </Banner>
      )}

      <Card title="Search and filter" action={<Freshness updatedAt={list.updatedAt} intervalMs={POLL_MS} />}>
        <div className="flex flex-wrap items-end gap-3 text-sm">
          <label className="flex flex-col gap-1">
            Search
            <input type="search" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} placeholder="name, folder or tag" className={`${inputClass} w-56`} />
          </label>
          <label className="flex flex-col gap-1">
            Type
            <select value={kind} onChange={(e) => reset(() => setKind(e.target.value))} className={inputClass}>
              <option value="">All types{facets.data ? ` (${facets.data.total})` : ""}</option>
              {facets.data?.kinds.map((k) => <option key={k.kind} value={k.kind}>{KIND_LABEL[k.kind]} ({k.count})</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            Shape
            <select value={orientation} onChange={(e) => reset(() => setOrientation(e.target.value))} className={inputClass}>
              <option value="">Any</option>
              <option value="portrait">Vertical</option>
              <option value="landscape">Horizontal</option>
              <option value="square">Square</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            Tag
            <select value={tag} onChange={(e) => reset(() => setTag(e.target.value))} className={inputClass}>
              <option value="">Any</option>
              {facets.data?.tags.map((t) => <option key={t.tag} value={t.tag}>#{t.tag} ({t.count})</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            Pack
            <select value={packId} onChange={(e) => reset(() => setPackId(e.target.value))} className={inputClass}>
              <option value="">All packs</option>
              {packs.data?.items.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            Show
            <select value={status} onChange={(e) => reset(() => setStatus(e.target.value as StatusFilter))} className={inputClass}>
              <option value="ACTIVE">Usable files</option>
              <option value="REJECTED">Refused</option>
              <option value="DUPLICATE">Duplicates</option>
              <option value="ARCHIVED">Archived</option>
              <option value="ALL">Everything</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            Sort
            <select value={sort} onChange={(e) => reset(() => setSort(e.target.value))} className={inputClass}>
              <option value="newest">Newest</option>
              <option value="oldest">Oldest</option>
              <option value="name">Name</option>
              <option value="size">Largest</option>
              <option value="duration">Longest</option>
            </select>
          </label>
          {filtered && (
            <button onClick={() => { setSearchInput(""); setQ(""); setKind(""); setStatus("ACTIVE"); setOrientation(""); setTag(""); setPackId(""); setPage(1); }} className="pb-2 text-xs text-muted hover:text-foreground">
              Clear filters
            </button>
          )}
        </div>
      </Card>

      {list.error && <Banner tone="error">{list.error}</Banner>}
      {list.loading && !list.data && <p className="text-sm text-muted">Loading…</p>}

      {list.data && list.data.items.length === 0 && (
        <div className="rounded border border-dashed border-border p-8 text-center text-sm text-muted">
          {filtered ? "No files match these filters." : <>Your media library is empty. <Link href="/studio/upload" className="underline">Upload a ZIP pack or single files</Link>.</>}
        </div>
      )}

      {list.data && list.data.items.length > 0 && (
        <ul className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4" aria-label="Media files">
          {list.data.items.map((a) => <AssetCard key={a.id} asset={a} />)}
        </ul>
      )}
      {list.data && <Pager page={page} total={list.data.total} pageSize={PAGE_SIZE} onPage={setPage} />}

      {packs.data && packs.data.items.length > 0 && (
        <Card title="Packs">
          <ul className="flex flex-col divide-y divide-border">
            {packs.data.items.slice(0, 8).map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm first:pt-0 last:pb-0">
                <Link href={`/studio/packs/${p.id}`} className="font-medium hover:underline">{p.name}</Link>
                <span className="flex items-center gap-2 text-xs text-muted">
                  {p.counts.ready} ready{p.counts.rejected + p.counts.failed > 0 ? ` · ${p.counts.rejected + p.counts.failed} with problems` : ""}{p.counts.duplicate ? ` · ${p.counts.duplicate} duplicates` : ""}
                  <Chip tone={p.status === "READY" ? TONES.GREEN : p.status === "FAILED" ? TONES.RED : p.status === "PROCESSING" ? TONES.BLUE : p.status === "PARTIAL" ? TONES.AMBER : TONES.NEUTRAL}>{p.status.toLowerCase()}</Chip>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
