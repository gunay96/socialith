"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { computeProgress, formatElapsed } from "@socialith/studio";
import { API_BASE_URL, ApiError, apiGet } from "@/lib/api";
import { useCurrentUser } from "@/lib/auth-context";
import { Chip, TONES } from "@/lib/upload-post";

// ------------------------------------------------------------------------------------------------ API shapes

export type AssetKind = "VIDEO" | "IMAGE" | "AUDIO" | "TEXT" | "SPREADSHEET";
export type AssetStatus = "ANALYZING" | "READY" | "FAILED" | "REJECTED" | "DUPLICATE" | "ARCHIVED";
export type TaskStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";

export interface AssetDto {
  id: string;
  packId: string | null;
  pack: { id: string; name: string } | null;
  folderPath: string;
  originalName: string;
  entryPath: string | null;
  kind: AssetKind;
  status: AssetStatus;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  duplicateOf: { id: string; originalName: string | null } | null;
  rejection: { code: string; reason: string | null } | null;
  facts: {
    width: number | null;
    height: number | null;
    aspectRatio: string | null;
    aspectDecimal: number | null;
    durationMs: number | null;
    fps: number | null;
    videoCodec: string | null;
    audioCodec: string | null;
    hasAudio: boolean | null;
    bitrateKbps: number | null;
    container: string | null;
    sampleRate: number | null;
    channels: number | null;
    measured: boolean;
  };
  rights: { status: "UNVERIFIED" | "CONFIRMED" | "RESTRICTED"; notes: string | null; confirmedAt: string | null };
  notes: string | null;
  tags: string[];
  hasThumbnail: boolean;
  thumbnailUrl: string | null;
  contentUrl: string | null;
  downloadOnly: boolean;
  createdAt: string;
  analyzedAt: string | null;
}

export interface AssetDetail extends AssetDto {
  campaigns: { id: string; name: string }[];
  pageGroups: { id: string; name: string }[];
  inheritedFromPack: { campaigns: { id: string; name: string }[]; pageGroups: { id: string; name: string }[] };
  duplicateCount: number;
  latestTask: TaskDto | null;
}

export interface PackCounts { ready: number; analyzing: number; failed: number; rejected: number; duplicate: number; archived: number; total: number }

export interface PackDto {
  id: string;
  name: string;
  description: string | null;
  sourceType: "ZIP" | "MANUAL";
  sourceFileName: string | null;
  sourceArchiveBytes: number | null;
  status: "PROCESSING" | "READY" | "PARTIAL" | "FAILED" | "ARCHIVED";
  entryCount: number | null;
  ignoredCount: number;
  counts: PackCounts;
  error: { code: string; message: string | null } | null;
  campaigns: { id: string; name: string }[];
  pageGroups: { id: string; name: string }[];
  task: TaskDto | null;
  createdAt: string;
  completedAt: string | null;
}

export interface PackDetail extends PackDto {
  refused: { id: string; name: string; path: string | null; status: string; code: string | null; reason: string | null }[];
}

export interface TaskDto {
  id: string;
  type: string;
  status: TaskStatus;
  stage: string | null;
  stageDetail: string | null;
  unit: string | null;
  subject: { type: string; id: string } | null;
  parentTaskId: string | null;
  attempts: number;
  error: { code: string; message: string | null; remedy: string | null } | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  lastProgressAt: string | null;
  progress: { mode: "determinate" | "indeterminate" | "none"; completedUnits: number; totalUnits: number | null; percentage: number | null; elapsedMs: number | null; stalled: boolean; inconsistent: boolean };
}

export interface Paged<T> { items: T[]; total: number; page: number; pageSize: number }

// ------------------------------------------------------------------------------------------------ roles

export function useStudioRole() {
  const me = useCurrentUser();
  return { canEdit: me.role !== "VIEWER", isAdmin: me.role === "ADMIN" || me.role === "OWNER" };
}

// ------------------------------------------------------------------------------------------------ formatting

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`;
}

export function formatDurationMs(ms: number | null): string {
  if (ms === null) return "—";
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

/** "1080 × 1920 · 9:16 · 0:15" - only facts that were measured; an unknown fact is simply not shown. */
export function factsLine(a: AssetDto): string {
  const parts: string[] = [];
  if (a.facts.width && a.facts.height) parts.push(`${a.facts.width} × ${a.facts.height}`);
  if (a.facts.aspectRatio) parts.push(a.facts.aspectRatio);
  if (a.facts.durationMs !== null) parts.push(formatDurationMs(a.facts.durationMs));
  return parts.join(" · ");
}

export const mediaUrl = (path: string | null): string | undefined => (path ? `${API_BASE_URL}${path}` : undefined);

const STATUS_TONE: Record<AssetStatus, string> = { READY: TONES.GREEN, ANALYZING: TONES.BLUE, FAILED: TONES.RED, REJECTED: TONES.RED, DUPLICATE: TONES.AMBER, ARCHIVED: TONES.NEUTRAL };
export function AssetStatusChip({ status }: { status: AssetStatus }) {
  return <Chip tone={STATUS_TONE[status]}>{status === "ANALYZING" ? "analyzing" : status.toLowerCase()}</Chip>;
}

export const KIND_LABEL: Record<AssetKind, string> = { VIDEO: "Video", IMAGE: "Image", AUDIO: "Audio", TEXT: "Text", SPREADSHEET: "Spreadsheet" };

export const TASK_LABEL: Record<string, string> = {
  MEDIA_ZIP_EXTRACT: "ZIP extraction",
  MEDIA_ANALYZE: "Media analysis",
  MEDIA_PREVIEW: "Preview rendering",
  RENDER: "Video / image render",
  AI_GENERATION: "AI generation",
  AI_BATCH: "Batch generation",
};

// ------------------------------------------------------------------------------------------------ time

/** Re-renders every `ms` so elapsed times and "updated Ns ago" move between polls (from real timestamps only). */
export function useNow(ms = 1000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/**
 * Polls an endpoint. Pauses while the tab is hidden, refreshes at once when it becomes visible again, and reports when
 * it last SUCCEEDED so the interface can mark stale data instead of presenting it as live
 * (docs/SOCIALITH_UX_DESIGN_SYSTEM.md section 6.4).
 */
export function usePolling<T>(path: string | null, intervalMs: number, shouldContinue: (data: T) => boolean = () => true) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [tick, setTick] = useState(0);
  const keepGoing = useRef(shouldContinue);
  keepGoing.current = shouldContinue;

  useEffect(() => {
    if (path === null) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const run = async () => {
      if (cancelled) return;
      if (typeof document !== "undefined" && document.hidden) {
        timer = setTimeout(run, intervalMs);
        return;
      }
      try {
        const next = await apiGet<T>(path);
        if (cancelled) return;
        setData(next);
        setError(null);
        setUpdatedAt(new Date());
        setLoading(false);
        if (keepGoing.current(next)) timer = setTimeout(run, intervalMs);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : "Could not refresh.");
        setLoading(false);
        timer = setTimeout(run, intervalMs * 2);
      }
    };
    void run();
    const onVisible = () => {
      if (!document.hidden) {
        if (timer) clearTimeout(timer);
        void run();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [path, intervalMs, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, updatedAt, reload };
}

/** "Updated 3 s ago", or an amber "stale" chip when the last successful refresh is older than twice the interval. */
export function Freshness({ updatedAt, intervalMs }: { updatedAt: Date | null; intervalMs: number }) {
  const now = useNow(1000);
  if (!updatedAt) return <span className="text-xs text-muted">Loading…</span>;
  const age = now.getTime() - updatedAt.getTime();
  const stale = age > intervalMs * 2 + 1000;
  return (
    <span className="flex items-center gap-2 text-xs text-muted" aria-live="off">
      {stale && <Chip tone={TONES.AMBER}>stale</Chip>}
      Updated {Math.max(0, Math.round(age / 1000))} s ago
    </span>
  );
}

// ------------------------------------------------------------------------------------------------ progress

/**
 * The progress bar. It draws exactly what the task says and nothing more:
 *  - determinate  (a real completed/total from the worker): a filled bar with the percentage = completed / total x 100
 *  - indeterminate (nothing measurable): a looping highlight, no number
 *  - stalled      (running but silent): amber, and says so
 * Reduced motion: the fill does not animate and the looping highlight becomes a static marker.
 */
export function ProgressBar({ task, now, label }: { task: TaskDto; now: Date; label: string }) {
  const progress = computeProgress(
    { status: task.status, completedUnits: task.progress.completedUnits, totalUnits: task.progress.totalUnits, startedAt: task.startedAt, finishedAt: task.finishedAt, lastProgressAt: task.lastProgressAt },
    now,
  );
  if (task.status === "FAILED" || task.status === "CANCELLED") return null; // a failure is explained by the error panel, never by a bar
  const track = "relative h-2 w-full overflow-hidden rounded bg-border";
  if (progress.mode === "determinate") {
    const done = task.status === "SUCCEEDED";
    const tone = progress.stalled ? "bg-amber-500" : done ? "bg-green-500" : "bg-accent";
    return (
      <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress.percentage ?? 0)} aria-valuetext={`${progress.completedUnits} of ${progress.totalUnits}`} className={track}>
        <div className={`h-full rounded transition-[width] duration-300 ease-out motion-reduce:transition-none ${tone}`} style={{ width: `${progress.percentage}%` }} />
      </div>
    );
  }
  if (progress.mode === "indeterminate") {
    return (
      <div role="progressbar" aria-label={`${label} - in progress, duration not known`} aria-busy="true" className={track}>
        <div className={`absolute inset-y-0 left-0 w-1/3 rounded animate-indeterminate motion-reduce:left-1/3 motion-reduce:animate-none motion-reduce:opacity-60 ${progress.stalled ? "bg-amber-500" : "bg-accent"}`} />
      </div>
    );
  }
  return null;
}

const STATUS_CHIP: Record<TaskStatus, { label: string; tone: string }> = {
  QUEUED: { label: "queued", tone: TONES.NEUTRAL },
  RUNNING: { label: "running", tone: TONES.BLUE },
  SUCCEEDED: { label: "done", tone: TONES.GREEN },
  FAILED: { label: "failed", tone: TONES.RED },
  CANCELLED: { label: "cancelled", tone: TONES.NEUTRAL },
};

/** One task: what it is, where it is, how far (only if measurable), how long (real time), and - when it failed - why and what to do. */
export function TaskCard({ task, subjectLink }: { task: TaskDto; subjectLink?: { href: string; label: string } }) {
  const now = useNow(1000);
  const p = computeProgress(
    { status: task.status, completedUnits: task.progress.completedUnits, totalUnits: task.progress.totalUnits, startedAt: task.startedAt, finishedAt: task.finishedAt, lastProgressAt: task.lastProgressAt },
    now,
  );
  const chip = STATUS_CHIP[task.status];
  const active = task.status === "QUEUED" || task.status === "RUNNING";
  const label = TASK_LABEL[task.type] ?? task.type;
  const silentMs = task.lastProgressAt ? now.getTime() - new Date(task.lastProgressAt).getTime() : null;

  return (
    <article className="rounded border border-border bg-surface p-4" aria-label={`${label}: ${chip.label}`}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          {label}
          <Chip tone={chip.tone}>{chip.label}</Chip>
          {task.attempts > 1 && <Chip title="The job was retried after an interruption">attempt {task.attempts}</Chip>}
        </div>
        {subjectLink && <Link href={subjectLink.href} className="text-xs text-muted hover:text-foreground">{subjectLink.label}</Link>}
      </div>

      {active && (
        <>
          <ProgressBar task={task} now={now} label={label} />
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
            <span aria-live="polite">
              {task.stage ?? "Working"}
              {task.stageDetail ? <span className="ml-1 text-foreground/70">· {task.stageDetail}</span> : null}
            </span>
            <span>
              {p.mode === "determinate" ? `${p.completedUnits} of ${p.totalUnits}${task.unit ? ` ${task.unit}` : ""} · ${p.percentage}%` : p.completedUnits > 0 ? `${p.completedUnits}${task.unit ? ` ${task.unit}` : ""} so far` : "progress not measurable"}
              {p.elapsedMs !== null ? ` · ${formatElapsed(p.elapsedMs)}` : ""}
            </span>
          </div>
          {p.stalled && (
            <p className="mt-2 rounded border border-amber-900 bg-amber-950/40 px-2 py-1 text-xs text-amber-400">
              No update for {formatElapsed(silentMs)}. The worker may have stopped; the job resumes automatically when it is running again.
            </p>
          )}
          {p.inconsistent && <p className="mt-2 text-xs text-amber-400">The reported progress is inconsistent (more done than the total); the bar is capped.</p>}
        </>
      )}

      {task.status === "SUCCEEDED" && (
        <div className="text-xs text-muted">
          {p.mode === "determinate" ? `${p.completedUnits} of ${p.totalUnits}${task.unit ? ` ${task.unit}` : ""} processed` : "Finished"}
          {p.elapsedMs !== null ? ` · took ${formatElapsed(p.elapsedMs)}` : ""}
        </div>
      )}

      {task.status === "FAILED" && task.error && (
        <div role="alert" className="rounded border border-red-900 bg-red-950/40 p-3 text-sm">
          <p className="text-red-300">{task.error.message ?? "The task failed."}</p>
          {task.error.remedy && <p className="mt-1 text-foreground"><span className="text-muted">What to do: </span>{task.error.remedy}</p>}
          <details className="mt-2 text-xs text-muted">
            <summary className="cursor-pointer">Details</summary>
            {task.error.code} · attempt {task.attempts} · {task.finishedAt ? new Date(task.finishedAt).toLocaleString() : ""}
          </details>
        </div>
      )}
    </article>
  );
}

// ------------------------------------------------------------------------------------------------ uploads (real byte progress)

export interface UploadResponse {
  duplicate: boolean;
  pack?: PackDto;
  asset?: AssetDto;
  task?: TaskDto;
}

/**
 * Uploads one file with XMLHttpRequest, because fetch cannot report how many bytes actually left the browser. The
 * numbers passed to onProgress are the browser's own (loaded / total bytes): real, not estimated. The cookie session
 * is sent exactly as for every other API call.
 */
export function uploadWithProgress(file: File, fields: Record<string, string>, onProgress: (loaded: number, total: number) => void, signal?: AbortSignal): Promise<UploadResponse> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_BASE_URL}/api/media/uploads`);
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded, e.total);
    };
    xhr.onerror = () => reject(new ApiError(0, "NETWORK_ERROR", "Could not reach the server. Check your connection and try again."));
    xhr.onabort = () => reject(new ApiError(0, "ABORTED", "The upload was cancelled."));
    xhr.onload = () => {
      let body: { success?: boolean; data?: UploadResponse; error?: { code: string; message: string; details?: { packId?: string } } } = {};
      try {
        body = JSON.parse(xhr.responseText) as typeof body;
      } catch {
        /* not JSON */
      }
      if (xhr.status >= 200 && xhr.status < 300 && body.success && body.data) resolve(body.data);
      else reject(new ApiError(xhr.status, body.error?.code ?? "UPLOAD_FAILED", body.error?.message ?? `The upload failed (HTTP ${xhr.status}).`));
    };
    signal?.addEventListener("abort", () => xhr.abort());
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v); // fields first: the server reads them before the file arrives
    form.append("file", file, file.name);
    xhr.send(form);
  });
}

export const ACCEPT = ".zip,.mp4,.mov,.jpg,.jpeg,.png,.webp,.mp3,.wav,.txt,.csv,.xlsx";
