"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { COMMON_LANGUAGES, TEXT_MAX_LENGTH, textLength } from "@socialith/studio";
import { ApiError, apiPost, buildQueryString } from "@/lib/api";
import { usePolling, useStudioRole, type Paged } from "@/lib/studio";
import { ApprovalChip, ChipPicker, RightsChip, languageLabel, useAction, type ApprovalStatus, type TextCategory, type TextCollection, type TextDto, type TextSummary } from "@/lib/texts";
import { Banner, Card, Chip, Pager, formatDateTime, inputClass, useFetch } from "@/lib/upload-post";

const PAGE_SIZE = 30;
const POLL_MS = 15000;
type Tab = "ACTIVE" | ApprovalStatus;
const TABS: { key: Tab; label: string; count: (s: TextSummary) => number }[] = [
  { key: "PENDING", label: "Needs review", count: (s) => s.status.PENDING },
  { key: "APPROVED", label: "Approved", count: (s) => s.status.APPROVED },
  { key: "REJECTED", label: "Rejected", count: (s) => s.status.REJECTED },
  { key: "ARCHIVED", label: "Archived", count: (s) => s.status.ARCHIVED },
  { key: "ACTIVE", label: "All active", count: (s) => s.active },
];

export default function TextLibraryPage() {
  const { canEdit, isAdmin } = useStudioRole();
  const [searchInput, setSearchInput] = useState("");
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<Tab>("ACTIVE");
  const [categoryId, setCategoryId] = useState("");
  const [language, setLanguage] = useState("");
  const [collectionId, setCollectionId] = useState("");
  const [use, setUse] = useState("");
  const [batchId, setBatchId] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);

  // deep links: /studio/texts?collectionId=… / ?batchId=… / ?status=PENDING
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get("collectionId")) setCollectionId(p.get("collectionId")!);
    if (p.get("categoryId")) setCategoryId(p.get("categoryId")!);
    if (p.get("batchId")) setBatchId(p.get("batchId")!);
    const s = p.get("status");
    if (s === "PENDING" || s === "APPROVED" || s === "REJECTED" || s === "ARCHIVED") setTab(s);
  }, []);
  useEffect(() => {
    const t = setTimeout(() => {
      setQ(searchInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const path = `/api/text-library/texts${buildQueryString({ q: q || undefined, status: tab, categoryId: categoryId || undefined, language: language || undefined, collectionId: collectionId || undefined, batchId: batchId || undefined, used: use === "" ? undefined : use, page, pageSize: PAGE_SIZE })}`;
  const list = usePolling<Paged<TextDto>>(path, POLL_MS);
  const summary = useFetch<TextSummary>("/api/text-library/summary");
  const categories = useFetch<{ items: TextCategory[] }>("/api/text-library/categories");
  const collections = useFetch<{ items: TextCollection[] }>("/api/text-library/collections");
  const { message, setMessage, busy, run } = useAction();

  const filtered = Boolean(q || categoryId || language || collectionId || batchId || use);
  const items = list.data?.items ?? [];
  const allOnPage = items.length > 0 && items.every((t) => selected.includes(t.id));
  const refresh = () => {
    list.reload();
    summary.reload();
    categories.reload();
    collections.reload();
  };
  const reset = (fn: () => void) => {
    fn();
    setPage(1);
    setSelected([]);
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-2xl text-sm text-muted">The words your pages can say. Every text is checked by an administrator before it can be used, and Socialith never writes a text, a lyric or a fact for you.</p>
        <div className="flex flex-wrap gap-2 text-sm">
          {canEdit && <button onClick={() => setAdding((v) => !v)} className="rounded bg-accent px-3 py-2 font-medium text-background hover:opacity-90">{adding ? "Close" : "Add a text"}</button>}
          {canEdit && <Link href="/studio/texts/import" className="rounded border border-border px-3 py-2 hover:border-foreground">Import file</Link>}
          <Link href="/studio/texts/organize" className="rounded border border-border px-3 py-2 hover:border-foreground">Categories and collections</Link>
        </div>
      </div>

      {message && <Banner tone={message.tone}>{message.text}</Banner>}
      {adding && canEdit && <AddText categories={categories.data?.items.filter((c) => c.status === "ACTIVE") ?? []} onDone={(text) => { setAdding(false); setMessage({ tone: "ok", text }); refresh(); }} />}

      {summary.data && summary.data.status.PENDING > 0 && tab !== "PENDING" && isAdmin && (
        <Banner tone="info">
          {summary.data.status.PENDING} text{summary.data.status.PENDING === 1 ? " is" : "s are"} waiting for review. <button onClick={() => reset(() => setTab("PENDING"))} className="underline">Show them</button>.
        </Banner>
      )}

      <div role="tablist" aria-label="Review status" className="flex flex-wrap gap-1">
        {TABS.map((t) => (
          <button key={t.key} role="tab" aria-selected={tab === t.key} onClick={() => reset(() => setTab(t.key))} className={`rounded px-3 py-1.5 text-sm ${tab === t.key ? "bg-accent/15 text-foreground" : "text-muted hover:text-foreground"}`}>
            {t.label}
            {summary.data && <span className="ml-1.5 text-xs text-muted tabular-nums">{t.count(summary.data)}</span>}
          </button>
        ))}
      </div>

      <Card title="Search and filter">
        <div className="flex flex-wrap items-end gap-3 text-sm">
          <label className="flex flex-col gap-1">
            Search
            <input type="search" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} placeholder="words, author or source" className={`${inputClass} w-56`} />
          </label>
          <label className="flex flex-col gap-1">
            Category
            <select value={categoryId} onChange={(e) => reset(() => setCategoryId(e.target.value))} className={inputClass}>
              <option value="">Any</option>
              {categories.data?.items.filter((c) => c.status === "ACTIVE").map((c) => <option key={c.id} value={c.id}>{c.name} ({c.textCount})</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            Language
            <select value={language} onChange={(e) => reset(() => setLanguage(e.target.value))} className={inputClass}>
              <option value="">Any</option>
              {summary.data?.languages.filter((l) => l.language).map((l) => <option key={l.language} value={l.language!}>{languageLabel(l.language)} ({l.count})</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            Collection
            <select value={collectionId} onChange={(e) => reset(() => setCollectionId(e.target.value))} className={inputClass}>
              <option value="">Any</option>
              {collections.data?.items.filter((c) => c.status === "ACTIVE").map((c) => <option key={c.id} value={c.id}>{c.name} ({c.itemCount})</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            Use
            <select value={use} onChange={(e) => reset(() => setUse(e.target.value))} className={inputClass}>
              <option value="">Any</option>
              <option value="true">Used before</option>
              <option value="false">Never used</option>
            </select>
          </label>
          {filtered && <button onClick={() => reset(() => { setSearchInput(""); setQ(""); setCategoryId(""); setLanguage(""); setCollectionId(""); setUse(""); setBatchId(""); })} className="pb-2 text-xs text-muted hover:text-foreground">Clear filters</button>}
        </div>
        {batchId && <p className="mt-3 text-xs text-muted">Showing the texts of one import. <button onClick={() => reset(() => setBatchId(""))} className="underline">Show everything</button></p>}
      </Card>

      {selected.length > 0 && canEdit && (
        <BulkBar
          ids={selected}
          isAdmin={isAdmin}
          busy={busy}
          categories={categories.data?.items.filter((c) => c.status === "ACTIVE") ?? []}
          collections={collections.data?.items.filter((c) => c.status === "ACTIVE") ?? []}
          tab={tab}
          onRun={async (body, okText) => {
            const r = await run((res: { updated: number; skipped: { id: string; reason: string }[] }) => `${okText(res.updated)}${res.skipped.length ? ` ${res.skipped.length} skipped: ${[...new Set(res.skipped.map((s) => s.reason))].join(", ")}.` : ""}`, () => apiPost<{ updated: number; skipped: { id: string; reason: string }[] }>("/api/text-library/texts/bulk", { ...body, ids: selected }));
            if (r) {
              setSelected([]);
              refresh();
            }
          }}
          onClear={() => setSelected([])}
        />
      )}

      {list.error && <Banner tone="error">{list.error}</Banner>}
      {list.loading && !list.data && <p className="text-sm text-muted">Loading…</p>}
      {list.data && items.length === 0 && (
        <div className="rounded border border-dashed border-border p-8 text-center text-sm text-muted">
          {filtered ? "No texts match these filters." : tab === "PENDING" ? "Nothing is waiting for review." : <>The library has no texts here yet. {canEdit ? <>Add one, or <Link href="/studio/texts/import" className="underline">import a TXT, CSV or Excel file</Link>.</> : null}</>}
        </div>
      )}

      {items.length > 0 && (
        <div className="min-w-0 overflow-x-auto rounded border border-border">
          <table className="w-full min-w-[40rem] text-left text-sm">
            <thead className="border-b border-border text-xs text-muted">
              <tr>
                <th className="w-8 p-2">{canEdit && <input type="checkbox" aria-label="Select all on this page" checked={allOnPage} onChange={() => setSelected(allOnPage ? [] : items.map((t) => t.id))} />}</th>
                <th className="p-2 font-medium">Text</th>
                <th className="p-2 font-medium">Categories</th>
                <th className="p-2 font-medium">Language</th>
                <th className="p-2 font-medium">Status</th>
                <th className="p-2 text-right font-medium">Uses</th>
                <th className="p-2 font-medium">Added</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {items.map((t) => (
                <tr key={t.id} className={selected.includes(t.id) ? "bg-accent/5" : ""}>
                  <td className="p-2 align-top">{canEdit && <input type="checkbox" aria-label={`Select "${t.text.slice(0, 40)}"`} checked={selected.includes(t.id)} onChange={() => setSelected((s) => (s.includes(t.id) ? s.filter((x) => x !== t.id) : [...s, t.id]))} />}</td>
                  <td className="max-w-md p-2 align-top">
                    <Link href={`/studio/texts/${t.id}`} className="line-clamp-2 whitespace-pre-line hover:underline">{t.text}</Link>
                    {(t.author || t.sourceNote) && <div className="mt-0.5 truncate text-xs text-muted">{[t.author, t.sourceNote].filter(Boolean).join(" · ")}</div>}
                  </td>
                  <td className="p-2 align-top"><div className="flex flex-wrap gap-1">{t.categories.length === 0 ? <span className="text-xs text-muted">none</span> : t.categories.map((c) => <Chip key={c.id}>{c.name}</Chip>)}</div></td>
                  <td className="p-2 align-top text-xs text-muted">{languageLabel(t.language)}</td>
                  <td className="p-2 align-top"><div className="flex flex-wrap gap-1"><ApprovalChip status={t.approval.status} />{t.rights.status !== "UNVERIFIED" && <RightsChip status={t.rights.status} />}</div></td>
                  <td className="p-2 text-right align-top tabular-nums text-muted">{t.usageCount}</td>
                  <td className="whitespace-nowrap p-2 align-top text-xs text-muted">{formatDateTime(t.createdAt).split(",")[0]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.data && <Pager page={page} total={list.data.total} pageSize={PAGE_SIZE} onPage={(p) => { setPage(p); setSelected([]); }} />}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ add a text

function AddText({ categories, onDone }: { categories: TextCategory[]; onDone: (message: string) => void }) {
  const [text, setText] = useState("");
  const [language, setLanguage] = useState("");
  const [author, setAuthor] = useState("");
  const [sourceNote, setSourceNote] = useState("");
  const [categoryIds, setCategoryIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; existingId: string | null } | null>(null);
  const length = textLength(text);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await apiPost("/api/text-library/texts", { text, language: language || null, author: author || null, sourceNote: sourceNote || null, categoryIds });
      onDone("Text added. It needs an administrator's review before it can be used.");
    } catch (err) {
      const existingId = err instanceof ApiError && err.status === 409 ? ((err.details as { existingId?: string } | undefined)?.existingId ?? null) : null;
      setError({ text: err instanceof ApiError ? err.message : "Something went wrong.", existingId });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Add a text">
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3 text-sm">
        {error && (
          <Banner tone="error">
            {error.text}
            {error.existingId && <> <Link href={`/studio/texts/${error.existingId}`} className="underline">Open the existing text</Link>.</>}
          </Banner>
        )}
        <label className="flex flex-col gap-1">
          Text
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} className={`${inputClass} w-full`} placeholder="Type or paste the text exactly as it should appear." required />
          <span className={`text-xs ${length > TEXT_MAX_LENGTH ? "text-red-400" : "text-muted"}`}>{length} / {TEXT_MAX_LENGTH} characters</span>
        </label>
        <div className="grid gap-3 md:grid-cols-3">
          <label className="flex flex-col gap-1">
            Language
            <select value={language} onChange={(e) => setLanguage(e.target.value)} className={inputClass}>
              <option value="">Not set</option>
              {COMMON_LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            Author or speaker <span className="text-xs text-muted">only if you know it</span>
            <input value={author} onChange={(e) => setAuthor(e.target.value)} maxLength={255} className={inputClass} />
          </label>
          <label className="flex flex-col gap-1">
            Source
            <input value={sourceNote} onChange={(e) => setSourceNote(e.target.value)} maxLength={255} placeholder="where it comes from" className={inputClass} />
          </label>
        </div>
        <ChipPicker label="Categories (a text can have several)" options={categories} selected={categoryIds} onChange={setCategoryIds} empty="No categories yet: an administrator can add the starter set under Categories and collections." />
        <div className="flex items-center gap-3">
          <button disabled={busy || length === 0 || length > TEXT_MAX_LENGTH} className="rounded bg-accent px-3 py-2 font-medium text-background disabled:opacity-40">Add text</button>
          <span className="text-xs text-muted">It will be listed as "needs review".</span>
        </div>
      </form>
    </Card>
  );
}

// ------------------------------------------------------------------------------------------------ bulk actions

type BulkBody = Record<string, unknown> & { action: string };

function BulkBar({ ids, isAdmin, busy, categories, collections, tab, onRun, onClear }: { ids: string[]; isAdmin: boolean; busy: boolean; categories: TextCategory[]; collections: TextCollection[]; tab: Tab; onRun: (body: BulkBody, okText: (n: number) => string) => Promise<void>; onClear: () => void }) {
  const [categoryId, setCategoryId] = useState("");
  const [language, setLanguage] = useState("");
  const [collectionId, setCollectionId] = useState("");
  const [reason, setReason] = useState("");
  const btn = "rounded border border-border px-2.5 py-1.5 text-xs hover:border-foreground disabled:opacity-40";
  const n = (count: number, verb: string) => `${count} text${count === 1 ? "" : "s"} ${verb}.`;
  return (
    <div role="region" aria-label="Actions for the selected texts" className="sticky top-2 z-10 flex flex-wrap items-end gap-x-6 gap-y-3 rounded border border-accent/40 bg-surface p-3 text-sm">
      <div className="flex items-center gap-2">
        <strong>{ids.length} selected</strong>
        <button onClick={onClear} className="text-xs text-muted underline">Clear</button>
      </div>
      <div className="flex items-end gap-1.5">
        <label className="flex flex-col gap-1 text-xs text-muted">
          Category
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className={`${inputClass} py-1.5 text-sm`}>
            <option value="">Choose…</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <button disabled={busy || !categoryId} className={btn} onClick={() => void onRun({ action: "categories", mode: "add", categoryIds: [categoryId] }, (c) => n(c, "added to the category"))}>Add</button>
        <button disabled={busy || !categoryId} className={btn} onClick={() => void onRun({ action: "categories", mode: "remove", categoryIds: [categoryId] }, (c) => n(c, "removed from the category"))}>Remove</button>
      </div>
      <div className="flex items-end gap-1.5">
        <label className="flex flex-col gap-1 text-xs text-muted">
          Language
          <select value={language} onChange={(e) => setLanguage(e.target.value)} className={`${inputClass} py-1.5 text-sm`}>
            <option value="">Choose…</option>
            {COMMON_LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
          </select>
        </label>
        <button disabled={busy || !language} className={btn} onClick={() => void onRun({ action: "language", language }, (c) => n(c, "updated"))}>Set</button>
      </div>
      {isAdmin && (
        <>
          <div className="flex items-end gap-1.5">
            <label className="flex flex-col gap-1 text-xs text-muted">
              Collection
              <select value={collectionId} onChange={(e) => setCollectionId(e.target.value)} className={`${inputClass} py-1.5 text-sm`}>
                <option value="">Choose…</option>
                {collections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
            <button disabled={busy || !collectionId} className={btn} onClick={() => void onRun({ action: "collection", mode: "add", collectionId }, (c) => n(c, "added to the collection"))}>Add</button>
            <button disabled={busy || !collectionId} className={btn} onClick={() => void onRun({ action: "collection", mode: "remove", collectionId }, (c) => n(c, "removed from the collection"))}>Remove</button>
          </div>
          <div className="flex flex-wrap items-end gap-1.5">
            {tab !== "ARCHIVED" && <button disabled={busy} className={btn} onClick={() => void onRun({ action: "approve" }, (c) => n(c, "approved"))}>Approve</button>}
            {tab !== "ARCHIVED" && (
              <>
                <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason for rejecting" aria-label="Reason for rejecting" className={`${inputClass} w-44 py-1.5 text-sm`} />
                <button disabled={busy || !reason.trim()} className={btn} onClick={() => void onRun({ action: "reject", note: reason.trim() }, (c) => n(c, "rejected"))}>Reject</button>
                <button disabled={busy} className={btn} onClick={() => void onRun({ action: "archive" }, (c) => n(c, "archived"))}>Archive</button>
              </>
            )}
            {tab === "ARCHIVED" && <button disabled={busy} className={btn} onClick={() => void onRun({ action: "restore" }, (c) => n(c, "restored"))}>Restore</button>}
          </div>
        </>
      )}
    </div>
  );
}
