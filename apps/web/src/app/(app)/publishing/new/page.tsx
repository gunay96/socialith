"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ApiError, apiGet, apiPatch, apiPost, buildQueryString, type ContentDetail, type ListContentResult, type ListSoundsResult } from "@/lib/api";
import { Banner, Card, Chip, TONES, inputClass, useFetch } from "@/lib/upload-post";
import {
  DestinationPicker,
  IssueList,
  PLATFORM_LABEL,
  PublicationActions,
  StateBadge,
  explainError,
  parseLocalDateTime,
  readStoredSelection,
  storeSelection,
  toLocalInputValue,
  useTimezone,
  type DestinationPage,
  ValidationSummary,
  type Issue,
  type Pub,
  type PubDetail,
  type Validation,
} from "@/lib/publishing";

interface Draft {
  captionOverride: string;
  titleOverride: string;
  requireMusic: boolean;
  when: string; // datetime-local in the organization timezone
}
interface Created {
  publication: Pub;
  validation: Validation;
}

function ResultRow({ initial, tz }: { initial: Created; tz: string }) {
  const [pub, setPub] = useState<Pub>(initial.publication);
  const [validation, setValidation] = useState<Validation>(initial.validation);
  async function refresh() {
    const d = await apiGet<PubDetail>(`/api/publishing/publications/${pub.id}`);
    setPub(d);
    if (d.validation) setValidation(d.validation);
  }
  return (
    <li className="rounded border border-border p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="font-medium">@{pub.destination.handle.replace(/^@/, "")}</span>
        <span className="text-xs text-muted">{PLATFORM_LABEL[pub.destination.platform] ?? pub.destination.platform}</span>
        <StateBadge state={pub.state} />
        <Link href={`/publishing/publications/${pub.id}`} className="ml-auto text-xs underline">Open</Link>
      </div>
      <div className="mb-2"><ValidationSummary validation={validation} /></div>
      <PublicationActions pub={pub} tz={tz} onChanged={() => void refresh()} size="sm" />
    </li>
  );
}

export default function NewPublicationPage() {
  const tz = useTimezone();
  const [campaignFilter, setCampaignFilter] = useState("");
  const [contentId, setContentId] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [baseWhen, setBaseWhen] = useState("");
  const [stagger, setStagger] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; issues: Issue[] } | null>(null);
  const [results, setResults] = useState<{ created: Created[]; skipped: { socialAccountId: string; reason: string }[] } | null>(null);

  useEffect(() => {
    const stored = readStoredSelection();
    setSelected(stored);
    const date = new URLSearchParams(window.location.search).get("date");
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) setBaseWhen(`${date}T12:00`);
  }, []);

  const campaigns = useFetch<{ items: { id: string; name: string }[] }>(`/api/campaigns${buildQueryString({ pageSize: 100 })}`);
  const contents = useFetch<ListContentResult>(`/api/content${buildQueryString({ pageSize: 50, campaignId: campaignFilter || undefined })}`);
  const content = useFetch<ContentDetail>(contentId ? `/api/content/${contentId}` : null);
  const sounds = useFetch<ListSoundsResult>(`/api/sounds${buildQueryString({ pageSize: 200, status: "ACTIVE" })}`);
  const chosen = useFetch<DestinationPage>(selected.length ? `/api/publishing/destinations${buildQueryString({ ids: selected.join(","), pageSize: 100 })}` : null);

  const change = (ids: string[]) => {
    setSelected(ids);
    storeSelection(ids);
  };
  const destinations = useMemo(() => (chosen.data?.items ?? []).filter((d) => selected.includes(d.id)), [chosen.data, selected]);
  const draft = (id: string): Draft => drafts[id] ?? { captionOverride: "", titleOverride: "", requireMusic: false, when: "" };
  const setDraft = (id: string, patch: Partial<Draft>) => setDrafts((d) => ({ ...d, [id]: { ...draft(id), ...patch } }));

  /** Fill every destination's time from one base time, optionally staggered (a legitimate way to spread posts out). */
  function applyTimes() {
    const base = parseLocalDateTime(baseWhen, tz);
    if (!base) {
      setError({ message: "Enter a valid base date and time.", issues: [] });
      return;
    }
    setError(null);
    setDrafts((prev) => {
      const next = { ...prev };
      destinations.forEach((d, i) => {
        next[d.id] = { ...(prev[d.id] ?? { captionOverride: "", titleOverride: "", requireMusic: false, when: "" }), when: toLocalInputValue(new Date(base.getTime() + i * stagger * 60_000), tz) };
      });
      return next;
    });
  }

  async function changeTrack(soundId: string) {
    if (!contentId) return;
    try {
      await apiPatch(`/api/content/${contentId}`, { soundId: soundId || null });
      content.reload();
    } catch (err) {
      setError({ message: err instanceof ApiError ? err.message : "Could not change the track.", issues: [] });
    }
  }

  const baseCaption = content.data?.caption ?? "";
  const track = content.data?.sound ?? null;
  const ready = Boolean(contentId) && destinations.length > 0;

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const body = {
        contentId,
        destinations: destinations.map((d) => {
          const x = draft(d.id);
          const at = x.when ? parseLocalDateTime(x.when, tz) : null;
          return {
            socialAccountId: d.id,
            captionOverride: x.captionOverride.trim() ? x.captionOverride : null,
            titleOverride: x.titleOverride.trim() ? x.titleOverride : null,
            requireMusic: x.requireMusic,
            scheduledAt: at ? at.toISOString() : null,
            timezone: tz,
          };
        }),
      };
      const r = await apiPost<{ created: Created[]; skipped: { socialAccountId: string; reason: string }[] }>("/api/publishing/publications", body);
      setResults(r);
      storeSelection([]);
      setSelected([]);
    } catch (err) {
      setError(explainError(err));
    } finally {
      setBusy(false);
    }
  }

  if (results) {
    return (
      <div className="flex flex-col gap-4">
        <Banner tone="ok">{results.created.length} publication{results.created.length === 1 ? "" : "s"} created as drafts. Each is independent: submit, approve and schedule them one by one below.</Banner>
        {results.skipped.map((s) => <Banner key={s.socialAccountId} tone="warn">{s.reason}</Banner>)}
        <ul className="flex flex-col gap-3">{results.created.map((c) => <ResultRow key={c.publication.id} initial={c} tz={tz} />)}</ul>
        <div className="flex gap-3 text-sm">
          <Link href="/publishing/approvals" className="underline">Approval Center</Link>
          <Link href="/publishing/queue" className="underline">Publishing Queue</Link>
          <button onClick={() => setResults(null)} className="text-muted underline">Create more</button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">
        Publish an existing content item to one or more authorized destinations. Every destination becomes its <strong>own publication</strong> with its own text, its own approval and its own time. Originality matters: write a caption for each page rather than sending identical posts everywhere — the platform checks will say when texts are too alike.
      </p>
      {error && (
        <div>
          <Banner tone="error">{error.message}</Banner>
          <IssueList issues={error.issues} compact />
        </div>
      )}

      <Card title="1 · Content and campaign">
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-muted">
            Campaign
            <select value={campaignFilter} onChange={(e) => { setCampaignFilter(e.target.value); setContentId(""); }} className={`${inputClass} py-1.5 text-sm`}>
              <option value="">All campaigns</option>
              {campaigns.data?.items.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
        </div>
        <div className="max-h-64 overflow-y-auto rounded border border-border">
          {contents.data?.items.map((c) => (
            <label key={c.id} className={`flex cursor-pointer items-start gap-3 border-b border-border px-3 py-2 text-sm last:border-0 ${contentId === c.id ? "bg-accent/10" : ""}`}>
              <input type="radio" name="content" checked={contentId === c.id} onChange={() => setContentId(c.id)} className="mt-1" />
              <span>
                <span className="line-clamp-2">{c.caption || "(no caption)"}</span>
                <span className="text-xs text-muted">{c.status.toLowerCase()} · {c._count.targets} destination{c._count.targets === 1 ? "" : "s"}</span>
              </span>
            </label>
          ))}
          {contents.data && contents.data.items.length === 0 && <p className="px-3 py-4 text-sm text-muted">No content yet. Create content (and attach its video or images) on the Content page first.</p>}
        </div>
        {content.data && (
          <div className="mt-3 text-sm">
            <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted">
              <span>{content.data.assets.length} media file{content.data.assets.length === 1 ? "" : "s"}</span>
              <span>{content.data.variations.length} platform description{content.data.variations.length === 1 ? "" : "s"}</span>
              <Link href={`/content/${content.data.id}`} className="underline">Open content</Link>
            </div>
            <label className="flex flex-col gap-1 text-xs text-muted">
              Track (artist and song; the music id is attached on TikTok only when it is verified and its rights are confirmed)
              <select value={content.data.soundId ?? ""} onChange={(e) => void changeTrack(e.target.value)} className={`${inputClass} w-full max-w-md py-1.5 text-sm`}>
                <option value="">No track</option>
                {sounds.data?.items.map((s) => <option key={s.id} value={s.id}>{s.title}{s.artist ? ` — ${s.artist}` : ""} ({PLATFORM_LABEL[s.platform] ?? s.platform})</option>)}
              </select>
            </label>
            {track && <p className="mt-1 text-xs text-muted">Changing the track changes what would be published: pending approvals of this content must be given again.</p>}
          </div>
        )}
      </Card>

      <Card title="2 · Destinations">
        <DestinationPicker selected={selected} onChange={change} />
      </Card>

      {destinations.length > 0 && (
        <Card title="3 · Text, track and time for each destination">
          <div className="mb-4 flex flex-wrap items-end gap-3 rounded border border-border p-3">
            <label className="flex flex-col gap-1 text-xs text-muted">
              First time ({tz})
              <input type="datetime-local" value={baseWhen} onChange={(e) => setBaseWhen(e.target.value)} className={`${inputClass} py-1.5 text-sm`} />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted">
              Stagger each next destination by (minutes)
              <input type="number" min={0} max={1440} value={stagger} onChange={(e) => setStagger(Math.max(0, Number(e.target.value)))} className={`${inputClass} w-28 py-1.5 text-sm`} />
            </label>
            <button onClick={applyTimes} disabled={!baseWhen} className="rounded border border-border px-3 py-1.5 text-sm hover:border-foreground disabled:opacity-40">Apply to all</button>
            <span className="text-xs text-muted">The time is only a plan until the publication is approved and scheduled.</span>
          </div>
          <ul className="flex flex-col gap-4">
            {destinations.map((d) => {
              const x = draft(d.id);
              const text = x.captionOverride.trim() ? x.captionOverride : baseCaption;
              return (
                <li key={d.id} className="rounded border border-border p-3">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <span className="font-medium">@{d.handle.replace(/^@/, "")}</span>
                    <span className="text-xs text-muted">{PLATFORM_LABEL[d.platform] ?? d.platform}</span>
                    {d.ready ? <Chip tone={TONES.GREEN}>READY</Chip> : <Chip tone={TONES.RED}>NOT READY</Chip>}
                    <button onClick={() => change(selected.filter((id) => id !== d.id))} className="ml-auto text-xs text-muted underline hover:text-foreground">Remove</button>
                  </div>
                  {d.problems.map((p) => <div key={p.code} className="mb-1 text-xs text-red-400">{p.message}</div>)}
                  <div className="grid gap-3 md:grid-cols-2">
                    <label className="flex flex-col gap-1 text-xs text-muted">
                      {d.platform === "YOUTUBE" ? "Description for this channel" : "Caption for this page"} (leave empty to use the content&apos;s text)
                      <textarea rows={3} value={x.captionOverride} onChange={(e) => setDraft(d.id, { captionOverride: e.target.value })} className={`${inputClass} text-sm`} placeholder={baseCaption} />
                    </label>
                    <div className="flex flex-col gap-3">
                      {d.platform === "YOUTUBE" && (
                        <label className="flex flex-col gap-1 text-xs text-muted">
                          Title (max 100)
                          <input value={x.titleOverride} onChange={(e) => setDraft(d.id, { titleOverride: e.target.value })} className={`${inputClass} py-1.5 text-sm`} />
                        </label>
                      )}
                      <label className="flex flex-col gap-1 text-xs text-muted">
                        Planned time ({tz})
                        <input type="datetime-local" value={x.when} onChange={(e) => setDraft(d.id, { when: e.target.value })} className={`${inputClass} py-1.5 text-sm`} />
                      </label>
                      {d.platform === "TIKTOK" && track && (
                        <label className="flex items-start gap-2 text-xs">
                          <input type="checkbox" className="mt-0.5" checked={x.requireMusic} onChange={(e) => setDraft(d.id, { requireMusic: e.target.checked })} />
                          <span>Require the track “{track.title}” — do not publish without it<span className="block text-muted">{d.supports.music ? "This account reports the music capability." : "This account does not report the music capability."}</span></span>
                        </label>
                      )}
                    </div>
                  </div>
                  <div className="mt-3 rounded bg-background/40 p-2 text-xs"><div className="mb-1 uppercase tracking-wide text-muted">Preview — what will be published</div><div className="whitespace-pre-wrap">{text || <span className="text-muted">(no text)</span>}</div></div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      <div className="flex items-center gap-3">
        <button disabled={!ready || busy} onClick={() => void create()} className="rounded bg-accent px-4 py-2 text-sm font-medium text-background disabled:opacity-40">
          {busy ? "Creating…" : `4 · Create ${destinations.length || ""} publication${destinations.length === 1 ? "" : "s"}`}
        </button>
        <span className="text-xs text-muted">They start as drafts: nothing is scheduled or published by creating them.</span>
      </div>
    </div>
  );
}
