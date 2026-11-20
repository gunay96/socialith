"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ApiError, apiPost, apiPut } from "@/lib/api";
import { AssetStatusChip, KIND_LABEL, TaskCard, factsLine, formatBytes, formatDurationMs, mediaUrl, usePolling, useStudioRole, type AssetDetail } from "@/lib/studio";
import { Banner, Card, Chip, formatDateTime, inputClass, useFetch } from "@/lib/upload-post";

const POLL_MS = 2500;

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd>{value ?? <span className="text-muted">not measured</span>}</dd>
    </>
  );
}

export default function AssetDetailPage({ params }: { params: { id: string } }) {
  const { canEdit, isAdmin } = useStudioRole();
  const { data: a, error, loading, reload } = usePolling<AssetDetail>(`/api/media/assets/${params.id}`, POLL_MS, (d) => d.status === "ANALYZING");
  const campaigns = useFetch<{ items: { id: string; name: string }[] }>("/api/campaigns?pageSize=100");
  const groups = useFetch<{ items: { id: string; name: string }[] }>("/api/page-network/groups");
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [tagInput, setTagInput] = useState("");
  const [notes, setNotes] = useState("");
  const [rights, setRights] = useState<{ status: "UNVERIFIED" | "CONFIRMED" | "RESTRICTED"; notes: string }>({ status: "UNVERIFIED", notes: "" });
  const [playbackFailed, setPlaybackFailed] = useState(false);

  // re-sync the editable fields only when the saved values change (not on every poll)
  const savedNotes = a?.notes ?? "";
  const savedRightsStatus = a?.rights.status ?? "UNVERIFIED";
  const savedRightsNotes = a?.rights.notes ?? "";
  useEffect(() => {
    setNotes(savedNotes);
    setRights({ status: savedRightsStatus, notes: savedRightsNotes });
  }, [savedNotes, savedRightsStatus, savedRightsNotes]);

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

  if (loading && !a) return <p className="text-sm text-muted">Loading…</p>;
  if (error && !a) return <Banner tone="error">{error}</Banner>;
  if (!a) return null;

  const content = mediaUrl(a.contentUrl);
  const poster = mediaUrl(a.thumbnailUrl);
  const f = a.facts;
  const mediaKind = a.kind === "VIDEO" || a.kind === "IMAGE" || a.kind === "AUDIO";
  const setTags = (tags: string[]) => run("Tags saved.", () => apiPut(`/api/media/assets/${a.id}/tags`, { tags }));
  const toggle = (list: { id: string }[], id: string) => (list.some((x) => x.id === id) ? list.filter((x) => x.id !== id) : [...list, { id }]).map((x) => x.id);

  return (
    <div className="flex flex-col gap-4">
      <Link href={a.pack ? `/studio/packs/${a.pack.id}` : "/studio"} className="text-sm text-muted hover:text-foreground">← {a.pack ? a.pack.name : "Media Library"}</Link>
      {message && <Banner tone={message.tone}>{message.text}</Banner>}

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold tracking-tight" title={a.originalName}>{a.originalName}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted">
            <Chip>{KIND_LABEL[a.kind]}</Chip>
            <AssetStatusChip status={a.status} />
            {a.folderPath && <span>in {a.folderPath}</span>}
            <span>{formatBytes(a.sizeBytes)}</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {content && <a href={content} download={a.originalName} className="rounded border border-border px-3 py-2 text-sm hover:border-foreground">Download original</a>}
          {canEdit && (a.status === "FAILED" || a.status === "ANALYZING" || a.status === "READY") && a.contentUrl && (
            <button onClick={() => run("Analysis queued.", () => apiPost(`/api/media/assets/${a.id}/reanalyze`, {}))} className="rounded border border-border px-3 py-2 text-sm">Re-analyze</button>
          )}
          {canEdit && a.status !== "REJECTED" && a.status !== "DUPLICATE" && (a.status === "ARCHIVED" ? (
            <button onClick={() => run("Restored.", () => apiPost(`/api/media/assets/${a.id}/restore`, {}))} className="rounded border border-border px-3 py-2 text-sm">Restore</button>
          ) : (
            <button onClick={() => run("Archived.", () => apiPost(`/api/media/assets/${a.id}/archive`, {}))} className="rounded border border-border px-3 py-2 text-sm">Archive</button>
          ))}
        </div>
      </div>

      {a.rejection && (
        <div role="alert" className="rounded border border-red-900 bg-red-950/40 p-3 text-sm">
          <p className="text-red-300">{a.rejection.reason ?? a.rejection.code}</p>
          <p className="mt-1 text-foreground"><span className="text-muted">What to do: </span>{a.status === "REJECTED" ? "Replace the file with a supported, valid one and upload it again." : "Replace the file or use Re-analyze once the cause is fixed."}</p>
          <details className="mt-2 text-xs text-muted"><summary className="cursor-pointer">Details</summary>{a.rejection.code}</details>
        </div>
      )}
      {a.duplicateOf && (
        <Banner tone="info">
          This file has exactly the same content as <Link href={`/studio/assets/${a.duplicateOf.id}`} className="underline">{a.duplicateOf.originalName ?? "an earlier file"}</Link>. Nothing was stored a second time.
        </Banner>
      )}
      {a.latestTask && (a.latestTask.status === "QUEUED" || a.latestTask.status === "RUNNING" || a.latestTask.status === "FAILED") && <TaskCard task={a.latestTask} />}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <Card title="Preview">
          <div className="flex min-h-48 items-center justify-center rounded bg-background p-2">
            {!content ? (
              <p className="text-sm text-muted">No stored file.</p>
            ) : a.downloadOnly ? (
              <p className="text-sm text-muted">Text and spreadsheet files are not displayed in the page. Use <strong>Download original</strong> to open it.</p>
            ) : a.kind === "VIDEO" ? (
              <video controls preload="metadata" poster={poster} src={content} className="max-h-[32rem] max-w-full" onError={() => setPlaybackFailed(true)} />
            ) : a.kind === "IMAGE" ? (
              <img src={content} alt={a.originalName} className="max-h-[32rem] max-w-full object-contain" />
            ) : (
              <audio controls preload="metadata" src={content} className="w-full" onError={() => setPlaybackFailed(true)} />
            )}
          </div>
          {playbackFailed && <p className="mt-2 text-xs text-amber-400">Your browser cannot play this file&apos;s original format. The file itself is fine and is measured below; browser-friendly previews are produced by the renderer.</p>}
        </Card>

        <Card title="Measured facts">
          {a.status === "ANALYZING" && <p className="mb-2 text-xs text-muted">Still being analyzed…</p>}
          {mediaKind && a.status === "READY" && !f.measured && <p className="mb-2 text-xs text-amber-400">These facts were not measured.</p>}
          <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-2 text-sm">
            <Fact label="Size on disk" value={formatBytes(a.sizeBytes)} />
            <Fact label="Type" value={a.mimeType} />
            {mediaKind && <Fact label="Dimensions" value={f.width && f.height ? `${f.width} × ${f.height}` : null} />}
            {mediaKind && <Fact label="Aspect ratio" value={f.aspectRatio} />}
            {a.kind !== "IMAGE" && mediaKind && <Fact label="Duration" value={f.durationMs !== null ? formatDurationMs(f.durationMs) : null} />}
            {a.kind === "VIDEO" && <Fact label="Frame rate" value={f.fps !== null ? `${f.fps} fps` : null} />}
            {a.kind === "VIDEO" && <Fact label="Video codec" value={f.videoCodec} />}
            {(a.kind === "VIDEO" || a.kind === "AUDIO") && <Fact label="Audio" value={f.hasAudio === null ? null : f.hasAudio ? [f.audioCodec, f.sampleRate ? `${f.sampleRate} Hz` : null, f.channels ? `${f.channels} ch` : null].filter(Boolean).join(" · ") || "yes" : "none"} />}
            {mediaKind && <Fact label="Bitrate" value={f.bitrateKbps !== null ? `${f.bitrateKbps} kbps` : null} />}
            {mediaKind && <Fact label="Container" value={f.container} />}
            <Fact label="Uploaded" value={formatDateTime(a.createdAt)} />
            <Fact label="SHA-256" value={<span className="break-all font-mono text-xs">{a.sha256}</span>} />
          </dl>
          {factsLine(a) && <p className="mt-3 text-xs text-muted">{factsLine(a)}</p>}
        </Card>
      </div>

      {a.status !== "REJECTED" && <div className="grid gap-4 md:grid-cols-2">
        <Card title="Tags">
          <div className="mb-3 flex flex-wrap gap-2">
            {a.tags.length === 0 && <span className="text-sm text-muted">No tags yet.</span>}
            {a.tags.map((t) => (
              <span key={t} className="inline-flex items-center gap-1 rounded border border-border px-2 py-0.5 text-xs">
                #{t}
                {canEdit && <button aria-label={`Remove tag ${t}`} onClick={() => void setTags(a.tags.filter((x) => x !== t))} className="text-muted hover:text-foreground">×</button>}
              </span>
            ))}
          </div>
          {canEdit && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const next = tagInput.trim();
                if (!next) return;
                setTagInput("");
                void setTags([...a.tags, next]);
              }}
              className="flex gap-2 text-sm"
            >
              <input value={tagInput} onChange={(e) => setTagInput(e.target.value)} maxLength={64} placeholder="Add a tag and press Enter" aria-label="New tag" className={`${inputClass} flex-1`} />
              <button className="rounded border border-border px-3 py-2">Add</button>
            </form>
          )}
        </Card>

        <Card title="Notes">
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} disabled={!canEdit} rows={3} maxLength={4000} aria-label="Notes" className={`${inputClass} w-full text-sm`} />
          {canEdit && <button onClick={() => void run("Notes saved.", () => apiPut(`/api/media/assets/${a.id}/notes`, { notes: notes.trim() || null }))} className="mt-2 rounded border border-border px-3 py-1.5 text-sm">Save notes</button>}
        </Card>

        <Card title="Usage rights">
          <p className="mb-2 text-xs text-muted">Audio can only be mixed into a render once an administrator has confirmed that the organization may use it.</p>
          <div className="flex flex-col gap-2 text-sm">
            <select value={rights.status} disabled={!isAdmin} onChange={(e) => setRights({ ...rights, status: e.target.value as typeof rights.status })} aria-label="Rights status" className={inputClass}>
              <option value="UNVERIFIED">Not verified</option>
              <option value="CONFIRMED">Confirmed: we may use it</option>
              <option value="RESTRICTED">Restricted: do not use</option>
            </select>
            <textarea value={rights.notes} disabled={!isAdmin} onChange={(e) => setRights({ ...rights, notes: e.target.value })} rows={2} maxLength={2000} placeholder="Licence, contract, who granted it…" aria-label="Rights notes" className={inputClass} />
            {isAdmin ? <button onClick={() => void run("Rights saved.", () => apiPut(`/api/media/assets/${a.id}/rights`, { status: rights.status, notes: rights.notes.trim() || null }))} className="self-start rounded border border-border px-3 py-1.5">Save rights</button> : <p className="text-xs text-muted">Only administrators can change this.</p>}
            {a.rights.confirmedAt && <p className="text-xs text-muted">Confirmed {formatDateTime(a.rights.confirmedAt)}</p>}
          </div>
        </Card>

        <Card title="Campaigns and page groups">
          <div className="flex flex-col gap-3 text-sm">
            <fieldset disabled={!canEdit}>
              <legend className="mb-1 text-xs text-muted">Campaigns</legend>
              <div className="flex flex-wrap gap-2">
                {campaigns.data?.items.length === 0 && <span className="text-muted">No campaigns yet.</span>}
                {campaigns.data?.items.map((c) => {
                  const on = a.campaigns.some((x) => x.id === c.id);
                  const inherited = a.inheritedFromPack.campaigns.some((x) => x.id === c.id);
                  return (
                    <label key={c.id} className={`flex cursor-pointer items-center gap-2 rounded border px-2 py-1 text-xs ${on ? "border-accent bg-accent/10" : "border-border"}`}>
                      <input type="checkbox" checked={on} onChange={() => void run("Campaigns saved.", () => apiPut(`/api/media/assets/${a.id}/campaigns`, { campaignIds: toggle(a.campaigns, c.id) }))} />
                      {c.name}{inherited && <span className="text-muted">(via pack)</span>}
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
                  const on = a.pageGroups.some((x) => x.id === g.id);
                  const inherited = a.inheritedFromPack.pageGroups.some((x) => x.id === g.id);
                  return (
                    <label key={g.id} className={`flex cursor-pointer items-center gap-2 rounded border px-2 py-1 text-xs ${on ? "border-accent bg-accent/10" : "border-border"}`}>
                      <input type="checkbox" checked={on} onChange={() => void run("Page groups saved.", () => apiPut(`/api/media/assets/${a.id}/page-groups`, { groupIds: toggle(a.pageGroups, g.id) }))} />
                      {g.name}{inherited && <span className="text-muted">(via pack)</span>}
                    </label>
                  );
                })}
              </div>
            </fieldset>
          </div>
        </Card>
      </div>}
      {a.duplicateCount > 0 && <p className="text-xs text-muted">{a.duplicateCount} other upload{a.duplicateCount === 1 ? " was" : "s were"} recognised as copies of this file.</p>}
    </div>
  );
}
