"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { buildQueryString, apiPost } from "@/lib/api";
import { MATCH_LABEL, type PresetDto, type RecipeDto } from "@/lib/recipes";
import { useStudioRole } from "@/lib/studio";
import { useAction, useNetworkOptions } from "@/lib/texts";
import { Banner, Card, Chip, inputClass, useFetch } from "@/lib/upload-post";

export default function RecipesPage() {
  const router = useRouter();
  const { isAdmin } = useStudioRole();
  const [status, setStatus] = useState<"ACTIVE" | "ARCHIVED">("ACTIVE");
  const [q, setQ] = useState("");
  const [forPageId, setForPageId] = useState("");
  const [forMedia, setForMedia] = useState("");
  const [newName, setNewName] = useState("");
  const network = useNetworkOptions();
  const recipes = useFetch<{ items: RecipeDto[]; total: number }>(`/api/recipes${buildQueryString({ status, q: q.trim() || undefined, forPageId: forPageId || undefined, forMedia: forPageId && forMedia ? forMedia : undefined, mediaKind: !forPageId && forMedia ? forMedia : undefined })}`);
  const presets = useFetch<{ items: PresetDto[] }>("/api/recipes/presets");
  const { message, busy, run } = useAction();
  const act = (okText: string, fn: () => Promise<unknown>) => run(okText, fn).then((r) => { if (r !== undefined) { recipes.reload(); presets.reload(); } return r; });

  const items = recipes.data?.items ?? [];
  const notInstalled = presets.data?.items.filter((p) => p.recipes.length === 0) ?? [];
  const btn = "rounded border border-border px-2.5 py-1.5 text-xs hover:border-foreground disabled:opacity-40";

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <p className="max-w-3xl text-sm text-muted">
        A recipe says how a picture or video and an approved text are put together: where the text sits, how it looks and moves, and what is exported. Settings a recipe leaves empty come from the page, its group or its category. Here you define and preview the composition; making the final file is a later step.
      </p>
      {message && <Banner tone={message.tone}>{message.text}</Banner>}

      {isAdmin && notInstalled.length > 0 && (
        <Card
          title="Start from a preset"
          action={notInstalled.length > 1 && <button disabled={busy} onClick={() => void act("Preset recipes added.", () => apiPost("/api/recipes/presets/install", {}))} className={btn}>Add all {notInstalled.length}</button>}
        >
          <ul className="grid gap-3 md:grid-cols-2">
            {notInstalled.map((p) => (
              <li key={p.key} className="flex flex-col justify-between gap-3 rounded border border-border p-3">
                <div>
                  <div className="text-sm font-medium">{p.name}</div>
                  <p className="mt-1 text-xs text-muted">{p.description}</p>
                </div>
                <div className="flex items-center gap-2 text-xs text-muted">
                  <span>{p.config.compatibleMedia.map((m) => m.toLowerCase()).join(" + ")}</span>
                  {p.config.aspectRatio && <span>· {p.config.aspectRatio}</span>}
                  <button
                    disabled={busy}
                    className={`${btn} ml-auto`}
                    onClick={() => void act("Recipe created.", () => apiPost<RecipeDto>("/api/recipes/from-preset", { presetKey: p.key }).then((r) => router.push(`/studio/recipes/${r.id}`)))}
                  >
                    Create recipe
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title="Recipes">
        <div className="mb-4 flex flex-wrap items-end gap-3 text-sm">
          <label className="flex flex-col gap-1">
            Search
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="name or description" className={`${inputClass} w-52`} />
          </label>
          <label className="flex flex-col gap-1">
            Suits page
            <select value={forPageId} onChange={(e) => setForPageId(e.target.value)} className={inputClass}>
              <option value="">Any page</option>
              {network.pages.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            Works with
            <select value={forMedia} onChange={(e) => setForMedia(e.target.value)} className={inputClass}>
              <option value="">Images and videos</option>
              <option value="IMAGE">Images</option>
              <option value="VIDEO">Videos</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            Show
            <select value={status} onChange={(e) => setStatus(e.target.value as "ACTIVE" | "ARCHIVED")} className={inputClass}>
              <option value="ACTIVE">Active</option>
              <option value="ARCHIVED">Archived</option>
            </select>
          </label>
          {isAdmin && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void act("Recipe created.", () => apiPost<RecipeDto>("/api/recipes", { name: newName.trim(), config: {} }).then((r) => router.push(`/studio/recipes/${r.id}`)));
              }}
              className="ml-auto flex items-end gap-2"
            >
              <label className="flex flex-col gap-1">
                New blank recipe
                <input value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={120} placeholder="name" className={`${inputClass} w-48`} />
              </label>
              <button disabled={busy || !newName.trim()} className="rounded bg-accent px-3 py-2 font-medium text-background disabled:opacity-40">Create</button>
            </form>
          )}
        </div>

        {recipes.error && <Banner tone="error">{recipes.error}</Banner>}
        {recipes.loading && !recipes.data && <p className="text-sm text-muted">Loading…</p>}
        {recipes.data && items.length === 0 && (
          <p className="rounded border border-dashed border-border p-6 text-center text-sm text-muted">
            {status === "ARCHIVED" ? "No archived recipes." : forPageId ? "No recipe suits this page yet. Assign a recipe to its category, group or the page itself." : isAdmin ? "No recipes yet. Start from a preset above, or create a blank recipe." : "No recipes yet. An administrator creates them."}
          </p>
        )}
        {items.length > 0 && (
          <div className="min-w-0 overflow-x-auto">
            <table className="w-full min-w-[44rem] text-left text-sm">
              <thead className="border-b border-border text-xs text-muted">
                <tr>
                  <th className="p-2 font-medium">Recipe</th>
                  <th className="p-2 font-medium">Media</th>
                  <th className="p-2 font-medium">Shape</th>
                  <th className="p-2 font-medium">Used for</th>
                  <th className="p-2 font-medium" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {items.map((r) => (
                  <tr key={r.id}>
                    <td className="max-w-xs p-2 align-top">
                      <Link href={`/studio/recipes/${r.id}`} className="font-medium hover:underline">{r.name}</Link>
                      <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                        {r.format && <span>{r.format.label}</span>}
                        {r.presetKey && <Chip>preset</Chip>}
                        {r.matchedBy && <Chip>{MATCH_LABEL[r.matchedBy]}</Chip>}
                        {r.duplicatedFrom && <span>copy of {r.duplicatedFrom.name}</span>}
                      </div>
                    </td>
                    <td className="p-2 align-top text-xs text-muted">{r.config.compatibleMedia.map((m) => (m === "IMAGE" ? "images" : "videos")).join(" + ")}</td>
                    <td className="p-2 align-top text-xs text-muted">{r.config.aspectRatio ?? "from the page"}</td>
                    <td className="max-w-xs p-2 align-top text-xs">
                      {r.assignments.appliesToAllPages ? <span className="text-muted">every page</span> : (
                        <div className="flex flex-wrap gap-1">
                          {[...r.assignments.pageCategories, ...r.assignments.pageGroups, ...r.assignments.pages].slice(0, 5).map((x) => <Chip key={x.id}>{x.name}</Chip>)}
                          {r.assignments.pageCategories.length + r.assignments.pageGroups.length + r.assignments.pages.length > 5 && <span className="text-muted">…</span>}
                        </div>
                      )}
                      {r.requiredTextCategory && <div className="mt-1 text-muted">texts: {r.requiredTextCategory.name}</div>}
                    </td>
                    <td className="whitespace-nowrap p-2 text-right align-top">
                      <Link href={`/studio/recipes/${r.id}`} className={btn}>{isAdmin ? "Open" : "Preview"}</Link>
                      {isAdmin && <button disabled={busy} className={`${btn} ml-1.5`} onClick={() => void act("Recipe duplicated.", () => apiPost<RecipeDto>(`/api/recipes/${r.id}/duplicate`, {}).then((c) => router.push(`/studio/recipes/${c.id}`)))}>Duplicate</button>}
                      {isAdmin && (r.status === "ACTIVE" ? <button disabled={busy} className={`${btn} ml-1.5`} onClick={() => void act("Recipe archived.", () => apiPost(`/api/recipes/${r.id}/archive`, {}))}>Archive</button> : <button disabled={busy} className={`${btn} ml-1.5`} onClick={() => void act("Recipe restored.", () => apiPost(`/api/recipes/${r.id}/restore`, {}))}>Restore</button>)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
