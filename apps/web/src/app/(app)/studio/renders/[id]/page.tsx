"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { formatElapsed } from "@socialith/studio";
import { ApiError, apiPost } from "@/lib/api";
import { SourceBadge } from "@/lib/recipes";
import { RenderCard, isActive, kindWord, type RenderDetail } from "@/lib/renders";
import { formatBytes, formatDurationMs, mediaUrl, usePolling, useStudioRole, Freshness } from "@/lib/studio";
import { Banner, Card, Chip, TONES, formatDateTime } from "@/lib/upload-post";

const ACTIVE_MS = 2000;
/** The settings in reading order, with plain names. Anything stored that is not listed is shown after these under its own key. */
const SETTINGS: [string, string][] = [
  ["aspectRatio", "Shape"], ["exportResolution", "Export size"], ["exportFps", "Frames per second"], ["imageFormat", "Picture format (stills)"], ["fit", "Picture in the frame"],
  ["font", "Font"], ["weight", "Weight"], ["sizePct", "Text size (% of height)"], ["color", "Text colour"], ["transform", "Letter case"], ["shadow", "Shadow"],
  ["vertical", "Vertical position"], ["offsetPct", "Offset (%)"], ["align", "Alignment"], ["maxWidthPct", "Text width (%)"],
  ["backgroundMode", "Text background"], ["backgroundColor", "Background colour"], ["backgroundOpacityPct", "Background opacity (%)"], ["backgroundPaddingPct", "Background padding (%)"],
  ["entryAnimation", "Entry"], ["entryMs", "Entry length (ms)"], ["exitAnimation", "Exit"], ["exitMs", "Exit length (ms)"], ["textAnimation", "Text animation"],
  ["durationMode", "Length"], ["durationSeconds", "Fixed length (s)"],
  ["subtitlesEnabled", "Subtitles"], ["subtitlesPosition", "Subtitle position"], ["subtitlesWordsPerCue", "Words per subtitle"], ["subtitlesColor", "Subtitle colour"], ["subtitlesBackground", "Subtitle box"],
];

function show(v: unknown): string {
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (v === null || v === undefined) return "-";
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

export default function RenderDetailPage({ params }: { params: { id: string } }) {
  const router = useRouter();
  const { canEdit } = useStudioRole();
  const q = usePolling<RenderDetail>(`/api/renders/${params.id}`, ACTIVE_MS, (d) => isActive(d.status));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const job = q.data;

  const act = async (path: string, ok: string, then?: (r: RenderDetail) => void) => {
    setBusy(true);
    setMessage(null);
    try {
      const r = await apiPost<RenderDetail>(path);
      setMessage({ tone: "ok", text: ok });
      if (then) then(r);
      else q.reload();
    } catch (err) {
      setMessage({ tone: "error", text: err instanceof ApiError ? err.message : "Something went wrong." });
    } finally {
      setBusy(false);
    }
  };

  if (q.loading && !job) return <p className="text-sm text-muted">Loading…</p>;
  if (q.error && !job) return <Banner tone="error">{q.error}</Banner>;
  if (!job) return null;

  const result = job.result;
  const facts = result?.validation?.facts;
  const readability = result?.readability ?? null;
  const notes = [...job.warnings, ...(result?.adjustments ?? []).map((a) => `Adjusted to fit: ${a}`)];
  const takes = job.startedAt && job.finishedAt ? new Date(job.finishedAt).getTime() - new Date(job.startedAt).getTime() : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <Link href="/studio/renders" className="text-muted hover:text-foreground">&larr; Rendering Studio</Link>
        {isActive(job.status) ? <Freshness updatedAt={q.updatedAt} intervalMs={ACTIVE_MS} /> : <span className="text-xs text-muted">Finished {formatDateTime(job.finishedAt)}</span>}
      </div>
      {message && <Banner tone={message.tone}>{message.text}</Banner>}
      {q.error && <Banner tone="error">{q.error}</Banner>}

      <RenderCard job={job} canEdit={canEdit} busy={busy} detail
        onCancel={(id) => void act(`/api/renders/${id}/cancel`, "Cancel requested. A waiting render ends at once; a running one stops within a second or two.")}
        onRetry={(id) => void act(`/api/renders/${id}/retry`, "The render was queued again with the same settings and words.", (r) => router.push(`/studio/renders/${r.id}`))} />

      {job.status === "SUCCEEDED" && job.output && (
        <Card title="Result">
          <div className="grid gap-4 md:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
            <div>
              {job.output.kind === "VIDEO" && job.output.contentUrl && <video src={mediaUrl(job.output.contentUrl)} poster={mediaUrl(job.output.thumbnailUrl)} controls playsInline preload="metadata" className="w-full rounded border border-border bg-black" aria-label="Rendered video" />}
              {job.output.kind === "IMAGE" && job.output.contentUrl && <img src={mediaUrl(job.output.contentUrl)} alt="The rendered picture" className="w-full rounded border border-border bg-black" />}
              <p className="mt-1 text-xs text-muted">This is the real rendered file, played from storage.</p>
            </div>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted">Saved as</dt><dd className="truncate">{job.output.originalName}</dd>
              <dt className="text-muted">Kind</dt><dd>{kindWord(job.outputKind)}{job.outputKind === "IMAGE" ? (facts?.videoCodec === "mjpeg" ? " (JPEG)" : facts?.videoCodec === "png" ? " (PNG)" : "") : facts?.container?.includes("mp4") ? " (MP4)" : facts?.container ? ` (${facts.container})` : ""}</dd>
              {facts?.width && facts.height && <><dt className="text-muted">Size</dt><dd>{facts.width} × {facts.height}</dd></>}
              {facts?.durationMs != null && job.outputKind === "VIDEO" && <><dt className="text-muted">Length</dt><dd>{formatDurationMs(facts.durationMs)}</dd></>}
              {facts?.videoCodec && job.outputKind === "VIDEO" && <><dt className="text-muted">Video</dt><dd>{facts.videoCodec}{facts.fps ? `, ${Math.round(facts.fps * 100) / 100} fps` : ""}</dd></>}
              {job.outputKind === "VIDEO" && <><dt className="text-muted">Audio</dt><dd>{facts?.audioCodec ?? "none"}</dd></>}
              {facts && <><dt className="text-muted">File size</dt><dd>{formatBytes(facts.sizeBytes)}</dd></>}
              {takes !== null && <><dt className="text-muted">Rendering took</dt><dd>{formatElapsed(takes)}</dd></>}
              <dt className="text-muted">Library status</dt><dd><Chip tone={TONES.GREEN}>{job.output.status.toLowerCase()}</Chip> <Link href={`/studio/assets/${job.output.id}`} className="ml-2 text-xs underline">Open in Media Library</Link></dd>
            </dl>
          </div>
          <p className="mt-3 text-xs text-muted">Nothing is published automatically. The file is in the Media Library, tagged &ldquo;rendered&rdquo;. The Publishing Center cannot pick Media Library files yet; until that is connected, download the file and attach it through the existing upload.</p>
        </Card>
      )}

      {job.status === "SUCCEEDED" && (notes.length > 0 || readability || result?.fonts?.fallback) && (
        <Card title="Things to check">
          <ul className="flex flex-col gap-2 text-sm">
            {readability && (
              <li className="flex items-start gap-2">
                <Chip tone={readability.status === "GOOD" ? TONES.GREEN : readability.status === "FAIR" ? TONES.AMBER : TONES.RED}>readability: {readability.status.toLowerCase()}</Chip>
                <span>The lowest contrast between the text and what is behind it was {readability.minContrast.toFixed(1)}:1 (4.5:1 or more is good, 3:1 is acceptable for large text). This is measured on a few frames, not guaranteed for every frame.</span>
              </li>
            )}
            {result?.fonts?.fallback && <li className="flex items-start gap-2"><Chip tone={TONES.AMBER}>font</Chip><span>{result.fonts.note ?? "The requested font was not available, so another one was used."}</span></li>}
            {notes.map((n) => <li key={n} className="flex items-start gap-2"><Chip tone={TONES.AMBER}>note</Chip><span>{n}</span></li>)}
          </ul>
        </Card>
      )}

      {result?.validation && (
        <Card title="Output checks">
          <p className="mb-2 text-xs text-muted">After rendering, the file is read back with ffprobe and decoded completely to make sure it is valid. {result.validation.ok ? "Every check passed." : "At least one check failed."}</p>
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-muted"><tr><th className="py-1 pr-3 font-normal">Check</th><th className="py-1 pr-3 font-normal">Expected</th><th className="py-1 pr-3 font-normal">Found</th><th className="py-1 font-normal">Result</th></tr></thead>
            <tbody>
              {result.validation.checks.map((c) => (
                <tr key={c.name} className="border-t border-border">
                  <td className="py-1 pr-3">{c.name}</td><td className="py-1 pr-3 text-muted">{c.expected}</td><td className="py-1 pr-3">{c.actual}</td>
                  <td className="py-1"><Chip tone={c.ok ? TONES.GREEN : TONES.RED}>{c.ok ? "passed" : "failed"}</Chip></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        <Card title="What it was made from">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted">Source file</dt>
            <dd className="min-w-0"><Link href={`/studio/assets/${job.source.id}`} className="truncate underline">{job.source.name ?? "Media file"}</Link>{job.source.width && job.source.height ? <span className="ml-2 text-xs text-muted">{job.source.width} × {job.source.height}</span> : null}<div className="text-xs text-muted">The original is kept exactly as it was uploaded.</div></dd>
            <dt className="text-muted">Text</dt>
            <dd className="min-w-0 whitespace-pre-wrap">&ldquo;{job.text.snapshot}&rdquo;<div className="text-xs text-muted">Copied when the render was started{job.text.language ? `, language ${job.text.language}` : ""}.</div></dd>
            <dt className="text-muted">Recipe</dt>
            <dd><Link href={`/studio/recipes/${job.recipe.id}`} className="underline">{job.recipe.name}</Link> <span className="text-xs text-muted">version {job.recipe.version} when started</span></dd>
            <dt className="text-muted">For</dt>
            <dd>{job.page ? `Page: ${job.page.name ?? "(removed)"}` : job.group ? `Page group: ${job.group.name ?? "(removed)"}` : "No page chosen"}</dd>
            <dt className="text-muted">Requested</dt><dd>{formatDateTime(job.createdAt)}</dd>
            <dt className="text-muted">Started</dt><dd>{formatDateTime(job.startedAt)}</dd>
            <dt className="text-muted">Finished</dt><dd>{formatDateTime(job.finishedAt)}</dd>
          </dl>
        </Card>

        <Card title="Settings used">
          {job.effective ? (
            <dl className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 text-sm">
              {[...SETTINGS.filter(([k]) => k in job.effective!.values), ...Object.keys(job.effective.values).filter((k) => !SETTINGS.some(([s]) => s === k)).map((k): [string, string] => [k, k])].map(([k, label]) => (
                <div key={k} className="contents">
                  <dt className="text-muted">{label}</dt>
                  <dd className="truncate">{show(job.effective!.values[k])}</dd>
                  <dd><SourceBadge source={job.effective?.sources[k] as Parameters<typeof SourceBadge>[0]["source"]} /></dd>
                </div>
              ))}
            </dl>
          ) : <p className="text-sm text-muted">Not recorded.</p>}
          <p className="mt-2 text-xs text-muted">These values were frozen when the render was requested. Changing the recipe later does not change this render, and a retry uses these same values.</p>
        </Card>
      </div>

      {job.relatedAttempts.length > 0 && (
        <Card title="Other attempts of this render">
          <ul className="flex flex-col gap-1 text-sm">
            {job.relatedAttempts.map((a) => (
              <li key={a.id}><Link href={`/studio/renders/${a.id}`} className="underline">{formatDateTime(a.createdAt)}</Link> <Chip>{a.status.toLowerCase()}</Chip>{a.retryOfId ? <span className="ml-2 text-xs text-muted">a retry</span> : null}</li>
            ))}
          </ul>
        </Card>
      )}

      {result?.filtergraph && (
        <details className="rounded border border-border bg-surface p-4 text-sm">
          <summary className="cursor-pointer text-muted">Technical details: the FFmpeg filter graph</summary>
          <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs text-muted">{result.filtergraph}</pre>
        </details>
      )}
    </div>
  );
}
