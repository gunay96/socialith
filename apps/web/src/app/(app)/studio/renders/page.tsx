"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { ApiError, apiPost } from "@/lib/api";
import { RenderCard, type RenderDto, type RenderList } from "@/lib/renders";
import { Freshness, useStudioRole, usePolling } from "@/lib/studio";
import { Banner, Card } from "@/lib/upload-post";

const ACTIVE_MS = 2000;
const FINISHED_MS = 6000;

function Count({ label, n }: { label: string; n: number | undefined }) {
  return (
    <div className="rounded border border-border bg-surface px-3 py-2">
      <div className="text-lg font-semibold tabular-nums">{n ?? "–"}</div>
      <div className="text-xs text-muted">{label}</div>
    </div>
  );
}

export default function RenderingStudioPage() {
  const { canEdit } = useStudioRole();
  const active = usePolling<RenderList>("/api/renders?state=active&pageSize=50", ACTIVE_MS);
  const finished = usePolling<RenderList>("/api/renders?state=finished&pageSize=20", FINISHED_MS);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const act = useCallback(
    async (path: string, ok: string) => {
      setBusy(true);
      setMessage(null);
      try {
        await apiPost(path);
        setMessage({ tone: "ok", text: ok });
        active.reload();
        finished.reload();
      } catch (err) {
        setMessage({ tone: "error", text: err instanceof ApiError ? err.message : "Something went wrong." });
      } finally {
        setBusy(false);
      }
    },
    [active, finished],
  );
  const onCancel = (id: string) => void act(`/api/renders/${id}/cancel`, "Cancel requested. A waiting render ends at once; a running one stops within a second or two.");
  const onRetry = (id: string) => void act(`/api/renders/${id}/retry`, "The render was queued again with the same settings and words.");

  const waiting = active.data?.items.filter((j) => j.status === "QUEUED") ?? [];
  const running = active.data?.items.filter((j) => j.status === "RUNNING") ?? [];
  const done = finished.data?.items.filter((j) => j.status === "SUCCEEDED") ?? [];
  const failed = finished.data?.items.filter((j) => j.status === "FAILED" || j.status === "CANCELLED") ?? [];
  const counts = active.data?.counts ?? finished.data?.counts;

  const list = (items: RenderDto[], empty: string) =>
    items.length === 0 ? <p className="text-sm text-muted">{empty}</p> : (
      <div className="flex flex-col gap-3">
        {items.map((j) => <RenderCard key={j.id} job={j} canEdit={canEdit} busy={busy} onCancel={onCancel} onRetry={onRetry} />)}
      </div>
    );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted">
          A render puts an approved text on a picture or a video using a recipe, and saves the result in the Media Library. The original file is never changed.
        </p>
        {canEdit && <Link href="/studio/renders/new" className="rounded bg-accent px-3 py-2 text-sm font-medium text-background hover:opacity-90">New render</Link>}
      </div>

      {message && <Banner tone={message.tone}>{message.text}</Banner>}
      {active.error && <Banner tone="error">{active.error}</Banner>}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label="Render totals">
        <Count label="Waiting" n={counts?.QUEUED} />
        <Count label="Rendering" n={counts?.RUNNING} />
        <Count label="Done" n={counts?.SUCCEEDED} />
        <Count label="Failed" n={counts?.FAILED} />
      </div>

      <Card title={`Rendering now${active.data ? ` (${running.length})` : ""}`} action={<Freshness updatedAt={active.updatedAt} intervalMs={ACTIVE_MS} />}>
        {active.loading && !active.data ? <p className="text-sm text-muted">Loading…</p> : list(running, "Nothing is rendering.")}
        <p className="mt-3 text-xs text-muted">The bar shows how much of the final video has been produced, reported by FFmpeg while it works. Before encoding starts, and for pictures, there is no number to show.</p>
      </Card>

      <Card title={`Waiting${active.data ? ` (${waiting.length})` : ""}`}>{list(waiting, "No render is waiting for the worker.")}</Card>

      <Card title="Failed and cancelled" action={<Freshness updatedAt={finished.updatedAt} intervalMs={FINISHED_MS} />}>
        {list(failed, "No render has failed or been cancelled.")}
      </Card>

      <Card title="Done">{list(done, "No render has finished yet.")}</Card>
    </div>
  );
}
