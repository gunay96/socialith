"use client";

import { useState } from "react";
import Link from "next/link";
import { apiPatch, apiPost } from "@/lib/api";
import { useStudioRole } from "@/lib/studio";
import { useAction, type TextCategory, type TextCollection } from "@/lib/texts";
import { Banner, Card, Chip, inputClass, useFetch } from "@/lib/upload-post";

export default function OrganizeTextsPage() {
  const { isAdmin } = useStudioRole();
  const categories = useFetch<{ items: TextCategory[] }>("/api/text-library/categories?status=ALL");
  const collections = useFetch<{ items: TextCollection[] }>("/api/text-library/collections?status=ALL");
  const { message, busy, run } = useAction();
  const [category, setCategory] = useState({ name: "", description: "" });
  const [collection, setCollection] = useState({ name: "", description: "" });
  const reload = () => {
    categories.reload();
    collections.reload();
  };
  const act = (okText: string, fn: () => Promise<unknown>) => run(okText, fn).then((r) => { if (r !== undefined) reload(); });
  const catItems = categories.data?.items ?? [];
  const colItems = collections.data?.items ?? [];
  const btn = "rounded border border-border px-2.5 py-1.5 text-xs hover:border-foreground disabled:opacity-40";

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Link href="/studio/texts" className="text-sm text-muted hover:text-foreground">← Text Library</Link>
      {message && <Banner tone={message.tone}>{message.text}</Banner>}
      {!isAdmin && <Banner tone="info">Categories and collections are managed by administrators. You can see them here and use them when you add or filter texts.</Banner>}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          title="Text categories"
          action={isAdmin && <button disabled={busy} onClick={() => void act("Starter categories added.", () => apiPost("/api/text-library/categories/starters", {}))} className={btn}>Add the starter set</button>}
        >
          <p className="mb-3 text-xs text-muted">The starter set is Motivation, Football, Humor / Memes, Relationships, Lifestyle and Artist campaigns. Add your own as well; a text can belong to several.</p>
          {catItems.length === 0 && <p className="text-sm text-muted">No categories yet.</p>}
          <ul className="divide-y divide-border">
            {catItems.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm first:pt-0 last:pb-0">
                <span className="min-w-0">
                  <Link href={`/studio/texts?categoryId=${c.id}`} className={`hover:underline ${c.status === "ARCHIVED" ? "text-muted line-through" : "font-medium"}`}>{c.name}</Link>
                  <span className="ml-2 text-xs text-muted">{c.textCount} text{c.textCount === 1 ? "" : "s"}</span>
                  {c.description && <span className="block truncate text-xs text-muted">{c.description}</span>}
                </span>
                <span className="flex items-center gap-2">
                  {c.status === "ARCHIVED" && <Chip>archived</Chip>}
                  {isAdmin && (c.status === "ACTIVE" ? <button disabled={busy} className={btn} onClick={() => void act("Category archived.", () => apiPost(`/api/text-library/categories/${c.id}/archive`, {}))}>Archive</button> : <button disabled={busy} className={btn} onClick={() => void act("Category restored.", () => apiPost(`/api/text-library/categories/${c.id}/restore`, {}))}>Restore</button>)}
                </span>
              </li>
            ))}
          </ul>
          {isAdmin && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void act("Category added.", () => apiPost("/api/text-library/categories", { name: category.name, description: category.description || null }).then(() => setCategory({ name: "", description: "" })));
              }}
              className="mt-4 flex flex-col gap-2 border-t border-border pt-3 text-sm"
            >
              <label className="flex flex-col gap-1">Name<input value={category.name} onChange={(e) => setCategory({ ...category, name: e.target.value })} maxLength={80} required className={inputClass} /></label>
              <label className="flex flex-col gap-1">Description <span className="text-xs text-muted">optional</span><input value={category.description} onChange={(e) => setCategory({ ...category, description: e.target.value })} maxLength={500} className={inputClass} /></label>
              <button disabled={busy || !category.name.trim()} className="self-start rounded border border-border px-3 py-1.5 disabled:opacity-40">Add a category</button>
            </form>
          )}
        </Card>

        <Card title="Collections">
          <p className="mb-3 text-xs text-muted">A collection is a hand-picked set of texts (for a season, a campaign or a series). Add texts to one from the Text Library: select them, then choose the collection.</p>
          {colItems.length === 0 && <p className="text-sm text-muted">No collections yet.</p>}
          <ul className="divide-y divide-border">
            {colItems.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm first:pt-0 last:pb-0">
                <span className="min-w-0">
                  <Link href={`/studio/texts?collectionId=${c.id}`} className={`hover:underline ${c.status === "ARCHIVED" ? "text-muted line-through" : "font-medium"}`}>{c.name}</Link>
                  <span className="ml-2 text-xs text-muted">{c.itemCount} text{c.itemCount === 1 ? "" : "s"}</span>
                  {c.description && <span className="block truncate text-xs text-muted">{c.description}</span>}
                </span>
                <span className="flex items-center gap-2">
                  {c.status === "ARCHIVED" && <Chip>archived</Chip>}
                  {isAdmin && (c.status === "ACTIVE" ? <button disabled={busy} className={btn} onClick={() => void act("Collection archived.", () => apiPost(`/api/text-library/collections/${c.id}/archive`, {}))}>Archive</button> : <button disabled={busy} className={btn} onClick={() => void act("Collection restored.", () => apiPost(`/api/text-library/collections/${c.id}/restore`, {}))}>Restore</button>)}
                  {isAdmin && c.status === "ACTIVE" && <button disabled={busy} className={btn} onClick={() => { const name = window.prompt("New name", c.name); if (name && name.trim() && name.trim() !== c.name) void act("Collection renamed.", () => apiPatch(`/api/text-library/collections/${c.id}`, { name: name.trim() })); }}>Rename</button>}
                </span>
              </li>
            ))}
          </ul>
          {isAdmin && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void act("Collection created.", () => apiPost("/api/text-library/collections", { name: collection.name, description: collection.description || null }).then(() => setCollection({ name: "", description: "" })));
              }}
              className="mt-4 flex flex-col gap-2 border-t border-border pt-3 text-sm"
            >
              <label className="flex flex-col gap-1">Name<input value={collection.name} onChange={(e) => setCollection({ ...collection, name: e.target.value })} maxLength={120} required className={inputClass} /></label>
              <label className="flex flex-col gap-1">Description <span className="text-xs text-muted">optional</span><input value={collection.description} onChange={(e) => setCollection({ ...collection, description: e.target.value })} maxLength={1000} className={inputClass} /></label>
              <button disabled={busy || !collection.name.trim()} className="self-start rounded border border-border px-3 py-1.5 disabled:opacity-40">Create a collection</button>
            </form>
          )}
        </Card>
      </div>
    </div>
  );
}
