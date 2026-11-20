"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ApiError, apiPatch, apiPost, apiPut } from "@/lib/api";
import { TaskCard, formatBytes, usePolling, useStudioRole, type PackDetail } from "@/lib/studio";
import { Banner, Card, Chip, TONES, formatDateTime, inputClass, useFetch } from "@/lib/upload-post";

const POLL_MS = 2000;

const STATUS_TONE = {
  READY: TONES.GREEN,
  PARTIAL: TONES.AMBER,
  FAILED: TONES.RED,
  PROCESSING: TONES.BLUE,
  ARCHIVED: TONES.NEUTRAL,
} as const;

const STATUS_TEXT: Record<PackDetail["status"], string> = {
  READY: "Ready",
  PARTIAL: "Ready, some files need attention",
  FAILED: "Failed",
  PROCESSING: "Processing",
  ARCHIVED: "Archived",
};

export default function PackDetailPage({ params }: { params: { id: string } }) {
  const { canEdit } = useStudioRole();
  // follows the pack live while it is being unpacked; stops when it is no longer processing
  const { data: pack, error, loading, reload } = usePolling<PackDetail>(`/api/media/packs/${params.id}`, POLL_MS, (p) => p.status === "PROCESSING");
  const campaigns = useFetch<{ items: { id: string; name: string }[] }>("/api/campaigns?pageSize=100");
  const groups = useFetch<{ items: { id: string; name: string }[] }>("/api/page-network/groups");
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  // re-sync the editable fields only when the saved values change (not on every poll)
  const savedName = pack?.name ?? "";
  const savedDescription = pack?.description ?? "";
  useEffect(() => {
    setName(savedName);
    setDescription(savedDescription);
  }, [savedName, savedDescription]);

  async function run(okText: string, fn: () => Promise<unknown>) {
    setMessage(null);
    try {
      await fn();
      setMessage({ tone: "ok", text: okText });
      reload();
    } catch (err) {
      setMessage({ tone: "error", text: err instanceof ApiError ? err.message : "Something went wrong." });
    }
  }

  if (loading && !pack) return <p className="text-sm text-muted">Loading…</p>;
  if (error && !pack) return <Banner tone="error">{error}</Banner>;
  if (!pack) return null;

  const c = pack.counts;
  const toggle = (list: { id: string }[], id: string) => (list.some((x) => x.id === id) ? list.filter((x) => x.id !== id) : [...list, { id }]).map((x) => x.id);
  const processing = pack.status === "PROCESSING";
  const dirty = name.trim() !== pack.name || (description.trim() || null) !== pack.description;

  return (
    <div className="flex flex-col gap-4">
      <Link href="/studio" className="text-sm text-muted hover:text-foreground">← Media Library</Link>
      {message && <Banner tone={message.tone}>{message.text}</Banner>}

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold tracking-tight" title={pack.name}>{pack.name}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted">
            <Chip tone={STATUS_TONE[pack.status]}>{STATUS_TEXT[pack.status]}</Chip>
            {pack.sourceFileName && <span>{pack.sourceFileName}</span>}
            {pack.sourceArchiveBytes !== null && <span>{formatBytes(pack.sourceArchiveBytes)}</span>}
            <span>uploaded {formatDateTime(pack.createdAt)}</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href={`/studio?packId=${pack.id}`} className="rounded border border-border px-3 py-2 text-sm hover:border-foreground">Browse files</Link>
          {canEdit && !processing && (pack.status === "ARCHIVED" ? (
            <button onClick={() => void run("Pack restored.", () => apiPost(`/api/media/packs/${pack.id}/restore`, {}))} className="rounded border border-border px-3 py-2 text-sm">Restore</button>
          ) : (
            <button onClick={() => void run("Pack archived.", () => apiPost(`/api/media/packs/${pack.id}/archive`, {}))} className="rounded border border-border px-3 py-2 text-sm">Archive</button>
          ))}
        </div>
      </div>

      {pack.error && (
        <div role="alert" className="rounded border border-red-900 bg-red-950/40 p-3 text-sm">
          <p className="text-red-300">{pack.error.message ?? "This pack could not be processed."}</p>
          <details className="mt-2 text-xs text-muted"><summary className="cursor-pointer">Details</summary>{pack.error.code}</details>
        </div>
      )}

      {pack.task && (processing || pack.task.status === "FAILED") && <TaskCard task={pack.task} />}

      <Card title="Contents">
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3 lg:grid-cols-6">
          {[
            ["Files found", pack.entryCount === null ? "counting…" : String(pack.entryCount)],
            ["Ready", String(c.ready)],
            ["Analyzing", String(c.analyzing)],
            ["Need attention", String(c.failed)],
            ["Refused", String(c.rejected)],
            ["Duplicates", String(c.duplicate)],
          ].map(([label, value]) => (
            <div key={label}>
              <dt className="text-xs text-muted">{label}</dt>
              <dd className="text-lg font-medium tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
        {pack.ignoredCount > 0 && <p className="mt-3 text-xs text-muted">{pack.ignoredCount} system or hidden file{pack.ignoredCount === 1 ? " was" : "s were"} ignored (for example .DS_Store and __MACOSX).</p>}
      </Card>

      {pack.refused.length > 0 && (
        <Card title={`Files that need attention (${pack.refused.length})`}>
          <ul className="flex flex-col divide-y divide-border">
            {pack.refused.map((r) => (
              <li key={r.id} className="py-2 text-sm first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Link href={`/studio/assets/${r.id}`} className="truncate font-medium hover:underline" title={r.path ?? r.name}>{r.path ?? r.name}</Link>
                  <Chip tone={r.status === "REJECTED" ? TONES.RED : TONES.AMBER}>{r.status === "REJECTED" ? "refused" : r.status.toLowerCase()}</Chip>
                </div>
                <p className="mt-0.5 text-xs text-muted">{r.reason ?? r.code ?? "No reason was recorded."}</p>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Details">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run("Pack saved.", () => apiPatch(`/api/media/packs/${pack.id}`, { name: name.trim(), description: description.trim() || null }));
            }}
            className="flex flex-col gap-2 text-sm"
          >
            <label className="flex flex-col gap-1">
              Name
              <input value={name} onChange={(e) => setName(e.target.value)} disabled={!canEdit} maxLength={120} required className={inputClass} />
            </label>
            <label className="flex flex-col gap-1">
              Description
              <textarea value={description} onChange={(e) => setDescription(e.target.value)} disabled={!canEdit} rows={3} maxLength={2000} className={inputClass} />
            </label>
            {canEdit && <button disabled={!dirty || !name.trim()} className="self-start rounded border border-border px-3 py-1.5 disabled:opacity-40">Save</button>}
          </form>
        </Card>

        <Card title="Campaigns and page groups">
          <p className="mb-2 text-xs text-muted">Files in this pack count as belonging to these campaigns and page groups unless you assign them individually.</p>
          <div className="flex flex-col gap-3 text-sm">
            <fieldset disabled={!canEdit}>
              <legend className="mb-1 text-xs text-muted">Campaigns</legend>
              <div className="flex flex-wrap gap-2">
                {campaigns.data?.items.length === 0 && <span className="text-muted">No campaigns yet.</span>}
                {campaigns.data?.items.map((c) => {
                  const on = pack.campaigns.some((x) => x.id === c.id);
                  return (
                    <label key={c.id} className={`flex cursor-pointer items-center gap-2 rounded border px-2 py-1 text-xs ${on ? "border-accent bg-accent/10" : "border-border"}`}>
                      <input type="checkbox" checked={on} onChange={() => void run("Campaigns saved.", () => apiPut(`/api/media/packs/${pack.id}/campaigns`, { campaignIds: toggle(pack.campaigns, c.id) }))} />
                      {c.name}
                    </label>
                  );
                })}
              </div>
            </fieldset>
            <fieldset disabled={!canEdit}>
              <legend className="mb-1 text-xs text-muted">Page groups</legend>
              <div className="flex flex-wrap gap-2">
                {groups.data?.items.length === 0 && <span className="text-muted">No page groups yet.</span>}
                {groups.data?.items.map((g) => {
                  const on = pack.pageGroups.some((x) => x.id === g.id);
                  return (
                    <label key={g.id} className={`flex cursor-pointer items-center gap-2 rounded border px-2 py-1 text-xs ${on ? "border-accent bg-accent/10" : "border-border"}`}>
                      <input type="checkbox" checked={on} onChange={() => void run("Page groups saved.", () => apiPut(`/api/media/packs/${pack.id}/page-groups`, { groupIds: toggle(pack.pageGroups, g.id) }))} />
                      {g.name}
                    </label>
                  );
                })}
              </div>
            </fieldset>
          </div>
        </Card>
      </div>
    </div>
  );
}
