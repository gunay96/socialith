"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiGet, ApiError, type DashboardData } from "@/lib/api";

function StatCard({ label, value, href }: { label: string; value: string | number; href?: string }) {
  const body = (
    <div className="rounded border border-border bg-surface p-4">
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold tracking-tight">{value}</div>
    </div>
  );
  return href ? (
    <Link href={href} className="block hover:border-foreground">
      {body}
    </Link>
  ) : (
    body
  );
}

function TopList({ title, items, hrefBase }: { title: string; items: { id: string; label: string; viewCount: number }[]; hrefBase: string }) {
  return (
    <div className="rounded border border-border bg-surface p-4">
      <h2 className="mb-3 text-sm font-semibold tracking-tight">{title}</h2>
      {items.length === 0 ? (
        <p className="text-sm text-muted">No synced views yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((item, i) => (
            <li key={item.id} className="flex items-center justify-between text-sm">
              <Link href={`${hrefBase}/${item.id}`} className="truncate hover:underline">
                {i + 1}. {item.label}
              </Link>
              <span className="text-muted">{item.viewCount.toLocaleString()} views</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet<DashboardData>("/api/dashboard")
      .then(setData)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Something went wrong."));
  }, []);

  if (error) return <p className="text-sm text-red-400">{error}</p>;
  if (!data) return <p className="text-sm text-muted">Loading…</p>;

  return (
    <div>
      <h1 className="mb-4 text-xl font-semibold tracking-tight">Dashboard</h1>

      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Connected accounts" value={`${data.accounts.connected} / ${data.accounts.total}`} href="/accounts" />
        <StatCard label="Active campaigns" value={data.activeCampaigns} href="/campaigns" />
        <StatCard label="Scheduled content" value={data.scheduledContent} href="/content" />
        <StatCard label="Publishing now" value={data.publishingNow} href="/content" />
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Published (30d)" value={data.publishedLast30d} />
        <StatCard label="Failed (30d)" value={data.failedLast30d} />
        <StatCard label="Views (published)" value={data.metrics.viewCount.toLocaleString()} />
        <StatCard label="Engagement (likes+comments+shares)" value={(data.metrics.likeCount + data.metrics.commentCount + data.metrics.shareCount).toLocaleString()} />
      </div>

      {(data.accounts.expired > 0 || data.accounts.error > 0) && (
        <p className="mb-4 rounded border border-yellow-900 bg-yellow-950/30 px-3 py-2 text-sm text-yellow-400">
          {data.accounts.expired + data.accounts.error} account{data.accounts.expired + data.accounts.error === 1 ? "" : "s"} need
          {data.accounts.expired + data.accounts.error === 1 ? "s" : ""} reconnecting.{" "}
          <Link href="/accounts?status=EXPIRED" className="underline">
            Review
          </Link>
        </p>
      )}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <TopList title="Top content by views" items={data.topContent} hrefBase="/content" />
        <TopList title="Top sounds by views" items={data.topSounds} hrefBase="/sounds" />
      </div>
    </div>
  );
}
