"use client";

import { useState } from "react";
import { apiPatch, apiPost, buildQueryString, ApiError } from "@/lib/api";
import { useCurrentUser } from "@/lib/auth-context";
import { Banner, Card, Chip, StatusBadge, TONES, inputClass, useFetch, type CreatorRow, type ManagedPageRow, type Paged, type UploadPostAccountRow, type UploadPostProfileRow } from "@/lib/upload-post";

export default function MappingPage() {
  const me = useCurrentUser();
  const canEdit = me.role === "ADMIN" || me.role === "OWNER";
  const pages = useFetch<ManagedPageRow[]>("/api/managed-pages");
  const creators = useFetch<CreatorRow[]>("/api/creators");
  const profiles = useFetch<Paged<UploadPostProfileRow>>(`/api/upload-post/profiles${buildQueryString({ status: "ACTIVE", pageSize: 100 })}`);
  const accounts = useFetch<Paged<UploadPostAccountRow>>(`/api/upload-post/accounts${buildQueryString({ pageSize: 100 })}`);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [newPage, setNewPage] = useState("");
  const [newCreator, setNewCreator] = useState("");

  const fail = (err: unknown, fallback: string) => setNotice({ tone: "error", text: err instanceof ApiError ? err.message : fallback });

  async function mapProfile(profileId: string, managedPageId: string) {
    try {
      await apiPatch(`/api/upload-post/profiles/${profileId}/mapping`, { managedPageId: managedPageId || null });
      setNotice({ tone: "ok", text: "Profile mapping updated." });
      profiles.reload();
      pages.reload();
    } catch (err) {
      fail(err, "Could not update the mapping.");
    }
  }
  async function mapAccount(accountId: string, creatorId: string) {
    try {
      await apiPatch(`/api/upload-post/accounts/${accountId}/mapping`, { creatorId: creatorId || null });
      setNotice({ tone: "ok", text: "Account mapping updated." });
      accounts.reload();
      creators.reload();
    } catch (err) {
      fail(err, "Could not update the mapping.");
    }
  }
  async function createPage() {
    if (!newPage.trim()) return;
    try {
      await apiPost("/api/managed-pages", { name: newPage.trim() });
      setNewPage("");
      setNotice({ tone: "ok", text: "Page created." });
      pages.reload();
    } catch (err) {
      fail(err, "Could not create the page.");
    }
  }
  async function createCreator() {
    if (!newCreator.trim()) return;
    try {
      await apiPost("/api/creators", { name: newCreator.trim() });
      setNewCreator("");
      setNotice({ tone: "ok", text: "Creator created." });
      creators.reload();
    } catch (err) {
      fail(err, "Could not create the creator.");
    }
  }

  const publishable = (accounts.data?.items ?? []).filter((a) => a.publishable !== false);

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted">
        Assign each Upload-Post <strong>profile</strong> to a thematic <strong>page</strong>, and each platform <strong>account</strong> to a <strong>creator</strong>. These are Socialith-side mappings: synchronization never changes them. A page here is a minimal label — the Page Network comes in a later phase.
      </p>
      {notice && <Banner tone={notice.tone}>{notice.text}</Banner>}
      {!canEdit && <Banner tone="info">You can view mappings; changing them needs an Admin.</Banner>}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Profiles → thematic pages">
          {canEdit && (
            <div className="mb-3 flex gap-2">
              <input value={newPage} onChange={(e) => setNewPage(e.target.value)} placeholder="New page name…" className={`flex-1 ${inputClass}`} />
              <button onClick={createPage} className="rounded border border-border px-3 py-2 text-sm hover:border-foreground">Add page</button>
            </div>
          )}
          {profiles.error && <Banner tone="error">{profiles.error}</Banner>}
          <ul className="flex flex-col divide-y divide-border">
            {(profiles.data?.items ?? []).map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{p.displayName ?? p.username}</div>
                  <div className="font-mono text-xs text-muted">{p.username}</div>
                </div>
                <select disabled={!canEdit} value={p.managedPageId ?? ""} onChange={(e) => mapProfile(p.id, e.target.value)} className={`w-48 ${inputClass} disabled:opacity-60`}>
                  <option value="">— no page —</option>
                  {(pages.data ?? []).map((pg) => (<option key={pg.id} value={pg.id}>{pg.name}</option>))}
                </select>
              </li>
            ))}
            {profiles.data && profiles.data.items.length === 0 && <li className="py-4 text-sm text-muted">No active profiles. Synchronize first.</li>}
          </ul>
        </Card>

        <Card title="Accounts → creators">
          {canEdit && (
            <div className="mb-3 flex gap-2">
              <input value={newCreator} onChange={(e) => setNewCreator(e.target.value)} placeholder="New creator name…" className={`flex-1 ${inputClass}`} />
              <button onClick={createCreator} className="rounded border border-border px-3 py-2 text-sm hover:border-foreground">Add creator</button>
            </div>
          )}
          {accounts.error && <Banner tone="error">{accounts.error}</Banner>}
          <ul className="flex flex-col divide-y divide-border">
            {publishable.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm">
                    <Chip>{a.platform}</Chip>
                    <span className="truncate font-medium">{a.handle ? `@${a.handle.replace(/^@/, "")}` : a.displayName}</span>
                    {a.status !== "CONNECTED" && <StatusBadge status={a.status} />}
                  </div>
                  <div className="text-xs text-muted">
                    profile {a.profile.username}
                    {a.socialAccount && <span className="ml-2"><Chip tone={TONES.GREEN}>destination</Chip></span>}
                  </div>
                </div>
                <select disabled={!canEdit} value={a.creatorId ?? ""} onChange={(e) => mapAccount(a.id, e.target.value)} className={`w-48 ${inputClass} disabled:opacity-60`}>
                  <option value="">— no creator —</option>
                  {(creators.data ?? []).map((c) => (<option key={c.id} value={c.id}>{c.name}</option>))}
                </select>
              </li>
            ))}
            {accounts.data && publishable.length === 0 && <li className="py-4 text-sm text-muted">No TikTok, Instagram or YouTube accounts synchronized yet.</li>}
          </ul>
        </Card>
      </div>
    </div>
  );
}
