"use client";

import { useState } from "react";
import Link from "next/link";
import { ApiError, apiPatch, apiPost } from "@/lib/api";
import { EMPTY_DRAFT, ProfileEditor, StatusChip, draftToProfile, hintClass, labelClass, profileToDraft, useIsAdmin, type Category, type FormatDef } from "@/lib/page-network";
import { Banner, Card, inputClass, useFetch } from "@/lib/upload-post";

interface FormState {
  name: string;
  description: string;
  language: string;
  defaultEditorialStyle: string;
  draft: typeof EMPTY_DRAFT;
}

const BLANK: FormState = { name: "", description: "", language: "", defaultEditorialStyle: "", draft: EMPTY_DRAFT };

function CategoryForm({ initial, formats, submitLabel, onSubmit, onCancel }: {
  initial: FormState;
  formats: FormatDef[];
  submitLabel: string;
  onSubmit: (state: FormState) => Promise<void>;
  onCancel?: () => void;
}) {
  const [state, setState] = useState<FormState>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<FormState>) => setState({ ...state, ...patch });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit(state);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the category.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      {error && <Banner tone="error">{error}</Banner>}
      <div className="grid gap-3 md:grid-cols-3">
        <label className={labelClass}>
          Name
          <input required maxLength={120} value={state.name} onChange={(e) => set({ name: e.target.value })} className={inputClass} />
        </label>
        <label className={labelClass}>
          Language
          <input value={state.language} onChange={(e) => set({ language: e.target.value })} placeholder="organization default (e.g. tr, en)" className={inputClass} />
          <span className={hintClass}>The language of the pages' content.</span>
        </label>
        <label className={labelClass}>
          Description
          <input maxLength={2000} value={state.description} onChange={(e) => set({ description: e.target.value })} className={inputClass} />
        </label>
      </div>
      <label className={labelClass}>
        Default editorial style
        <textarea rows={2} maxLength={2000} value={state.defaultEditorialStyle} onChange={(e) => set({ defaultEditorialStyle: e.target.value })} placeholder="e.g. Short motivational messages on cinematic backgrounds with bold typography." className={inputClass} />
        <span className={hintClass}>Every page of this category inherits this and the preferences below, unless the page sets its own.</span>
      </label>
      <ProfileEditor draft={state.draft} onChange={(draft) => set({ draft })} formats={formats} />
      <div className="flex gap-2">
        <button disabled={busy || !state.name.trim()} className="rounded bg-accent px-4 py-2 text-sm font-medium text-background disabled:opacity-40">{busy ? "Saving…" : submitLabel}</button>
        {onCancel && <button type="button" onClick={onCancel} className="rounded border border-border px-4 py-2 text-sm">Cancel</button>}
      </div>
    </form>
  );
}

export default function CategoriesPage() {
  const isAdmin = useIsAdmin();
  const [showArchived, setShowArchived] = useState(false);
  const { data, error, loading, reload } = useFetch<{ items: Category[] }>(`/api/page-network/categories?status=${showArchived ? "ALL" : "ACTIVE"}`);
  const formats = useFetch<{ items: FormatDef[] }>("/api/page-network/formats");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const formatDefs = formats.data?.items ?? [];
  const body = (s: FormState) => ({
    name: s.name.trim(),
    description: s.description.trim() || null,
    ...(s.language.trim() ? { language: s.language.trim().toLowerCase() } : {}),
    defaultEditorialStyle: s.defaultEditorialStyle.trim() || null,
    contentPreferences: draftToProfile(s.draft),
  });

  async function run(label: string, fn: () => Promise<unknown>) {
    try {
      await fn();
      setMessage({ tone: "ok", text: label });
      reload();
    } catch (err) {
      setMessage({ tone: "error", text: err instanceof ApiError ? err.message : "Something went wrong." });
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {message && <Banner tone={message.tone}>{message.text}</Banner>}
      {error && <Banner tone="error">{error}</Banner>}
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <label className="flex items-center gap-2 text-muted">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived
        </label>
        {isAdmin && (
          <div className="flex gap-2">
            <button onClick={() => run("Starter categories checked.", () => apiPost("/api/page-network/categories/starters", {}))} className="rounded border border-border px-3 py-2">Add starter categories</button>
            <button onClick={() => setCreating(!creating)} className="rounded bg-accent px-3 py-2 font-medium text-background">New category</button>
          </div>
        )}
      </div>

      {creating && isAdmin && (
        <Card title="New category">
          <CategoryForm
            initial={BLANK}
            formats={formatDefs}
            submitLabel="Create category"
            onCancel={() => setCreating(false)}
            onSubmit={async (s) => {
              await apiPost("/api/page-network/categories", body(s));
              setCreating(false);
              setMessage({ tone: "ok", text: "Category created." });
              reload();
            }}
          />
        </Card>
      )}

      {loading && !data && <p className="text-sm text-muted">Loading…</p>}
      {data && data.items.length === 0 && <p className="text-sm text-muted">No categories yet. {isAdmin ? "Add the starter categories or create your own." : "An administrator can create them."}</p>}

      {data?.items.map((c) => (
        <Card
          key={c.id}
          title={c.name}
          action={
            <div className="flex items-center gap-2">
              <StatusChip status={c.status} />
              <Link href={`/page-network/pages?categoryId=${c.id}`} className="text-xs text-muted hover:text-foreground">{c.pageCount ?? 0} page{c.pageCount === 1 ? "" : "s"}</Link>
            </div>
          }
        >
          {editing === c.id ? (
            <CategoryForm
              initial={{ name: c.name, description: c.description ?? "", language: c.language, defaultEditorialStyle: c.defaultEditorialStyle ?? "", draft: profileToDraft(c.contentPreferences) }}
              formats={formatDefs}
              submitLabel="Save changes"
              onCancel={() => setEditing(null)}
              onSubmit={async (s) => {
                await apiPatch(`/api/page-network/categories/${c.id}`, body(s));
                setEditing(null);
                setMessage({ tone: "ok", text: "Category saved." });
                reload();
              }}
            />
          ) : (
            <div className="flex flex-col gap-2 text-sm">
              {c.description && <p className="text-muted">{c.description}</p>}
              <p><span className="text-muted">Language:</span> {c.language}</p>
              <p><span className="text-muted">Default editorial style:</span> {c.defaultEditorialStyle ?? <span className="text-muted">not set</span>}</p>
              {c.contentPreferences?.contentPreferences?.formats?.length ? <p><span className="text-muted">Formats:</span> {c.contentPreferences.contentPreferences.formats.join(", ")}</p> : null}
              {isAdmin && (
                <div className="mt-1 flex gap-2">
                  <button onClick={() => setEditing(c.id)} className="rounded border border-border px-3 py-1.5 text-xs">Edit</button>
                  {c.status === "ACTIVE" ? (
                    <button onClick={() => run("Category archived. Its pages keep it; new pages cannot choose it.", () => apiPost(`/api/page-network/categories/${c.id}/archive`, {}))} className="rounded border border-border px-3 py-1.5 text-xs">Archive</button>
                  ) : (
                    <button onClick={() => run("Category restored.", () => apiPost(`/api/page-network/categories/${c.id}/restore`, {}))} className="rounded border border-border px-3 py-1.5 text-xs">Restore</button>
                  )}
                </div>
              )}
            </div>
          )}
        </Card>
      ))}
    </div>
  );
}
