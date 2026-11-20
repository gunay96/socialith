"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { ApiError } from "@/lib/api";
import { ACCEPT, TaskCard, formatBytes, uploadWithProgress, usePolling, useStudioRole, type PackDto, type Paged, type TaskDto, type UploadResponse } from "@/lib/studio";
import { Banner, Card, Chip, TONES, inputClass, useFetch } from "@/lib/upload-post";

const EXTENSIONS = ACCEPT.split(",");
const POLL_MS = 2000;

type ItemState = "waiting" | "uploading" | "uploaded" | "duplicate" | "error";
interface Item {
  key: string;
  file: File;
  state: ItemState;
  loaded: number;
  total: number;
  error?: string;
  existingPackId?: string;
  result?: UploadResponse;
}

const isSupported = (name: string) => EXTENSIONS.includes(name.slice(name.lastIndexOf(".")).toLowerCase());

/** The server-side task of an uploaded file, followed live until it finishes (real worker progress, polled). */
function LiveTask({ taskId, link }: { taskId: string; link: { href: string; label: string } }) {
  const { data } = usePolling<TaskDto>(`/api/operations/tasks/${taskId}`, POLL_MS, (t) => t.status === "QUEUED" || t.status === "RUNNING");
  if (!data) return <p className="text-xs text-muted">Waiting for the worker…</p>;
  return <TaskCard task={data} subjectLink={link} />;
}

export default function UploadPage() {
  const { canEdit } = useStudioRole();
  const [items, setItems] = useState<Item[]>([]);
  const [dragging, setDragging] = useState(false);
  const [running, setRunning] = useState(false);
  const [packName, setPackName] = useState("");
  const [packId, setPackId] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const packs = useFetch<Paged<PackDto>>("/api/media/packs?pageSize=100");

  function add(files: FileList | File[]) {
    const next: Item[] = [...files].map((file) => ({
      key: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2, 7)}`,
      file,
      state: isSupported(file.name) ? "waiting" : "error",
      loaded: 0,
      total: file.size,
      ...(isSupported(file.name) ? {} : { error: `"${file.name}" is not a supported type. Accepted: ZIP, MP4, MOV, JPG, JPEG, PNG, WEBP, MP3, WAV, TXT, CSV, XLSX.` }),
    }));
    setItems((cur) => [...cur, ...next]);
  }

  const patch = (key: string, p: Partial<Item>) => setItems((cur) => cur.map((i) => (i.key === key ? { ...i, ...p } : i)));

  async function start(force = false) {
    setRunning(true);
    // one file at a time: a progress bar that means something, and no stampede on the server
    for (const item of items.filter((i) => i.state === "waiting" || (force && i.state === "duplicate"))) {
      patch(item.key, { state: "uploading", loaded: 0, error: undefined });
      try {
        const isZip = item.file.name.toLowerCase().endsWith(".zip");
        const fields: Record<string, string> = {
          ...(isZip && packName.trim() ? { packName: packName.trim() } : {}),
          ...(!isZip && packId ? { packId } : {}),
          ...(isZip && item.state === "duplicate" ? { force: "true" } : {}),
        };
        const result = await uploadWithProgress(item.file, fields, (loaded, total) => patch(item.key, { loaded, total }));
        patch(item.key, { state: "uploaded", loaded: item.file.size, result });
      } catch (err) {
        // 409 = the server recognised this exact archive: offer the one meaningful action instead of a dead end
        patch(item.key, { state: err instanceof ApiError && err.status === 409 ? "duplicate" : "error", error: err instanceof ApiError ? err.message : "The upload failed." });
      }
    }
    setRunning(false);
    packs.reload();
  }

  if (!canEdit) return <Banner tone="info">Uploading needs the editor role or above. You can browse the library.</Banner>;

  const waiting = items.filter((i) => i.state === "waiting").length;

  return (
    <div className="flex max-w-4xl flex-col gap-4">
      <Banner tone="info">
        ZIP packs are checked for unsafe content and unpacked in the background; the folder structure is kept, every file is validated, measured and given a thumbnail, and exact duplicates are recognised.
        Originals are stored untouched and privately.
      </Banner>

      <div
        role="button"
        tabIndex={0}
        aria-label="Choose files to upload, or drop them here"
        onClick={() => input.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            input.current?.click();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (e.dataTransfer.files.length) add(e.dataTransfer.files);
        }}
        className={`flex cursor-pointer flex-col items-center justify-center gap-1 rounded border-2 border-dashed p-10 text-center transition-colors motion-reduce:transition-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${dragging ? "border-accent bg-accent/10" : "border-border hover:border-foreground/40"}`}
      >
        <span className="text-sm font-medium">Drop files here, or click to choose</span>
        <span className="text-xs text-muted">ZIP · MP4 · MOV · JPG · PNG · WEBP · MP3 · WAV · TXT · CSV · XLSX</span>
        <input ref={input} type="file" multiple accept={ACCEPT} className="sr-only" tabIndex={-1} onChange={(e) => { if (e.target.files?.length) add(e.target.files); e.target.value = ""; }} />
      </div>

      <Card title="Options">
        <div className="grid gap-4 md:grid-cols-2 text-sm">
          <label className="flex flex-col gap-1">
            Name for new ZIP packs
            <input value={packName} onChange={(e) => setPackName(e.target.value)} maxLength={120} placeholder="the archive's file name" className={inputClass} />
          </label>
          <label className="flex flex-col gap-1">
            Add single files to a pack
            <select value={packId} onChange={(e) => setPackId(e.target.value)} className={inputClass}>
              <option value="">No pack</option>
              {packs.data?.items.filter((p) => p.status !== "ARCHIVED" && p.status !== "PROCESSING").map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
        </div>
      </Card>

      {items.length > 0 && (
        <Card
          title={`Files (${items.length})`}
          action={
            <div className="flex gap-2">
              <button onClick={() => setItems((cur) => cur.filter((i) => i.state === "uploading"))} disabled={running} className="rounded border border-border px-3 py-1.5 text-xs disabled:opacity-40">Clear</button>
              <button onClick={() => void start()} disabled={running || waiting === 0} className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-background disabled:opacity-40">
                {running ? "Uploading…" : `Upload ${waiting} file${waiting === 1 ? "" : "s"}`}
              </button>
            </div>
          }
        >
          <ul className="flex flex-col divide-y divide-border">
            {items.map((i) => (
              <li key={i.key} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span className="truncate font-medium" title={i.file.name}>{i.file.name}</span>
                  <span className="flex items-center gap-2 text-xs text-muted">
                    {formatBytes(i.file.size)}
                    {i.state === "waiting" && <Chip>ready</Chip>}
                    {i.state === "uploading" && <Chip tone={TONES.BLUE}>uploading</Chip>}
                    {i.state === "uploaded" && <Chip tone={i.result?.duplicate ? TONES.AMBER : TONES.GREEN}>{i.result?.duplicate ? "duplicate" : "uploaded"}</Chip>}
                    {i.state === "error" && <Chip tone={TONES.RED}>not uploaded</Chip>}
                  </span>
                </div>

                {i.state === "uploading" && (
                  <>
                    <div role="progressbar" aria-label={`Uploading ${i.file.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((i.loaded / Math.max(1, i.total)) * 100)} className="h-2 w-full overflow-hidden rounded bg-border">
                      <div className="h-full rounded bg-accent transition-[width] duration-200 motion-reduce:transition-none" style={{ width: `${(i.loaded / Math.max(1, i.total)) * 100}%` }} />
                    </div>
                    <div className="text-xs text-muted">{formatBytes(i.loaded)} of {formatBytes(i.total)} sent · {Math.round((i.loaded / Math.max(1, i.total)) * 100)}%</div>
                  </>
                )}

                {i.state === "error" && (
                  <div role="alert" className="rounded border border-red-900 bg-red-950/40 p-2 text-xs">
                    <p className="text-red-300">{i.error}</p>
                  </div>
                )}
                {i.state === "duplicate" && (
                  <div className="text-xs text-muted">
                    {i.error ?? "This archive was already uploaded."}
                    <button onClick={() => void start(true)} disabled={running} className="ml-2 underline disabled:opacity-40">Process it again anyway</button>
                  </div>
                )}

                {i.state === "uploaded" && i.result?.duplicate && (
                  <p className="text-xs text-muted">The same file is already in the library{i.result.asset?.duplicateOf ? <> (<Link href={`/studio/assets/${i.result.asset.duplicateOf.id}`} className="underline">{i.result.asset.duplicateOf.originalName ?? "open it"}</Link>)</> : null}; nothing was stored a second time.</p>
                )}
                {i.state === "uploaded" && i.result?.task && (
                  <LiveTask
                    taskId={i.result.task.id}
                    link={i.result.pack ? { href: `/studio/packs/${i.result.pack.id}`, label: "Open pack" } : { href: `/studio/assets/${i.result.asset?.id ?? ""}`, label: "Open file" }}
                  />
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
