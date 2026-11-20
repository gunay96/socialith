"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ApiError, apiDelete, apiPatch, apiPost } from "@/lib/api";
import {
  EMPTY_DRAFT,
  MappingBadge,
  PlatformChip,
  ProfileEditor,
  StatusChip,
  draftToProfile,
  labelClass,
  profileToDraft,
  useIsAdmin,
  type EditorialProfile,
  type FormatDef,
  type PageItem,
  type Paged,
  type Status,
} from "@/lib/page-network";
import { PLATFORM_LABEL } from "@/lib/publishing";
import { Banner, Card, Chip, Stat, inputClass, useFetch } from "@/lib/upload-post";

interface GroupDetail {
  id: string;
  name: string;
  description: string | null;
  status: Status;
  contentPreferences: EditorialProfile | null;
  members: (PageItem & { addedAt: string })[];
  stats: {
    pages: { total: number; active: number; archived: number };
    byPlatform: Record<string, number>;
    byCategory: { name: string; count: number }[];
    mapping: { ready: number; problem: number; unlinked: number };
    publications: { byStatus: Record<string, number>; publishedLast30Days: number };
  };
  campaigns: { id: string; name: string; status: string }[];
}

export default function GroupDetailPage({ params }: { params: { id: string } }) {
  const isAdmin = useIsAdmin();
  const { data: group, error, loading, reload } = useFetch<GroupDetail>(`/api/page-network/groups/${params.id}`);
  const allPages = useFetch<Paged<PageItem>>("/api/page-network/pages?pageSize=100");
  const formats = useFetch<{ items: FormatDef[] }>("/api/page-network/formats");
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [addPage, setAddPage] = useState("");
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  useEffect(() => {
    if (group) {
      setName(group.name);
      setDescription(group.description ?? "");
      setDraft(profileToDraft(group.contentPreferences));
    }
  }, [group]);

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

  if (loading && !group) return <p className="text-sm text-muted">Loading…</p>;
  if (error || !group) return <Banner tone="error">{error ?? "Could not load the group."}</Banner>;
  const archived = group.status === "ARCHIVED";
  const candidates = (allPages.data?.items ?? []).filter((p) => !group.members.some((m) => m.id === p.id));
  const s = group.stats;

  return (
    <div className="flex flex-col gap-4">
      <Link href="/page-network/groups" className="text-sm text-muted hover:text-foreground">← All groups</Link>
      {message && <Banner tone={message.tone}>{message.text}</Banner>}
      {archived && <Banner tone="info">This group is archived: it no longer carries pages into campaigns and its pages cannot be changed. Restore it to edit.</Banner>}

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">{group.name}</h2>
          <div className="mt-1 flex items-center gap-2 text-sm text-muted"><StatusChip status={group.status} />{group.description}</div>
        </div>
        {isAdmin && (
          <div className="flex gap-2">
            {!archived && !editing && <button onClick={() => setEditing(true)} className="rounded border border-border px-3 py-2 text-sm">Edit</button>}
            {archived ? (
              <button onClick={() => run("Group restored.", () => apiPost(`/api/page-network/groups/${group.id}/restore`, {}))} className="rounded border border-border px-3 py-2 text-sm">Restore</button>
            ) : (
              <button onClick={() => run("Group archived.", () => apiPost(`/api/page-network/groups/${group.id}/archive`, {}))} className="rounded border border-border px-3 py-2 text-sm">Archive</button>
            )}
          </div>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <Card title="Pages"><Stat label="active pages" value={s.pages.active} hint={s.pages.archived ? `${s.pages.archived} archived` : undefined} /></Card>
        <Card title="Accounts"><Stat label="ready to publish" value={s.mapping.ready} hint={`${s.mapping.problem} with a problem · ${s.mapping.unlinked} without account`} /></Card>
        <Card title="Published"><Stat label="last 30 days" value={s.publications.publishedLast30Days} hint={`${s.publications.byStatus.SCHEDULED ?? 0} scheduled · ${s.publications.byStatus.FAILED ?? 0} failed`} /></Card>
        <Card title="Mix">
          <div className="flex flex-wrap gap-1.5 text-xs">
            {Object.entries(s.byPlatform).map(([p, n]) => <Chip key={p}>{PLATFORM_LABEL[p] ?? "no platform"} {n}</Chip>)}
            {s.byCategory.map((c) => <Chip key={c.name}>{c.name} {c.count}</Chip>)}
          </div>
        </Card>
      </div>

      {editing && (
        <Card title="Edit group">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run("Group saved.", () => apiPatch(`/api/page-network/groups/${group.id}`, { name: name.trim(), description: description.trim() || null, contentPreferences: draftToProfile(draft) }));
            }}
            className="flex flex-col gap-4"
          >
            <div className="grid gap-3 md:grid-cols-2">
              <label className={labelClass}>Name<input required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} className={inputClass} /></label>
              <label className={labelClass}>Description<input maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} className={inputClass} /></label>
            </div>
            <div>
              <h3 className="mb-2 text-sm font-semibold">Group-level content preferences</h3>
              <p className="mb-3 text-xs text-muted">They apply between the category and the page (page overrides group, group overrides category) when a group is chosen, for example in the identity preview. A page&apos;s own settings always win.</p>
              <ProfileEditor draft={draft} onChange={setDraft} formats={formats.data?.items ?? []} />
            </div>
            <div className="flex gap-2">
              <button className="rounded bg-accent px-4 py-2 text-sm font-medium text-background">Save</button>
              <button type="button" onClick={() => setEditing(false)} className="rounded border border-border px-4 py-2 text-sm">Cancel</button>
            </div>
          </form>
        </Card>
      )}

      <Card title={`Pages in this group (${group.members.length})`}>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <tbody>
              {group.members.length === 0 && <tr><td className="py-2 text-muted">No pages yet.</td></tr>}
              {group.members.map((m) => (
                <tr key={m.id} className="border-b border-border last:border-0">
                  <td className="py-2 pr-3"><Link href={`/page-network/pages/${m.id}`} className="font-medium hover:underline">{m.name}</Link><div className="text-xs text-muted">{m.username ? `@${m.username}` : "no username"}</div></td>
                  <td className="py-2 pr-3"><PlatformChip platform={m.platform} /></td>
                  <td className="py-2 pr-3 text-muted">{m.category?.name ?? "—"}</td>
                  <td className="py-2 pr-3"><MappingBadge state={m.mapping.state} label={m.mapping.stateLabel} /></td>
                  <td className="py-2 text-right">
                    {m.status === "ARCHIVED" && <span className="mr-2 text-xs text-muted">archived</span>}
                    {isAdmin && !archived && <button onClick={() => run("Page removed from the group.", () => apiDelete(`/api/page-network/groups/${group.id}/members/${m.id}`))} className="text-xs text-muted hover:text-foreground">Remove</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {isAdmin && !archived && (
          <div className="mt-3 flex gap-2 text-sm">
            <select value={addPage} onChange={(e) => setAddPage(e.target.value)} className={`${inputClass} flex-1`}>
              <option value="">Add a page…</option>
              {candidates.map((p) => <option key={p.id} value={p.id}>{p.name}{p.platform ? ` · ${PLATFORM_LABEL[p.platform] ?? p.platform}` : ""}</option>)}
            </select>
            <button disabled={!addPage} onClick={() => { const id = addPage; setAddPage(""); void run("Page added.", () => apiPost(`/api/page-network/groups/${group.id}/members`, { pageIds: [id] })); }} className="rounded border border-border px-3 py-2 disabled:opacity-40">Add</button>
          </div>
        )}
      </Card>

      <Card title="Campaigns">
        {group.campaigns.length === 0 ? <p className="text-sm text-muted">Not assigned to any campaign.</p> : (
          <ul className="flex flex-col divide-y divide-border">
            {group.campaigns.map((c) => <li key={c.id} className="py-2 text-sm first:pt-0 last:pb-0"><Link href={`/campaigns/${c.id}`} className="hover:underline">{c.name}</Link> <span className="text-xs text-muted">· {c.status.toLowerCase()}</span></li>)}
          </ul>
        )}
      </Card>
    </div>
  );
}
