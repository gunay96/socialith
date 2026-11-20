"use client";

import { useState } from "react";
import { buildQueryString } from "@/lib/api";
import { Banner, Chip, Pager, StatusBadge, TONES, formatDateTime, useFetch, type Overview, type Paged } from "@/lib/upload-post";

interface ScheduledRow {
  id: string;
  status: string;
  platform: string;
  profileUsername: string;
  scheduledFor: string | null;
  handedOffAt: string | null;
  providerJobId: string | null;
  externalId: string;
  lastErrorKind: string | null;
  lastErrorMessage: string | null;
  contentTarget: { id: string; content: { id: string; caption: string | null }; socialAccount: { handle: string } };
}

const PAGE_SIZE = 25;

export default function ScheduledPage() {
  const [page, setPage] = useState(1);
  const overview = useFetch<Overview>("/api/upload-post/overview");
  const { data, error, loading } = useFetch<Paged<ScheduledRow>>(`/api/upload-post/scheduled${buildQueryString({ page, pageSize: PAGE_SIZE })}`);
  const handoff = overview.data?.handoff;

  return (
    <div>
      <Banner tone="info">
        Socialith owns the master schedule. Only targets due within the hand-off window are given to Upload-Post&apos;s own scheduler, and while a target is listed here Socialith will not fire it itself — a target is never scheduled in both systems. Rescheduling or cancelling in Socialith updates or cancels the provider job automatically.
      </Banner>
      <div className="mb-4 flex items-center gap-2 text-sm">
        Hand-off:
        <Chip tone={handoff?.enabled ? TONES.BLUE : TONES.NEUTRAL}>{handoff ? (handoff.enabled ? `on · next ${handoff.windowHours} h` : "off") : "…"}</Chip>
        {handoff && !handoff.enabled && <span className="text-muted">— every scheduled publication is fired by Socialith at its time.</span>}
      </div>

      {error && <Banner tone="error">{error}</Banner>}
      {loading && !data && <p className="text-sm text-muted">Loading…</p>}
      {data && (
        <>
          <div className="overflow-x-auto rounded border border-border">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-border text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-3 py-2">Runs at</th>
                  <th className="px-3 py-2">Content</th>
                  <th className="px-3 py-2">Destination</th>
                  <th className="px-3 py-2">State</th>
                  <th className="px-3 py-2">Provider job</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((s) => (
                  <tr key={s.id} className="border-b border-border last:border-0 align-top">
                    <td className="px-3 py-2">{formatDateTime(s.scheduledFor)}<div className="text-xs text-muted">handed off {formatDateTime(s.handedOffAt)}</div></td>
                    <td className="max-w-[16rem] truncate px-3 py-2">{s.contentTarget.content.caption ?? "(no caption)"}</td>
                    <td className="px-3 py-2"><Chip>{s.platform}</Chip> @{s.contentTarget.socialAccount.handle.replace(/^@/, "")}<div className="font-mono text-xs text-muted">{s.profileUsername}</div></td>
                    <td className="px-3 py-2">
                      <StatusBadge status={s.status} />
                      {s.lastErrorMessage && <div className="mt-1 max-w-[16rem] text-xs text-red-400">{s.lastErrorKind}: {s.lastErrorMessage}</div>}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-muted">{s.providerJobId ?? "—"}</td>
                  </tr>
                ))}
                {data.items.length === 0 && (<tr><td colSpan={5} className="px-3 py-6 text-center text-muted">Nothing is currently handed to the provider scheduler.</td></tr>)}
              </tbody>
            </table>
          </div>
          <Pager page={page} total={data.total} pageSize={data.pageSize} onPage={setPage} />
        </>
      )}
    </div>
  );
}
