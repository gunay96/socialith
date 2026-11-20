"use client";

import { Banner, Card } from "@/lib/upload-post";
import { Freshness, TaskCard, usePolling, type TaskDto } from "@/lib/studio";

interface TaskList {
  items: TaskDto[];
  activeCount: number;
}

const ACTIVE_MS = 2000;
const FINISHED_MS = 6000;

function subjectLink(t: TaskDto): { href: string; label: string } | undefined {
  if (t.subject?.type === "MediaPack") return { href: `/studio/packs/${t.subject.id}`, label: "Open pack" };
  if (t.subject?.type === "MediaAsset") return { href: `/studio/assets/${t.subject.id}`, label: "Open file" };
  return undefined;
}

export default function ProcessingQueuePage() {
  const active = usePolling<TaskList>("/api/operations/tasks?state=active&limit=50", ACTIVE_MS);
  const finished = usePolling<TaskList>("/api/operations/tasks?state=finished&limit=15", FINISHED_MS);

  return (
    <div className="flex flex-col gap-4">
      {active.error && <Banner tone="error">{active.error}</Banner>}

      <Card title={`In progress${active.data ? ` (${active.data.items.length})` : ""}`} action={<Freshness updatedAt={active.updatedAt} intervalMs={ACTIVE_MS} />}>
        {active.loading && !active.data && <p className="text-sm text-muted">Loading…</p>}
        {active.data && active.data.items.length === 0 && <p className="text-sm text-muted">Nothing is running. Uploaded packs and files appear here while they are processed.</p>}
        <div className="flex flex-col gap-3">
          {active.data?.items.map((t) => <TaskCard key={t.id} task={t} subjectLink={subjectLink(t)} />)}
        </div>
        <p className="mt-3 text-xs text-muted">
          Bars show real progress reported by the worker (files done out of files found). When the amount of work is not known yet, the animation has no number.
        </p>
      </Card>

      <Card title="Recently finished" action={<Freshness updatedAt={finished.updatedAt} intervalMs={FINISHED_MS} />}>
        {finished.data && finished.data.items.length === 0 && <p className="text-sm text-muted">Nothing has finished yet.</p>}
        <div className="flex flex-col gap-3">
          {finished.data?.items.map((t) => <TaskCard key={t.id} task={t} subjectLink={subjectLink(t)} />)}
        </div>
      </Card>
    </div>
  );
}
