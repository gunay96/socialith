"use client";

import { useEffect, useState } from "react";
import { ApiError, apiPut } from "@/lib/api";
import { useCurrentUser } from "@/lib/auth-context";
import { Banner, Card, Chip, TONES, inputClass, useFetch } from "@/lib/upload-post";
import type { PublishingSettings } from "@/lib/publishing";

interface CampaignSettings {
  organizationDefault: boolean;
  items: { id: string; name: string; status: string; autoScheduleOnApproval: boolean | null; effective: boolean }[];
}

type Draft = Omit<PublishingSettings, "source" | "recommendation">;

export default function PublishingSettingsPage() {
  const me = useCurrentUser();
  const isAdmin = me.role === "ADMIN" || me.role === "OWNER";
  const { data, error, loading, reload } = useFetch<PublishingSettings>("/api/publishing/settings");
  const campaigns = useFetch<CampaignSettings>("/api/publishing/campaigns");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (data) {
      const { source: _source, recommendation: _recommendation, ...rest } = data;
      void _source;
      void _recommendation;
      setDraft(rest);
    }
  }, [data]);

  async function save() {
    if (!draft) return;
    setBusy(true);
    setMessage(null);
    try {
      await apiPut("/api/publishing/settings", draft);
      setMessage({ tone: "ok", text: "Settings saved." });
      reload();
      campaigns.reload();
    } catch (err) {
      setMessage({ tone: "error", text: err instanceof ApiError ? err.message : "Could not save." });
    } finally {
      setBusy(false);
    }
  }

  async function setCampaign(id: string, value: boolean | null) {
    try {
      await apiPut(`/api/publishing/campaigns/${id}`, { autoScheduleOnApproval: value });
      campaigns.reload();
    } catch (err) {
      setMessage({ tone: "error", text: err instanceof ApiError ? err.message : "Could not change the campaign setting." });
    }
  }

  if (loading && !data) return <p className="text-sm text-muted">Loading…</p>;
  if (error || !data || !draft) return <Banner tone="error">{error ?? "Could not load settings."}</Banner>;
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const num = (key: keyof Draft, label: string, hint: string, min: number, max: number) => (
    <label className="flex flex-col gap-1 text-sm">
      {label}
      <input type="number" min={min} max={max} disabled={!isAdmin} value={draft[key] as number} onChange={(e) => set({ [key]: Number(e.target.value) } as Partial<Draft>)} className={`${inputClass} w-32`} />
      <span className="text-xs text-muted">{hint}</span>
    </label>
  );
  const check = (key: "requireApproval" | "allowSelfApproval" | "autoScheduleOnApproval", label: string, hint: string) => (
    <label className="flex items-start gap-3 text-sm">
      <input type="checkbox" className="mt-1" disabled={!isAdmin} checked={draft[key]} onChange={(e) => set({ [key]: e.target.checked } as Partial<Draft>)} />
      <span>{label}<span className="block text-xs text-muted">{hint}</span></span>
    </label>
  );

  return (
    <div className="flex flex-col gap-4">
      {data.recommendation && <Banner tone="warn">{data.recommendation}</Banner>}
      {!isAdmin && <Banner tone="info">Only admins can change these settings.</Banner>}
      {message && <Banner tone={message.tone}>{message.text}</Banner>}

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Approval">
          <div className="flex flex-col gap-4">
            {check("requireApproval", "Require approval before scheduling", "Every destination must be approved (individually) before it can be scheduled — including through the older content scheduling. Content edited after approval loses its approval.")}
            {check("allowSelfApproval", "Allow approving what you submitted yourself", "Switch off to force a second admin to approve. Every approval records who approved and when.")}
            {check("autoScheduleOnApproval", "Schedule automatically once approved (organization default)", "Only at the date and time a person already planned for that destination — never an invented time — and only if it passes the scheduling checks. A campaign can override this below.")}
          </div>
        </Card>

        <Card title="Time">
          <label className="flex flex-col gap-1 text-sm">
            Timezone for scheduling and the calendar
            <input disabled={!isAdmin} value={draft.timezone} onChange={(e) => set({ timezone: e.target.value })} className={`${inputClass} w-64`} />
            <span className="text-xs text-muted">IANA name, default Europe/Istanbul. Instants are stored in UTC; this zone is used to enter and display times and to decide what &quot;the same day&quot; means for the daily cap.</span>
          </label>
          <div className="mt-4">{num("minLeadMinutes", "Minimum lead time (minutes)", "A publication cannot be scheduled closer to now than this, so review, hand-off and media checks have time to complete.", 1, 1440)}</div>
        </Card>

        <Card title="Platform limits per destination">
          <div className="flex flex-wrap gap-6">
            {num("maxPostsPerDestinationPerDay", "Posts per destination per day", "Scheduled, in flight and published count; enforced when scheduling.", 1, 50)}
            {num("minMinutesBetweenPosts", "Minimum minutes between posts", "Keeps a page from being flooded. 0 switches the spacing rule off.", 0, 1440)}
          </div>
        </Card>

        <Card title="Repetitive distribution guard">
          <label className="mb-3 flex flex-col gap-1 text-sm">
            When several destinations of one platform get the same media with (nearly) the same text
            <select disabled={!isAdmin} value={draft.duplicateGuard} onChange={(e) => set({ duplicateGuard: e.target.value as Draft["duplicateGuard"] })} className={`${inputClass} w-64`}>
              <option value="BLOCK">Block (each page needs its own caption)</option>
              <option value="WARN">Warn only</option>
              <option value="OFF">Off</option>
            </select>
          </label>
          <div className="flex flex-wrap gap-6">
            {num("similarityThresholdPct", "Counts as the same at (%)", "Word-3-gram similarity of the captions.", 50, 100)}
            {num("maxSimilarPerPlatform", "Destinations allowed to share text", "Per content item and platform; 1 = every further destination needs its own text.", 1, 50)}
          </div>
          <p className="mt-3 text-xs text-muted">Socialith does not automate likes, comments, follows, views or any other engagement — only legitimate publishing of original or licensed content to authorized accounts.</p>
        </Card>
      </div>

      {isAdmin && (
        <div>
          <button onClick={save} disabled={busy} className="rounded bg-accent px-4 py-2 text-sm font-medium text-background disabled:opacity-40">{busy ? "Saving…" : "Save settings"}</button>
        </div>
      )}

      <Card title="Campaign automatic scheduling">
        <p className="mb-3 text-xs text-muted">Organization default: <Chip tone={campaigns.data?.organizationDefault ? TONES.GREEN : TONES.NEUTRAL}>{campaigns.data?.organizationDefault ? "on" : "off"}</Chip>. A campaign can follow it (inherit), or force automatic scheduling on or off for its publications.</p>
        {campaigns.data && campaigns.data.items.length === 0 && <p className="text-sm text-muted">No campaigns yet.</p>}
        <ul className="flex flex-col divide-y divide-border">
          {campaigns.data?.items.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm first:pt-0 last:pb-0">
              <span>{c.name} <span className="text-xs text-muted">· effective: {c.effective ? "automatic" : "manual"}</span></span>
              <select disabled={!isAdmin} value={c.autoScheduleOnApproval === null ? "inherit" : c.autoScheduleOnApproval ? "on" : "off"} onChange={(e) => setCampaign(c.id, e.target.value === "inherit" ? null : e.target.value === "on")} className={`${inputClass} py-1 text-sm`}>
                <option value="inherit">Inherit organization default</option>
                <option value="on">Automatic after approval</option>
                <option value="off">Manual scheduling only</option>
              </select>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
