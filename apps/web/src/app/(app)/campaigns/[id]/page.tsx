"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  apiGet,
  apiPatch,
  buildQueryString,
  ApiError,
  CAMPAIGN_STATUSES,
  type Campaign,
  type CampaignStatus,
  type ListContentResult,
  type MetricsRollup,
} from "@/lib/api";
import { useCurrentUser } from "@/lib/auth-context";
import { CampaignPageNetwork } from "./campaign-pages";

export default function CampaignDetailPage({ params }: { params: { id: string } }) {
  const me = useCurrentUser();
  const canEdit = me.role !== "VIEWER";

  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [content, setContent] = useState<ListContentResult | null>(null);
  const [metrics, setMetrics] = useState<MetricsRollup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function load() {
    apiGet<Campaign>(`/api/campaigns/${params.id}`)
      .then(setCampaign)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Something went wrong."));
    apiGet<ListContentResult>(`/api/content${buildQueryString({ campaignId: params.id, pageSize: 50 })}`).then(setContent);
    apiGet<MetricsRollup>(`/api/analytics/campaigns/${params.id}`).then(setMetrics);
  }

  useEffect(load, [params.id]);

  async function handleStatusChange(next: CampaignStatus) {
    if (!campaign) return;
    setSaveError(null);
    setSaving(true);
    try {
      const updated = await apiPatch<Campaign>(`/api/campaigns/${params.id}`, { status: next });
      setCampaign(updated);
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setSaving(false);
    }
  }

  if (error) return <p className="text-sm text-red-400">{error}</p>;
  if (!campaign) return <p className="text-sm text-muted">Loading…</p>;

  return (
    <div className="max-w-2xl">
      <Link href="/campaigns" className="mb-4 inline-block text-sm text-muted hover:text-foreground">
        ← All campaigns
      </Link>

      <div className="mb-6 rounded border border-border bg-surface p-6">
        <h1 className="text-xl font-semibold tracking-tight">{campaign.name}</h1>
        {campaign.description && <p className="mt-1 text-sm text-muted">{campaign.description}</p>}

        <div className="mt-4 flex items-center gap-3 text-sm">
          <span className="text-muted">Status</span>
          {canEdit ? (
            <select
              value={campaign.status}
              disabled={saving}
              onChange={(e) => handleStatusChange(e.target.value as CampaignStatus)}
              className="rounded border border-border bg-background px-2 py-1 text-foreground outline-none focus:border-foreground"
            >
              {CAMPAIGN_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          ) : (
            <span>{campaign.status}</span>
          )}
        </div>
        {saveError && <p className="mt-2 text-sm text-red-400">{saveError}</p>}
      </div>

      <CampaignPageNetwork campaignId={params.id} />

      <h2 className="mb-3 text-sm font-medium text-muted">Performance (published posts only)</h2>
      {metrics && (
        <div className="mb-6 grid grid-cols-4 gap-3">
          <StatTile label="Views" value={metrics.viewCount} />
          <StatTile label="Likes" value={metrics.likeCount} />
          <StatTile label="Comments" value={metrics.commentCount} />
          <StatTile label="Shares" value={metrics.shareCount} />
        </div>
      )}

      <h2 className="mb-3 text-sm font-medium text-muted">Content in this campaign</h2>
      <div className="rounded border border-border bg-surface">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-border text-muted">
              <th className="px-4 py-2 font-normal">Caption</th>
              <th className="px-4 py-2 font-normal">Status</th>
              <th className="px-4 py-2 font-normal">Targets</th>
            </tr>
          </thead>
          <tbody>
            {content && content.items.length === 0 && (
              <tr>
                <td colSpan={3} className="px-4 py-6 text-center text-muted">
                  No content assigned to this campaign yet.
                </td>
              </tr>
            )}
            {content?.items.map((item) => (
              <tr key={item.id} className="border-b border-border last:border-0 hover:bg-background/40">
                <td className="px-4 py-2">
                  <Link href={`/content/${item.id}`} className="hover:underline">
                    {item.caption ?? <span className="text-muted">(no caption)</span>}
                  </Link>
                </td>
                <td className="px-4 py-2">{item.status}</td>
                <td className="px-4 py-2 text-muted">{item._count.targets}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded border border-border bg-surface p-4">
      <div className="text-2xl font-semibold tracking-tight">{value.toLocaleString()}</div>
      <div className="text-xs text-muted">{label}</div>
    </div>
  );
}
