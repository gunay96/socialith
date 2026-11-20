"use client";

import Link from "next/link";
import { computeProgress, formatElapsed } from "@socialith/studio";
import { formatDurationMs, mediaUrl, ProgressBar, useNow, type AssetDto, type AssetKind, type TaskDto } from "@/lib/studio";
import type { Issue } from "@/lib/recipes";
import { Chip, TONES } from "@/lib/upload-post";

// ------------------------------------------------------------------------------------------------ API shapes

export type RenderStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";

export interface RenderDto {
  id: string;
  status: RenderStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  attempts: number;
  retryOfId: string | null;
  cancelRequested: boolean;
  task: TaskDto | null;
  source: { id: string; name: string | null; kind: AssetKind | null; status: string | null; thumbnailUrl: string | null; width: number | null; height: number | null; durationMs: number | null };
  text: { id: string; snapshot: string; language: string | null };
  recipe: { id: string; name: string; version: number };
  page: { id: string; name: string | null } | null;
  group: { id: string; name: string | null } | null;
  campaignId: string | null;
  outputKind: "VIDEO" | "IMAGE" | null;
  output: AssetDto | null;
  error: { code: string; message: string | null; remedy: string | null } | null;
  warnings: string[];
}

export interface RenderValidationCheck { name: string; ok: boolean; expected: string; actual: string }

export interface RenderResult {
  outputKind?: "VIDEO" | "IMAGE";
  durationMs?: number;
  elapsedMs?: number;
  frame?: { width: number; height: number };
  fontSizePx?: number;
  requestedFontSizePx?: number;
  lines?: { text: string }[];
  adjustments?: string[];
  fonts?: { requested: { fontId: string; weight: string }; used: { fontId: string; weight: string; file?: string }; fallback: boolean; standIn: boolean; note: string | null };
  readability?: { status: "GOOD" | "FAIR" | "LOW"; minContrast: number } | null;
  subtitleCues?: number;
  warnings?: string[];
  validation?: { ok: boolean; checks: RenderValidationCheck[]; facts: { container: string | null; videoCodec: string | null; audioCodec: string | null; width: number | null; height: number | null; durationMs: number | null; fps: number | null; sizeBytes: number } };
  filtergraph?: string;
}

export interface RenderDetail extends RenderDto {
  effective: { values: Record<string, unknown>; sources: Record<string, string>; warnings?: string[] } | null;
  adjustment: unknown;
  recipeConfig: unknown;
  result: RenderResult | null;
  relatedAttempts: { id: string; status: RenderStatus; createdAt: string; retryOfId: string | null }[];
}

export interface RenderList {
  items: RenderDto[];
  total: number;
  page: number;
  pageSize: number;
  counts: Record<RenderStatus, number>;
}

export interface RecipeChoice { id: string; name: string; matchedBy: "chosen" | "page" | "group" | "category" | "everyone"; mediaKinds: string[] }

export interface RenderResolved {
  chosen: RecipeChoice | null;
  candidates: RecipeChoice[];
  evaluation: import("@/lib/recipes").Evaluation | null;
}

export interface DuplicateDetails { code: "DUPLICATE_RENDER"; jobId?: string; status?: RenderStatus; outputAssetId?: string | null; canForce: boolean }
export interface NotRenderableDetails { code: "NOT_RENDERABLE"; issues: Issue[] }

export const RENDER_STATUS: Record<RenderStatus, { label: string; tone: string }> = {
  QUEUED: { label: "waiting", tone: TONES.NEUTRAL },
  RUNNING: { label: "rendering", tone: TONES.BLUE },
  SUCCEEDED: { label: "done", tone: TONES.GREEN },
  FAILED: { label: "failed", tone: TONES.RED },
  CANCELLED: { label: "cancelled", tone: TONES.NEUTRAL },
};

export const isActive = (s: RenderStatus): boolean => s === "QUEUED" || s === "RUNNING";

export const MATCH_WORDS: Record<RecipeChoice["matchedBy"], string> = { chosen: "chosen by you", page: "set for this page", group: "set for its page group", category: "set for its page category", everyone: "for every page" };

export function RenderStatusChip({ job }: { job: Pick<RenderDto, "status" | "cancelRequested"> }) {
  if (job.status === "RUNNING" && job.cancelRequested) return <Chip tone={TONES.AMBER}>stopping</Chip>;
  const s = RENDER_STATUS[job.status];
  return <Chip tone={s.tone}>{s.label}</Chip>;
}

export const kindWord = (k: "VIDEO" | "IMAGE" | null): string => (k === "VIDEO" ? "video" : k === "IMAGE" ? "picture" : "file");

/** What a render is for, in one line: the page or group it targets, or "no page". */
export function targetLine(j: Pick<RenderDto, "page" | "group">): string {
  if (j.page) return `Page: ${j.page.name ?? "(removed)"}`;
  if (j.group) return `Page group: ${j.group.name ?? "(removed)"}`;
  return "No page chosen";
}

// ------------------------------------------------------------------------------------------------ the job card

/**
 * One render job in a list: what is being made, for whom, how far along it is (a percentage ONLY when the worker
 * reported measurable work), how long it has taken, and what to do when it failed.
 */
export function RenderCard({ job, canEdit, busy, onCancel, onRetry, detail = false }: { job: RenderDto; canEdit: boolean; busy: boolean; onCancel: (id: string) => void; onRetry: (id: string) => void; detail?: boolean }) {
  const now = useNow(1000);
  const task = job.task;
  const p = task ? computeProgress({ status: task.status, completedUnits: task.progress.completedUnits, totalUnits: task.progress.totalUnits, startedAt: task.startedAt, finishedAt: task.finishedAt, lastProgressAt: task.lastProgressAt }, now) : null;
  const active = isActive(job.status);
  const thumb = job.output?.thumbnailUrl ?? job.source.thumbnailUrl;
  const started = job.startedAt ? new Date(job.startedAt).getTime() : null;
  const finished = job.finishedAt ? new Date(job.finishedAt).getTime() : null;
  const elapsed = started !== null ? (finished ?? now.getTime()) - started : null;
  const silentMs = task?.lastProgressAt ? now.getTime() - new Date(task.lastProgressAt).getTime() : null;

  return (
    <article className="flex gap-3 rounded border border-border bg-surface p-3" aria-label={`Render of ${job.source.name ?? "a file"}: ${RENDER_STATUS[job.status].label}`}>
      <Link href={`/studio/renders/${job.id}`} className="shrink-0" aria-label="Open this render">
        {thumb ? <img src={mediaUrl(thumb)} alt="" loading="lazy" className="h-24 w-16 rounded border border-border object-cover" /> : <span className="flex h-24 w-16 items-center justify-center rounded border border-border bg-background text-[10px] uppercase text-muted">{kindWord(job.outputKind ?? (job.source.kind === "VIDEO" ? "VIDEO" : "IMAGE"))}</span>}
      </Link>
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex flex-wrap items-center gap-2 text-sm">
          <Link href={`/studio/renders/${job.id}`} className="truncate font-medium hover:underline">{job.source.name ?? "Media file"}</Link>
          <RenderStatusChip job={job} />
          {job.attempts > 1 && <Chip title="The job was started again after an interruption">attempt {job.attempts}</Chip>}
          {job.retryOfId && <Chip title="This is a retry of an earlier render">retry</Chip>}
          {job.outputKind && <Chip>{kindWord(job.outputKind)}</Chip>}
        </div>
        <p className="truncate text-xs text-muted">{targetLine(job)} · Recipe: {job.recipe.name} (v{job.recipe.version})</p>
        <p className="mb-2 line-clamp-2 text-xs text-foreground/80">&ldquo;{job.text.snapshot}&rdquo;</p>

        {active && task && p && (
          <>
            <ProgressBar task={task} now={now} label="Render" />
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
              <span aria-live="polite">{job.cancelRequested ? "Stopping…" : (task.stage ?? "Waiting for the worker")}{task.stageDetail ? <span className="ml-1 text-foreground/70">· {task.stageDetail}</span> : null}</span>
              <span>
                {p.mode === "determinate" ? `${formatDurationMs(p.completedUnits)} of ${formatDurationMs(p.totalUnits)} rendered · ${p.percentage}%` : "percentage not measurable yet"}
                {elapsed !== null ? ` · ${formatElapsed(elapsed)} elapsed` : ""}
              </span>
            </div>
            {p.stalled && <p className="mt-2 rounded border border-amber-900 bg-amber-950/40 px-2 py-1 text-xs text-amber-400">No update for {formatElapsed(silentMs)}. The worker may have stopped; the render resumes by itself when it is running again.</p>}
          </>
        )}
        {job.status === "SUCCEEDED" && (
          <p className="text-xs text-muted">
            Done{elapsed !== null ? ` in ${formatElapsed(elapsed)}` : ""}.
            {job.warnings.length > 0 && <span className="ml-1 text-amber-400">{job.warnings.length} note{job.warnings.length === 1 ? "" : "s"} to check.</span>}
          </p>
        )}
        {job.status === "CANCELLED" && <p className="text-xs text-muted">Cancelled. Nothing was added to the Media Library.</p>}
        {job.status === "FAILED" && job.error && (
          <div role="alert" className="rounded border border-red-900 bg-red-950/40 p-2 text-sm">
            <p className="text-red-300">{job.error.message ?? "The render failed."}</p>
            {job.error.remedy && <p className="mt-1 text-xs text-foreground"><span className="text-muted">What to do: </span>{job.error.remedy}</p>}
          </div>
        )}

        <div className="mt-2 flex flex-wrap gap-2 text-xs">
          {!detail && <Link href={`/studio/renders/${job.id}`} className="rounded border border-border px-2.5 py-1 hover:border-foreground">Details</Link>}
          {job.status === "SUCCEEDED" && job.output && <Link href={`/studio/assets/${job.output.id}`} className="rounded border border-border px-2.5 py-1 hover:border-foreground">Open in Media Library</Link>}
          {canEdit && active && !job.cancelRequested && <button type="button" disabled={busy} onClick={() => onCancel(job.id)} className="rounded border border-border px-2.5 py-1 hover:border-foreground disabled:opacity-40">Cancel</button>}
          {canEdit && (job.status === "FAILED" || job.status === "CANCELLED") && <button type="button" disabled={busy} onClick={() => onRetry(job.id)} className="rounded border border-border px-2.5 py-1 hover:border-foreground disabled:opacity-40">Retry</button>}
        </div>
      </div>
    </article>
  );
}
