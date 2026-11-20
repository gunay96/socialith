"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { Banner, Card, Chip, TONES, useFetch } from "@/lib/upload-post";
import { IssueList, OwnerChip, PLATFORM_LABEL, PublicationActions, StateBadge, fmt, useTimezone, type PubDetail } from "@/lib/publishing";

function Row({ k, children, mono = false }: { k: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[11rem_1fr] gap-2 border-b border-border py-1.5 text-sm last:border-0">
      <dt className="text-muted">{k}</dt>
      <dd className={`break-all ${mono ? "font-mono text-xs" : ""}`}>{children}</dd>
    </div>
  );
}

export default function PublicationDetailPage() {
  const params = useParams<{ id: string }>();
  const tz = useTimezone();
  const { data: d, error, loading, reload } = useFetch<PubDetail>(`/api/publishing/publications/${params.id}`);
  if (loading && !d) return <p className="text-sm text-muted">Loading…</p>;
  if (error || !d) return <Banner tone="error">{error ?? "Publication not found."}</Banner>;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/publishing/publications" className="text-sm text-muted hover:text-foreground">← All publications</Link>
          <StateBadge state={d.state} />
          <OwnerChip owner={d.schedulingOwner} />
        </div>
      </div>

      <Card title={`@${d.destination.handle.replace(/^@/, "")} · ${PLATFORM_LABEL[d.destination.platform] ?? d.destination.platform}`}>
        <PublicationActions pub={d} tz={tz} onChanged={reload} />
        {d.errorMessage && <p className="mt-3 text-sm text-red-400">{d.errorMessage}</p>}
        {d.deliveryNote && <p className="mt-3 text-sm text-amber-400">{d.deliveryNote}</p>}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Publication report">
          <dl>
            <Row k="Publication ID" mono>{d.id}</Row>
            <Row k="Campaign">{d.campaign ? <>{d.campaign.name} <span className="font-mono text-xs text-muted">({d.campaign.id})</span></> : "—"}</Row>
            <Row k="Content asset" mono>{d.contentId}{d.content.assets.length ? ` · ${d.content.assets.map((a) => a.id).join(", ")}` : ""}</Row>
            <Row k="Destination ID" mono>{d.destination.id}</Row>
            <Row k="Provider">{d.destination.provider === "UPLOAD_POST" ? `Upload-Post${d.destination.profile ? ` (profile ${d.destination.profile.username})` : ""}` : "Native platform API"}</Row>
            <Row k="External job ID" mono>{d.provider?.jobId ?? d.provider?.requestId ?? d.externalPostId ?? "—"}</Row>
            {d.provider && <Row k="External / request ID" mono>{d.provider.externalId} · {d.provider.requestId}</Row>}
            <Row k="Platform">{PLATFORM_LABEL[d.destination.platform] ?? d.destination.platform}</Row>
            <Row k={`Scheduled time (${tz})`}>{fmt(d.scheduledAt, tz)}{d.scheduledAt ? <span className="ml-2 font-mono text-xs text-muted">{d.scheduledAt}</span> : null}</Row>
            <Row k="Actual publication time">{fmt(d.publishedAt, tz)}</Row>
            <Row k="Status"><StateBadge state={d.state} /> <span className="ml-2 text-xs text-muted">{d.provider ? `provider: ${d.provider.status.toLowerCase().replace(/_/g, " ")}` : ""}</span></Row>
            <Row k="Published URL">{d.externalPostUrl ? <a href={d.externalPostUrl} className="underline" target="_blank" rel="noreferrer">{d.externalPostUrl}</a> : "—"}</Row>
            <Row k="Failure reason">{d.errorMessage ?? d.provider?.lastErrorKind ?? "—"}</Row>
            <Row k="Retry count">{Math.max(0, d.attemptCount - 1)} <span className="text-xs text-muted">({d.attemptCount} attempt{d.attemptCount === 1 ? "" : "s"})</span></Row>
            <Row k="Creator / page">{d.destination.creator?.name ?? "—"} · {d.destination.managedPage?.name ?? "—"}</Row>
          </dl>
        </Card>

        <Card title="What will be published">
          <div className="whitespace-pre-wrap rounded border border-border p-3 text-sm">{d.effective.caption || <span className="text-muted">(no caption)</span>}</div>
          {d.effective.title && <p className="mt-2 text-sm"><span className="text-muted">Title:</span> {d.effective.title}</p>}
          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            {d.captionOverride ? <Chip tone={TONES.BLUE}>caption written for this destination</Chip> : <Chip>shared caption</Chip>}
            {d.track && <Chip>track: {d.track.title}{d.track.artist ? ` — ${d.track.artist}` : ""}</Chip>}
            {d.requireMusic && <Chip tone={TONES.AMBER}>track required</Chip>}
          </div>
          <div className="mt-3">
            <div className="mb-1 text-xs uppercase tracking-wide text-muted">Media</div>
            {d.content.assets.length ? d.content.assets.map((a) => <div key={a.id} className="font-mono text-xs">{a.type}{a.platform ? ` (${a.platform})` : ""} · {a.url}</div>) : <span className="text-sm text-muted">No media attached.</span>}
          </div>
          {d.provider?.notes && <p className="mt-3 text-xs text-amber-400">{d.provider.notes}</p>}
        </Card>
      </div>

      {d.validation && (
        <Card title="Platform checks">
          {d.validation.issues.length === 0 ? <p className="text-sm text-green-400">No problems found.</p> : <IssueList issues={d.validation.issues} />}
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Approval and operational history">
          <ol className="flex flex-col gap-2">
            {d.events.map((e) => (
              <li key={e.id} className="text-sm">
                <span className="text-xs text-muted">{fmt(e.createdAt, tz)}</span> · <strong>{e.type.replace(/_/g, " ").toLowerCase()}</strong>
                {e.fromState && e.toState && e.fromState !== e.toState ? <span className="text-muted"> ({e.fromState.toLowerCase().replace(/_/g, " ")} → {e.toState.toLowerCase().replace(/_/g, " ")})</span> : null}
                <span className="text-muted"> · {e.actor ? e.actor.name : "system"}</span>
                {e.reason && <div className="text-xs text-muted">“{e.reason}”</div>}
              </li>
            ))}
            {d.events.length === 0 && <li className="text-sm text-muted">No history yet.</li>}
          </ol>
          <div className="mt-3 border-t border-border pt-2 text-xs text-muted">
            Submitted: {d.submittedBy?.name ?? "—"} {d.submittedAt ? `· ${fmt(d.submittedAt, tz)}` : ""}<br />
            Approved: {d.approvedBy?.name ?? "—"} {d.approvedAt ? `· ${fmt(d.approvedAt, tz)}` : ""}
          </div>
        </Card>

        <Card title="Publish attempts (provider responses)">
          <ul className="flex flex-col gap-2">
            {d.attempts.map((a) => (
              <li key={a.id} className="text-sm">
                <Chip tone={a.status === "SUCCEEDED" ? TONES.GREEN : TONES.RED}>#{a.attemptNumber} {a.status}</Chip>
                <span className="ml-2 text-xs text-muted">{fmt(a.completedAt, tz)}</span>
                {a.errorCode && <div className="text-xs">{a.errorCode}{a.httpStatusCode ? ` · HTTP ${a.httpStatusCode}` : ""} · {a.retryable ? "retryable" : "permanent — not retried"}</div>}
                {a.errorMessage && <div className="text-xs text-muted">{a.errorMessage}</div>}
              </li>
            ))}
            {d.attempts.length === 0 && <li className="text-sm text-muted">No attempt has been made yet.</li>}
          </ul>
          <div className="mt-3 border-t border-border pt-2 text-xs text-muted">Content revisions reviewed: {d.revisions.length ? d.revisions.map((r) => `#${r.revision}`).join(", ") : "none yet"}</div>
        </Card>
      </div>
    </div>
  );
}
