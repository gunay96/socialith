"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ApiError, apiDelete, apiPatch, apiPost } from "@/lib/api";
import {
  MappingBadge,
  PLATFORMS,
  PlatformChip,
  StatusChip,
  hintClass,
  labelClass,
  useIsAdmin,
  type Category,
  type Identity,
  type Mapping,
  type PageItem,
} from "@/lib/page-network";
import { PLATFORM_LABEL } from "@/lib/publishing";
import { Banner, Card, Chip, TONES, formatDateTime, inputClass, useFetch } from "@/lib/upload-post";

interface PageDetail extends PageItem {
  editorialIdentity: string | null;
  internalNotes: string | null;
  identity: Identity;
  mapping: Mapping;
  groups: { id: string; name: string; status: string }[];
  campaigns: { id: string; name: string; status: string; via: string[] }[];
  publications: { total: number; byStatus: Record<string, number>; lastPublishedAt: string | null } | null;
}

export default function PageDetailsPage({ params }: { params: { id: string } }) {
  const isAdmin = useIsAdmin();
  const { data: page, error, loading, reload } = useFetch<PageDetail>(`/api/page-network/pages/${params.id}`);
  const categories = useFetch<{ items: Category[] }>("/api/page-network/categories");
  const groups = useFetch<{ items: { id: string; name: string }[] }>("/api/page-network/groups");
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ name: "", platform: "INSTAGRAM", username: "", profileUrl: "", categoryId: "", description: "", targetAudience: "", language: "", internalNotes: "" });
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [addGroup, setAddGroup] = useState("");

  useEffect(() => {
    if (page) {
      setForm({
        name: page.name,
        platform: page.platform ?? "INSTAGRAM",
        username: page.username ?? "",
        profileUrl: page.profileUrl ?? "",
        categoryId: page.category?.id ?? "",
        description: page.description ?? "",
        targetAudience: page.targetAudience ?? "",
        language: page.language ?? "",
        internalNotes: page.internalNotes ?? "",
      });
    }
  }, [page]);

  async function run(okText: string, fn: () => Promise<unknown>) {
    setMessage(null);
    try {
      await fn();
      setMessage({ tone: "ok", text: okText });
      setEditing(false);
      reload();
    } catch (err) {
      setMessage({ tone: "error", text: err instanceof ApiError ? err.message : "Something went wrong." });
    }
  }

  if (loading && !page) return <p className="text-sm text-muted">Loading…</p>;
  if (error || !page) return <Banner tone="error">{error ?? "Could not load the page."}</Banner>;

  const m = page.mapping;
  const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch });
  const archived = page.status === "ARCHIVED";
  const availableGroups = (groups.data?.items ?? []).filter((g) => !page.groups.some((x) => x.id === g.id));

  return (
    <div className="flex flex-col gap-4">
      <Link href="/page-network/pages" className="text-sm text-muted hover:text-foreground">← All pages</Link>
      {message && <Banner tone={message.tone}>{message.text}</Banner>}
      {archived && <Banner tone="info">This page is archived: it is read-only and no longer carries campaign or group work. Restore it to edit.</Banner>}
      {page.incomplete.length > 0 && !archived && <Banner tone="warn">Incomplete page profile - missing: {page.incomplete.join(", ")}.</Banner>}

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">{page.name}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted">
            {page.username ? `@${page.username}` : "no username"}
            <PlatformChip platform={page.platform} />
            <StatusChip status={page.status} />
            {page.category && <Chip>{page.category.name}</Chip>}
            {page.profileUrl && <a href={page.profileUrl} target="_blank" rel="noreferrer noopener" className="underline">profile ↗</a>}
          </div>
        </div>
        <div className="flex gap-2">
          <Link href={`/page-network/pages/${page.id}/identity`} className="rounded border border-border px-3 py-2 text-sm hover:border-foreground">Editorial identity</Link>
          {isAdmin && (archived ? (
            <button onClick={() => run("Page restored.", () => apiPost(`/api/page-network/pages/${page.id}/restore`, {}))} className="rounded border border-border px-3 py-2 text-sm">Restore</button>
          ) : (
            <button onClick={() => run("Page archived.", () => apiPost(`/api/page-network/pages/${page.id}/archive`, {}))} className="rounded border border-border px-3 py-2 text-sm">Archive</button>
          ))}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Page profile" action={isAdmin && !archived && !editing ? <button onClick={() => setEditing(true)} className="text-xs text-muted hover:text-foreground">Edit</button> : undefined}>
          {editing ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void run("Page saved.", () =>
                  apiPatch(`/api/page-network/pages/${page.id}`, {
                    name: form.name.trim(),
                    platform: form.platform,
                    username: form.username.trim(),
                    profileUrl: form.profileUrl.trim() || null,
                    categoryId: form.categoryId || null,
                    description: form.description.trim() || null,
                    targetAudience: form.targetAudience.trim() || null,
                    language: form.language.trim().toLowerCase() || null,
                    internalNotes: form.internalNotes.trim() || null,
                  }),
                );
              }}
              className="flex flex-col gap-3"
            >
              <label className={labelClass}>Page name<input required value={form.name} onChange={(e) => set({ name: e.target.value })} className={inputClass} /></label>
              <div className="grid grid-cols-2 gap-3">
                <label className={labelClass}>
                  Platform
                  <select value={form.platform} disabled={Boolean(m.linked)} onChange={(e) => set({ platform: e.target.value })} className={inputClass}>
                    {PLATFORMS.map((p) => <option key={p} value={p}>{PLATFORM_LABEL[p]}</option>)}
                  </select>
                  {m.linked && <span className={hintClass}>Unlink the account to change it.</span>}
                </label>
                <label className={labelClass}>Username<input required value={form.username} onChange={(e) => set({ username: e.target.value })} className={inputClass} /></label>
              </div>
              <label className={labelClass}>Profile URL<input type="url" value={form.profileUrl} onChange={(e) => set({ profileUrl: e.target.value })} className={inputClass} /></label>
              <label className={labelClass}>
                Category
                <select value={form.categoryId} onChange={(e) => set({ categoryId: e.target.value })} className={inputClass}>
                  <option value="">No category</option>
                  {categories.data?.items.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  {page.category && !categories.data?.items.some((c) => c.id === page.category?.id) && <option value={page.category.id}>{page.category.name} (archived)</option>}
                </select>
              </label>
              <label className={labelClass}>Content language<input value={form.language} onChange={(e) => set({ language: e.target.value })} placeholder="follow the category" className={inputClass} /></label>
              <label className={labelClass}>Description<textarea rows={2} value={form.description} onChange={(e) => set({ description: e.target.value })} className={inputClass} /></label>
              <label className={labelClass}>Target audience<input value={form.targetAudience} onChange={(e) => set({ targetAudience: e.target.value })} className={inputClass} /></label>
              <label className={labelClass}>Internal notes<textarea rows={2} value={form.internalNotes} onChange={(e) => set({ internalNotes: e.target.value })} className={inputClass} /></label>
              <div className="flex gap-2">
                <button className="rounded bg-accent px-4 py-2 text-sm font-medium text-background">Save</button>
                <button type="button" onClick={() => setEditing(false)} className="rounded border border-border px-4 py-2 text-sm">Cancel</button>
              </div>
            </form>
          ) : (
            <dl className="grid grid-cols-[9rem_1fr] gap-x-3 gap-y-2 text-sm">
              <dt className="text-muted">Description</dt><dd>{page.description ?? <span className="text-muted">—</span>}</dd>
              <dt className="text-muted">Target audience</dt><dd>{page.targetAudience ?? <span className="text-muted">—</span>}</dd>
              <dt className="text-muted">Content language</dt><dd>{page.effectiveLanguage ?? "—"}{!page.language && page.effectiveLanguage ? <span className="text-xs text-muted"> (from the category)</span> : null}</dd>
              <dt className="text-muted">Editorial identity</dt><dd>{page.identity.editorialStyle ?? <span className="text-muted">not set</span>}<span className="ml-1 text-xs text-muted">{page.editorialIdentity ? "(own)" : page.identity.editorialStyle ? "(from the category)" : ""}</span></dd>
              <dt className="text-muted">Internal notes</dt><dd className="whitespace-pre-wrap">{page.internalNotes ?? <span className="text-muted">—{!isAdmin && " (editors and above)"}</span>}</dd>
            </dl>
          )}
        </Card>

        <Card title="Publishing account" action={<Link href="/page-network/mapping" className="text-xs text-muted hover:text-foreground">Account mapping</Link>}>
          <div className="flex flex-col gap-3 text-sm">
            <div className="flex items-center gap-2"><MappingBadge state={m.state} label={m.stateLabel} />{m.publishing.canPublish ? <Chip tone={TONES.GREEN}>can publish</Chip> : <Chip>cannot publish</Chip>}</div>
            {!m.linked ? (
              <p className="text-muted">No publishing destination is linked, so nothing can be published for this page. <Link href="/page-network/mapping" className="underline">Link an account</Link>.</p>
            ) : (
              <dl className="grid grid-cols-[9rem_1fr] gap-x-3 gap-y-2">
                <dt className="text-muted">Provider</dt><dd>{m.destination?.provider === "UPLOAD_POST" ? "Upload-Post" : "Native"}</dd>
                <dt className="text-muted">Platform</dt><dd>{m.destination ? (PLATFORM_LABEL[m.destination.platform] ?? m.destination.platform) : "—"}</dd>
                <dt className="text-muted">Account</dt><dd>@{m.destination?.handle}{m.usernameMatchesDestination === false && <span className="text-xs text-amber-400"> (differs from the page username)</span>}</dd>
                <dt className="text-muted">Authorization</dt><dd>{m.destination?.status.toLowerCase()}{m.upload ? ` · provider: ${m.upload.accountStatus.toLowerCase().replace(/_/g, " ")}` : ""}</dd>
                <dt className="text-muted">Upload-Post profile</dt><dd>{m.upload ? (m.upload.profile?.username ?? <span className="text-muted">hidden for your role</span>) : <span className="text-muted">—</span>}</dd>
                <dt className="text-muted">Capabilities</dt><dd className="flex flex-wrap gap-1">{m.publishing.capabilities.length ? m.publishing.capabilities.map((c) => <Chip key={c}>{c}</Chip>) : <span className="text-muted">none reported</span>}</dd>
                <dt className="text-muted">Last synchronized</dt><dd>{formatDateTime(m.lastSyncedAt)}</dd>
              </dl>
            )}
            {m.issues.length > 0 && (
              <ul className="list-disc pl-5 text-xs text-amber-400">{m.issues.map((i) => <li key={i.code}>{i.message}</li>)}</ul>
            )}
            {m.profileMappedToOtherPage && (
              <p className="text-xs text-muted">Note: this account&apos;s Upload-Post profile is mapped to the page <Link href={`/page-network/pages/${m.profileMappedToOtherPage.id}`} className="underline">{m.profileMappedToOtherPage.name}</Link> (Phase 2 mapping, left unchanged).</p>
            )}
          </div>
        </Card>

        <Card title="Groups">
          {page.groups.length === 0 ? <p className="text-sm text-muted">Not in any group.</p> : (
            <ul className="flex flex-col divide-y divide-border">
              {page.groups.map((g) => (
                <li key={g.id} className="flex items-center justify-between py-2 text-sm first:pt-0 last:pb-0">
                  <Link href={`/page-network/groups/${g.id}`} className="hover:underline">{g.name}{g.status === "ARCHIVED" && <span className="text-xs text-muted"> (archived)</span>}</Link>
                  {isAdmin && !archived && <button onClick={() => run("Removed from the group.", () => apiDelete(`/api/page-network/groups/${g.id}/members/${page.id}`))} className="text-xs text-muted hover:text-foreground">Remove</button>}
                </li>
              ))}
            </ul>
          )}
          {isAdmin && !archived && availableGroups.length > 0 && (
            <div className="mt-3 flex gap-2 text-sm">
              <select value={addGroup} onChange={(e) => setAddGroup(e.target.value)} className={`${inputClass} flex-1`}>
                <option value="">Add to a group…</option>
                {availableGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
              <button disabled={!addGroup} onClick={() => { const gid = addGroup; setAddGroup(""); void run("Added to the group.", () => apiPost(`/api/page-network/groups/${gid}/members`, { pageIds: [page.id] })); }} className="rounded border border-border px-3 py-2 disabled:opacity-40">Add</button>
            </div>
          )}
          <p className="mt-3 text-xs text-muted">A page may belong to several groups.</p>
        </Card>

        <Card title="Campaigns and publications">
          {page.campaigns.length === 0 ? <p className="text-sm text-muted">Not assigned to any campaign.</p> : (
            <ul className="flex flex-col divide-y divide-border">
              {page.campaigns.map((c) => (
                <li key={c.id} className="py-2 text-sm first:pt-0 last:pb-0">
                  <Link href={`/campaigns/${c.id}`} className="hover:underline">{c.name}</Link>
                  <span className="text-xs text-muted"> · {c.status.toLowerCase()} · {c.via.join(", ")}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3 border-t border-border pt-3 text-sm">
            {page.publications ? (
              <>
                <div className="flex flex-wrap gap-2">
                  {Object.entries(page.publications.byStatus).map(([s, n]) => <Chip key={s}>{s.toLowerCase()} {n}</Chip>)}
                </div>
                <p className="mt-2 text-xs text-muted">Last published: {formatDateTime(page.publications.lastPublishedAt)} · <Link href={`/publishing/publications?managedPageId=${page.id}`} className="underline">open in Publishing Center</Link></p>
              </>
            ) : <p className="text-xs text-muted">No publications: the page has no publishing destination.</p>}
          </div>
        </Card>
      </div>

      <Card title="Effective editorial identity" action={<Link href={`/page-network/pages/${page.id}/identity`} className="text-xs text-muted hover:text-foreground">Edit identity</Link>}>
        <dl className="grid grid-cols-[10rem_1fr] gap-x-3 gap-y-2 text-sm">
          <dt className="text-muted">Style</dt><dd>{page.identity.editorialStyle ?? <span className="text-muted">not set</span>}</dd>
          <dt className="text-muted">Formats</dt><dd>{page.identity.contentPreferences.formats.length ? page.identity.contentPreferences.formats.join(", ") : <span className="text-muted">—</span>}</dd>
          <dt className="text-muted">Aspect ratio</dt><dd>{page.identity.visual.aspectRatio ?? <span className="text-muted">—</span>}</dd>
          <dt className="text-muted">Rules</dt><dd>{page.identity.ruleEnforcement === "BLOCK" ? "block when broken" : "warn when broken"}</dd>
        </dl>
      </Card>
    </div>
  );
}
