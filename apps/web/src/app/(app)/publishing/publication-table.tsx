"use client";

import Link from "next/link";
import { Pager } from "@/lib/upload-post";
import { OwnerChip, PLATFORM_LABEL, PublicationActions, StateBadge, fmt, type Pub } from "@/lib/publishing";

/** The one table every Publishing Center list uses (queue, scheduled, failed, all). */
export function PublicationTable({
  items,
  tz,
  onChanged,
  showReason = false,
  total,
  page,
  pageSize,
  onPage,
  emptyText = "Nothing here.",
}: {
  items: Pub[];
  tz: string;
  onChanged: () => void;
  showReason?: boolean;
  total?: number;
  page?: number;
  pageSize?: number;
  onPage?: (p: number) => void;
  emptyText?: string;
}) {
  return (
    <>
      <div className="overflow-x-auto rounded border border-border">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-border text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-3 py-2">Destination</th>
              <th className="px-3 py-2">Content</th>
              <th className="px-3 py-2">Scheduled ({tz})</th>
              <th className="px-3 py-2">Status</th>
              {showReason && <th className="px-3 py-2">Reason</th>}
              <th className="px-3 py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.map((p) => (
              <tr key={p.id} className="border-b border-border align-top last:border-0">
                <td className="px-3 py-2">
                  <div className="font-medium">@{p.destination.handle.replace(/^@/, "")}</div>
                  <div className="text-xs text-muted">{PLATFORM_LABEL[p.destination.platform] ?? p.destination.platform}{p.destination.creator ? ` · ${p.destination.creator.name}` : ""}{p.destination.managedPage ? ` · ${p.destination.managedPage.name}` : ""}</div>
                </td>
                <td className="max-w-xs px-3 py-2">
                  <Link href={`/publishing/publications/${p.id}`} className="line-clamp-2 hover:underline">{p.effective.caption || p.effective.title || "(no text)"}</Link>
                  <div className="text-xs text-muted">{p.campaign ? p.campaign.name : "no campaign"}{p.track ? ` · ${p.track.title}${p.track.artist ? ` — ${p.track.artist}` : ""}` : ""}</div>
                </td>
                <td className="whitespace-nowrap px-3 py-2">{fmt(p.scheduledAt, tz)}</td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap items-center gap-1"><StateBadge state={p.state} /><OwnerChip owner={p.schedulingOwner} /></div>
                  {p.attemptCount > 0 && <div className="mt-1 text-xs text-muted">{p.attemptCount} attempt{p.attemptCount === 1 ? "" : "s"}</div>}
                </td>
                {showReason && <td className="max-w-xs px-3 py-2 text-xs text-red-400">{p.errorMessage ?? p.provider?.lastErrorKind ?? ""}</td>}
                <td className="px-3 py-2"><PublicationActions pub={p} tz={tz} onChanged={onChanged} size="sm" /></td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr><td colSpan={showReason ? 6 : 5} className="px-3 py-6 text-center text-muted">{emptyText}</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {total !== undefined && page !== undefined && pageSize !== undefined && onPage && <Pager page={page} total={total} pageSize={pageSize} onPage={onPage} />}
    </>
  );
}
