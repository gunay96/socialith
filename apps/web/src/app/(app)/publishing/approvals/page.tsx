"use client";

import { useState } from "react";
import Link from "next/link";
import { Banner, Card, Chip, TONES, useFetch } from "@/lib/upload-post";
import { IssueList, PLATFORM_LABEL, PublicationActions, StateBadge, fmt, useTimezone, type Pub, type PubDetail, type PubPage } from "@/lib/publishing";

function ReviewCard({ pub, tz, onChanged }: { pub: Pub; tz: string; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const detail = useFetch<PubDetail>(open ? `/api/publishing/publications/${pub.id}` : null);
  const d = detail.data;
  return (
    <Card
      title={`@${pub.destination.handle.replace(/^@/, "")} · ${PLATFORM_LABEL[pub.destination.platform] ?? pub.destination.platform}`}
      action={<StateBadge state={pub.state} />}
    >
      <div className="mb-2 text-sm">
        <div className="whitespace-pre-wrap">{pub.effective.caption || <span className="text-muted">(no caption)</span>}</div>
        {pub.effective.title && <div className="mt-1 text-xs text-muted">Title: {pub.effective.title}</div>}
      </div>
      <div className="mb-3 flex flex-wrap gap-2 text-xs text-muted">
        <span>{pub.campaign ? `Campaign: ${pub.campaign.name}` : "No campaign"}</span>
        {pub.track && <span>Track: {pub.track.title}{pub.track.artist ? ` — ${pub.track.artist}` : ""}</span>}
        <span>Planned: {fmt(pub.scheduledAt, tz)}</span>
        {pub.captionOverride && <Chip tone={TONES.BLUE}>caption written for this destination</Chip>}
        {pub.requireMusic && <Chip>track required</Chip>}
      </div>
      <button onClick={() => setOpen(!open)} className="mb-3 text-xs text-muted underline hover:text-foreground">{open ? "Hide checks" : "Show platform checks, media and history"}</button>
      {open && (
        <div className="mb-3 rounded border border-border p-3">
          {detail.loading && !d && <p className="text-sm text-muted">Loading…</p>}
          {detail.error && <Banner tone="error">{detail.error}</Banner>}
          {d && (
            <div className="flex flex-col gap-3 text-sm">
              <div>
                <div className="mb-1 text-xs uppercase tracking-wide text-muted">Platform checks</div>
                {d.validation && d.validation.issues.length > 0 ? <IssueList issues={d.validation.issues} compact /> : <span className="text-green-400">No problems found.</span>}
              </div>
              <div>
                <div className="mb-1 text-xs uppercase tracking-wide text-muted">Media</div>
                {d.content.assets.length ? d.content.assets.map((a) => <div key={a.id} className="font-mono text-xs">{a.type} · {a.url}</div>) : <span className="text-muted">No media attached.</span>}
              </div>
              <div>
                <div className="mb-1 text-xs uppercase tracking-wide text-muted">History</div>
                {d.events.slice(0, 6).map((e) => <div key={e.id} className="text-xs"><span className="text-muted">{fmt(e.createdAt, tz)}</span> · {e.type.replace(/_/g, " ").toLowerCase()}{e.actor ? ` by ${e.actor.name}` : ""}{e.reason ? ` — ${e.reason}` : ""}</div>)}
              </div>
              <Link href={`/publishing/publications/${pub.id}`} className="text-xs underline">Open the full publication</Link>
            </div>
          )}
        </div>
      )}
      <PublicationActions pub={pub} tz={tz} onChanged={onChanged} />
    </Card>
  );
}

export default function ApprovalCenterPage() {
  const tz = useTimezone();
  const review = useFetch<PubPage>("/api/publishing/publications?state=READY_FOR_REVIEW&sort=scheduledAt_asc&pageSize=50");
  const decided = useFetch<PubPage>("/api/publishing/publications?state=APPROVED,REJECTED&pageSize=15");
  const reload = () => {
    review.reload();
    decided.reload();
  };

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted">
        Every destination is reviewed and approved <strong>on its own</strong> — there is no bulk approval. Approving pins exactly what you reviewed: if the text or media changes afterwards, the approval is withdrawn and nothing is published. Rejecting needs a reason; the author sees it and can correct and resubmit.
      </p>
      {review.error && <Banner tone="error">{review.error}</Banner>}
      <section>
        <h2 className="mb-3 text-sm font-semibold">Awaiting review{review.data ? ` (${review.data.total})` : ""}</h2>
        {review.loading && !review.data && <p className="text-sm text-muted">Loading…</p>}
        {review.data && review.data.items.length === 0 && <p className="text-sm text-muted">Nothing is waiting for review.</p>}
        <div className="grid gap-4 lg:grid-cols-2">
          {review.data?.items.map((p) => <ReviewCard key={p.id} pub={p} tz={tz} onChanged={reload} />)}
        </div>
      </section>
      <section>
        <h2 className="mb-3 text-sm font-semibold">Recently decided</h2>
        <ul className="flex flex-col divide-y divide-border rounded border border-border">
          {decided.data?.items.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
              <Link href={`/publishing/publications/${p.id}`} className="hover:underline">@{p.destination.handle.replace(/^@/, "")} · {PLATFORM_LABEL[p.destination.platform] ?? p.destination.platform}</Link>
              <span className="flex items-center gap-2"><StateBadge state={p.state} /><span className="text-xs text-muted">{fmt(p.approvedAt ?? p.updatedAt, tz)}</span></span>
            </li>
          ))}
          {decided.data && decided.data.items.length === 0 && <li className="px-3 py-3 text-sm text-muted">No decisions yet.</li>}
        </ul>
      </section>
    </div>
  );
}
