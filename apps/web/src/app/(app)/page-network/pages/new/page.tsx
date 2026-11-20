"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ApiError, apiPost } from "@/lib/api";
import { PLATFORMS, hintClass, labelClass, useIsAdmin, type Category, type PageItem } from "@/lib/page-network";
import { PLATFORM_LABEL } from "@/lib/publishing";
import { Banner, Card, inputClass, useFetch } from "@/lib/upload-post";

interface UnlinkedDestination {
  id: string;
  platform: string;
  handle: string;
  displayName: string;
  status: string;
  provider: string;
}

export default function NewPagePage() {
  const router = useRouter();
  const isAdmin = useIsAdmin();
  const categories = useFetch<{ items: Category[] }>("/api/page-network/categories");
  const mapping = useFetch<{ unlinkedDestinations: UnlinkedDestination[] }>("/api/page-network/mapping");
  const [form, setForm] = useState({
    name: "",
    platform: "INSTAGRAM",
    username: "",
    profileUrl: "",
    categoryId: "",
    description: "",
    targetAudience: "",
    language: "",
    editorialIdentity: "",
    internalNotes: "",
    socialAccountId: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch });
  const destinations = (mapping.data?.unlinkedDestinations ?? []).filter((d) => d.platform === form.platform);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await apiPost<PageItem>("/api/page-network/pages", {
        name: form.name.trim(),
        platform: form.platform,
        username: form.username.trim(),
        profileUrl: form.profileUrl.trim() || null,
        categoryId: form.categoryId || null,
        description: form.description.trim() || null,
        targetAudience: form.targetAudience.trim() || null,
        language: form.language.trim().toLowerCase() || null,
        editorialIdentity: form.editorialIdentity.trim() || null,
        internalNotes: form.internalNotes.trim() || null,
        socialAccountId: form.socialAccountId || null,
      });
      router.push(`/page-network/pages/${created.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create the page.");
      setBusy(false);
    }
  }

  if (!isAdmin) return <Banner tone="info">Only administrators can create pages.</Banner>;

  return (
    <form onSubmit={submit} className="flex max-w-3xl flex-col gap-4">
      <Link href="/page-network/pages" className="text-sm text-muted hover:text-foreground">← All pages</Link>
      {error && <Banner tone="error">{error}</Banner>}
      <Card title="Page profile">
        <div className="grid gap-4 md:grid-cols-2">
          <label className={labelClass}>
            Page name
            <input required maxLength={120} value={form.name} onChange={(e) => set({ name: e.target.value })} className={inputClass} placeholder="Motivation Page 01" />
          </label>
          <label className={labelClass}>
            Platform
            <select value={form.platform} onChange={(e) => set({ platform: e.target.value, socialAccountId: "" })} className={inputClass}>
              {PLATFORMS.map((p) => <option key={p} value={p}>{PLATFORM_LABEL[p]}</option>)}
            </select>
          </label>
          <label className={labelClass}>
            Username
            <input required maxLength={100} value={form.username} onChange={(e) => set({ username: e.target.value })} className={inputClass} placeholder="@motivation_01" />
            <span className={hintClass}>The page&apos;s public handle. One page record per handle and platform.</span>
          </label>
          <label className={labelClass}>
            Profile URL
            <input type="url" value={form.profileUrl} onChange={(e) => set({ profileUrl: e.target.value })} className={inputClass} placeholder="https://…" />
          </label>
          <label className={labelClass}>
            Category
            <select value={form.categoryId} onChange={(e) => set({ categoryId: e.target.value })} className={inputClass}>
              <option value="">No category yet</option>
              {categories.data?.items.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            {categories.data?.items.length === 0 && <span className={hintClass}>No categories yet - <Link href="/page-network/categories" className="underline">create or add some</Link>.</span>}
          </label>
          <label className={labelClass}>
            Content language
            <input value={form.language} onChange={(e) => set({ language: e.target.value })} className={inputClass} placeholder="follow the category (e.g. tr, en)" />
          </label>
          <label className={`${labelClass} md:col-span-2`}>
            Description
            <textarea rows={2} maxLength={2000} value={form.description} onChange={(e) => set({ description: e.target.value })} className={inputClass} />
          </label>
          <label className={`${labelClass} md:col-span-2`}>
            Target audience
            <input maxLength={1000} value={form.targetAudience} onChange={(e) => set({ targetAudience: e.target.value })} className={inputClass} />
          </label>
          <label className={`${labelClass} md:col-span-2`}>
            Editorial identity
            <textarea rows={2} maxLength={2000} value={form.editorialIdentity} onChange={(e) => set({ editorialIdentity: e.target.value })} className={inputClass} placeholder="Leave empty to inherit the category's default editorial style" />
            <span className={hintClass}>Fonts, colors, text position and the other preferences are set on the page&apos;s Editorial Identity screen after it is created.</span>
          </label>
          <label className={`${labelClass} md:col-span-2`}>
            Internal notes
            <textarea rows={2} maxLength={4000} value={form.internalNotes} onChange={(e) => set({ internalNotes: e.target.value })} className={inputClass} />
            <span className={hintClass}>Visible to editors and above only.</span>
          </label>
        </div>
      </Card>

      <Card title="Publishing account (optional)">
        <label className={labelClass}>
          Connected publishing destination
          <select value={form.socialAccountId} onChange={(e) => set({ socialAccountId: e.target.value })} className={inputClass}>
            <option value="">Link later</option>
            {destinations.map((d) => <option key={d.id} value={d.id}>@{d.handle} · {d.status.toLowerCase()}</option>)}
          </select>
          <span className={hintClass}>
            Only real destinations that no page uses yet are offered. Accounts are connected and enabled in Upload-Post; nothing is created here.
            {destinations.length === 0 && mapping.data ? ` There is no free ${PLATFORM_LABEL[form.platform] ?? form.platform} destination right now.` : ""}
          </span>
        </label>
      </Card>

      <div>
        <button disabled={busy || !form.name.trim() || !form.username.trim()} className="rounded bg-accent px-4 py-2 text-sm font-medium text-background disabled:opacity-40">{busy ? "Creating…" : "Create page"}</button>
      </div>
    </form>
  );
}
