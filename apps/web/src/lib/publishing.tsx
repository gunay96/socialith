"use client";

import { useEffect, useState } from "react";
import { ApiError, apiGet, apiPost, buildQueryString } from "@/lib/api";
import { useCurrentUser } from "@/lib/auth-context";
import { Banner, Chip, TONES, inputClass, useFetch } from "@/lib/upload-post";
import { DEFAULT_TIMEZONE, STATE_LABELS, formatInZone, parseLocalDateTime, toLocalInputValue, type PublicationAction, type PublicationState } from "@socialith/publishing";

/** Shapes returned by /api/publishing/* (apps/api/src/services/publishing-*.ts). Only what the UI reads. */

export type { PublicationState, PublicationAction };

export interface Issue {
  code: string;
  severity: "ERROR" | "WARNING" | "INFO";
  field: string;
  message: string;
}
export interface Validation {
  ok: boolean;
  issues: Issue[];
}

export interface Pub {
  id: string;
  contentId: string;
  campaign: { id: string; name: string } | null;
  track: { id: string; title: string; artist: string | null } | null;
  destination: {
    id: string;
    platform: string;
    handle: string;
    displayName: string;
    status: string;
    provider: "NATIVE" | "UPLOAD_POST";
    profile: { id: string; username: string } | null;
    creator: { id: string; name: string } | null;
    managedPage: { id: string; name: string } | null;
  };
  state: PublicationState;
  stateLabel: string;
  approvalStatus: string;
  exception: string | null;
  allowedActions: PublicationAction[];
  scheduledAt: string | null;
  scheduledTimezone: string | null;
  publishedAt: string | null;
  schedulingOwner: "SOCIALITH" | "PROVIDER" | "NONE";
  externalPostId: string | null;
  externalPostUrl: string | null;
  errorMessage: string | null;
  deliveryNote: string | null;
  attemptCount: number;
  captionOverride: string | null;
  titleOverride: string | null;
  requireMusic: boolean;
  effective: { caption: string | null; title: string | null };
  submittedAt: string | null;
  approvedAt: string | null;
  provider: { kind: "UPLOAD_POST"; mode: string; status: string; externalId: string; requestId: string; jobId: string | null; scheduledFor: string | null; notes: string | null; lastErrorKind: string | null } | null;
  createdAt: string;
  updatedAt: string;
}

export interface PubDetail extends Pub {
  timezone: string;
  submittedBy: { id: string; name: string | null } | null;
  approvedBy: { id: string; name: string | null } | null;
  providerOwned: boolean;
  content: { id: string; caption: string | null; status: string; siblingPublications: number; assets: { id: string; type: string; platform: string | null; url: string; metadata: unknown }[] };
  validation: Validation | null;
  events: { id: string; type: string; fromState: string | null; toState: string | null; reason: string | null; createdAt: string; actor: { id: string; name: string } | null }[];
  attempts: { id: string; attemptNumber: number; status: string; errorCode: string | null; errorMessage: string | null; retryable: boolean | null; httpStatusCode: number | null; startedAt: string; completedAt: string; externalPostUrl: string | null }[];
  revisions: { revision: number; reason: string | null; createdAt: string; createdBy: { id: string; name: string } | null }[];
}

export interface PubPage {
  items: Pub[];
  total: number;
  page: number;
  pageSize: number;
  timezone: string;
}

export interface Destination {
  id: string;
  platform: string;
  handle: string;
  displayName: string;
  status: string;
  provider: string;
  profile: { id: string; username: string } | null;
  creator: { id: string; name: string } | null;
  managedPage: { id: string; name: string } | null;
  ready: boolean;
  problems: { code: string; message: string }[];
  supports: { music: boolean; images: boolean; video: boolean };
  today: { count: number; cap: number; capReached: boolean };
}
export interface DestinationPage {
  items: Destination[];
  total: number;
  page: number;
  pageSize: number;
}

export interface PublishingSettings {
  source: "default" | "configured";
  timezone: string;
  requireApproval: boolean;
  allowSelfApproval: boolean;
  autoScheduleOnApproval: boolean;
  duplicateGuard: "BLOCK" | "WARN" | "OFF";
  similarityThresholdPct: number;
  maxSimilarPerPlatform: number;
  maxPostsPerDestinationPerDay: number;
  minMinutesBetweenPosts: number;
  minLeadMinutes: number;
  recommendation: string | null;
}

// ----------------------------------------------------------------------------------------------- presentation

const STATE_TONES: Record<PublicationState, string> = {
  DRAFT: TONES.NEUTRAL,
  READY_FOR_REVIEW: TONES.AMBER,
  APPROVED: TONES.GREEN,
  SCHEDULED: TONES.BLUE,
  QUEUED: TONES.BLUE,
  PUBLISHING: TONES.BLUE,
  PUBLISHED: TONES.GREEN,
  REJECTED: TONES.RED,
  FAILED: TONES.RED,
  CANCELLED: TONES.NEUTRAL,
  STALE: TONES.AMBER,
  HELD: TONES.AMBER,
};

export function StateBadge({ state }: { state: PublicationState }) {
  return <Chip tone={STATE_TONES[state]}>{STATE_LABELS[state].toUpperCase()}</Chip>;
}

/** Who holds the clock of a scheduled publication: Socialith's own queue or the Upload-Post scheduler. */
export function OwnerChip({ owner }: { owner: Pub["schedulingOwner"] }) {
  if (owner === "NONE") return null;
  return owner === "PROVIDER" ? (
    <Chip tone={TONES.BLUE} title="Handed off: Upload-Post's own scheduler will run it. Socialith's database stays the master and edits/cancels it there.">
      UPLOAD-POST SCHEDULER
    </Chip>
  ) : (
    <Chip tone={TONES.NEUTRAL} title="Socialith's own queue (BullMQ job) will run it at the scheduled time.">
      SOCIALITH QUEUE
    </Chip>
  );
}

export const PLATFORM_LABEL: Record<string, string> = { TIKTOK: "TikTok", INSTAGRAM: "Instagram", YOUTUBE: "YouTube" };

export function IssueList({ issues, compact = false }: { issues: Issue[]; compact?: boolean }) {
  if (issues.length === 0) return null;
  const tone = { ERROR: TONES.RED, WARNING: TONES.AMBER, INFO: TONES.NEUTRAL } as const;
  return (
    <ul className={`flex flex-col ${compact ? "gap-1" : "gap-2"} text-sm`}>
      {issues.map((i, n) => (
        <li key={`${i.code}-${n}`} className="flex items-start gap-2">
          <Chip tone={tone[i.severity]}>{i.severity}</Chip>
          <span>{i.message}</span>
        </li>
      ))}
    </ul>
  );
}

/** A user-facing message plus the validation issues an API refusal carried. */
export function explainError(err: unknown): { message: string; issues: Issue[] } {
  if (err instanceof ApiError) {
    const details = err.details as { issues?: Issue[] } | undefined;
    return { message: err.message, issues: details?.issues ?? [] };
  }
  return { message: "Something went wrong.", issues: [] };
}

// ----------------------------------------------------------------------------------------------- time

let cachedTimezone: string | null = null;

/** The organization's publishing timezone (default Europe/Istanbul). */
export function useTimezone(): string {
  const [tz, setTz] = useState(cachedTimezone ?? DEFAULT_TIMEZONE);
  useEffect(() => {
    if (cachedTimezone) return;
    apiGet<PublishingSettings>("/api/publishing/settings")
      .then((s) => {
        cachedTimezone = s.timezone;
        setTz(s.timezone);
      })
      .catch(() => undefined);
  }, []);
  return tz;
}

export function fmt(iso: string | null | undefined, tz: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : formatInZone(d, tz);
}

export { parseLocalDateTime, toLocalInputValue };

// ----------------------------------------------------------------------------------------------- filters

export interface FilterValues {
  artist: string;
  campaignId: string;
  platform: string;
  creatorId: string;
  managedPageId: string;
  state: string;
  from: string;
  to: string;
}
export const EMPTY_FILTERS: FilterValues = { artist: "", campaignId: "", platform: "", creatorId: "", managedPageId: "", state: "", from: "", to: "" };

/** Dates are entered as local days in the organization's timezone and sent as UTC instants. */
export function filtersToQuery(f: FilterValues, tz: string, extra: Record<string, string | number | undefined> = {}): string {
  const from = f.from ? parseLocalDateTime(`${f.from}T00:00`, tz) : null;
  const to = f.to ? parseLocalDateTime(`${f.to}T23:59`, tz) : null;
  return buildQueryString({
    artist: f.artist || undefined,
    campaignId: f.campaignId || undefined,
    platform: f.platform || undefined,
    creatorId: f.creatorId || undefined,
    managedPageId: f.managedPageId || undefined,
    state: f.state || undefined,
    from: from?.toISOString(),
    to: to ? new Date(to.getTime() + 60_000).toISOString() : undefined,
    ...extra,
  });
}

export function FilterBar({ value, onChange, hide = [] }: { value: FilterValues; onChange: (v: FilterValues) => void; hide?: (keyof FilterValues)[] }) {
  const campaigns = useFetch<{ items: { id: string; name: string }[] }>(`/api/campaigns${buildQueryString({ pageSize: 100 })}`);
  const creators = useFetch<{ id: string; name: string }[]>("/api/creators");
  const pages = useFetch<{ id: string; name: string }[]>("/api/managed-pages");
  const set = (patch: Partial<FilterValues>) => onChange({ ...value, ...patch });
  const show = (k: keyof FilterValues) => !hide.includes(k);
  const select = (label: string, key: keyof FilterValues, options: { value: string; label: string }[]) =>
    show(key) && (
      <label className="flex flex-col gap-1 text-xs text-muted">
        {label}
        <select value={value[key]} onChange={(e) => set({ [key]: e.target.value })} className={`${inputClass} py-1.5 text-sm`}>
          <option value="">All</option>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
    );
  return (
    <div className="mb-4 flex flex-wrap items-end gap-3 rounded border border-border bg-surface p-3">
      {show("artist") && (
        <label className="flex flex-col gap-1 text-xs text-muted">
          Artist (track artist text)
          <input value={value.artist} onChange={(e) => set({ artist: e.target.value })} placeholder="e.g. Wave Theory" className={`${inputClass} w-44 py-1.5 text-sm`} />
        </label>
      )}
      {select("Campaign", "campaignId", (campaigns.data?.items ?? []).map((c) => ({ value: c.id, label: c.name })))}
      {select("Platform", "platform", Object.entries(PLATFORM_LABEL).map(([v, l]) => ({ value: v, label: l })))}
      {select("Creator", "creatorId", (creators.data ?? []).map((c) => ({ value: c.id, label: c.name })))}
      {select("Managed page", "managedPageId", (pages.data ?? []).map((c) => ({ value: c.id, label: c.name })))}
      {select("Status", "state", Object.entries(STATE_LABELS).map(([v, l]) => ({ value: v, label: l })))}
      {show("from") && (
        <label className="flex flex-col gap-1 text-xs text-muted">
          From
          <input type="date" value={value.from} onChange={(e) => set({ from: e.target.value })} className={`${inputClass} py-1.5 text-sm`} />
        </label>
      )}
      {show("to") && (
        <label className="flex flex-col gap-1 text-xs text-muted">
          To
          <input type="date" value={value.to} onChange={(e) => set({ to: e.target.value })} className={`${inputClass} py-1.5 text-sm`} />
        </label>
      )}
      <button onClick={() => onChange(EMPTY_FILTERS)} className="rounded border border-border px-3 py-1.5 text-sm text-muted hover:text-foreground">
        Clear
      </button>
    </div>
  );
}

// ----------------------------------------------------------------------------------------------- actions

type Busy = string | null;

/**
 * The actions an operator may take on ONE publication — exactly the ones the server says are allowed for its state.
 * Approving is one request per publication (there is no bulk approval, by design). Server refusals are shown verbatim,
 * with the validation issues that caused them.
 */
export function PublicationActions({ pub, tz, onChanged, size = "md" }: { pub: Pub; tz: string; onChanged: () => void; size?: "sm" | "md" }) {
  const me = useCurrentUser();
  const isAdmin = me.role === "ADMIN" || me.role === "OWNER";
  const canEdit = isAdmin || me.role === "EDITOR";
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<{ message: string; issues: Issue[] } | null>(null);
  const [form, setForm] = useState<null | "schedule" | "reject" | "cancel" | "hold">(null);
  const [reason, setReason] = useState("");
  const [when, setWhen] = useState(pub.scheduledAt ? toLocalInputValue(new Date(pub.scheduledAt), tz) : "");
  const a = new Set(pub.allowedActions);
  const btn = `rounded border border-border ${size === "sm" ? "px-2 py-1 text-xs" : "px-3 py-1.5 text-sm"} hover:border-foreground disabled:opacity-40`;

  async function run(action: string, body?: unknown) {
    setBusy(action);
    setError(null);
    try {
      await apiPost(`/api/publishing/publications/${pub.id}/${action}`, body ?? {});
      setForm(null);
      setReason("");
      onChanged();
    } catch (err) {
      setError(explainError(err));
    } finally {
      setBusy(null);
    }
  }

  function submitSchedule() {
    const at = parseLocalDateTime(when, tz);
    if (!at) {
      setError({ message: "Enter a valid date and time.", issues: [] });
      return;
    }
    void run("schedule", { scheduledAt: at.toISOString(), timezone: tz });
  }

  if (!canEdit) return <span className="text-xs text-muted">View only</span>;
  const none = !(a.has("SUBMIT") || a.has("WITHDRAW") || a.has("APPROVE") || a.has("REJECT") || a.has("SCHEDULE") || a.has("RESCHEDULE") || a.has("UNSCHEDULE") || a.has("HOLD") || a.has("RELEASE") || a.has("CANCEL") || a.has("REOPEN") || a.has("RETRY"));

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5">
        {a.has("SUBMIT") && <button className={btn} disabled={busy !== null} onClick={() => run("submit")}>Submit for review</button>}
        {a.has("WITHDRAW") && <button className={btn} disabled={busy !== null} onClick={() => run("withdraw")}>Withdraw</button>}
        {a.has("APPROVE") && isAdmin && <button className={`${btn} border-green-900 text-green-400`} disabled={busy !== null} onClick={() => run("approve")}>Approve</button>}
        {a.has("REJECT") && isAdmin && <button className={`${btn} border-red-900 text-red-400`} disabled={busy !== null} onClick={() => setForm(form === "reject" ? null : "reject")}>Reject…</button>}
        {(a.has("SCHEDULE") || a.has("RESCHEDULE")) && <button className={btn} disabled={busy !== null} onClick={() => setForm(form === "schedule" ? null : "schedule")}>{a.has("RESCHEDULE") ? "Reschedule…" : "Schedule…"}</button>}
        {a.has("RELEASE") && <button className={btn} disabled={busy !== null} onClick={() => run("release")}>Release</button>}
        {a.has("HOLD") && <button className={btn} disabled={busy !== null} onClick={() => setForm(form === "hold" ? null : "hold")}>Hold…</button>}
        {a.has("UNSCHEDULE") && <button className={btn} disabled={busy !== null} onClick={() => run("unschedule")}>Unschedule</button>}
        {a.has("RETRY") && <button className={btn} disabled={busy !== null} onClick={() => run("retry")}>{pub.state === "STALE" ? "Publish now" : "Retry"}</button>}
        {a.has("REOPEN") && <button className={btn} disabled={busy !== null} onClick={() => run("reopen")}>Reopen</button>}
        {a.has("CANCEL") && <button className={`${btn} text-red-400`} disabled={busy !== null} onClick={() => setForm(form === "cancel" ? null : "cancel")}>Cancel…</button>}
        {none && <span className="text-xs text-muted">No actions available in this state.</span>}
      </div>

      {form === "schedule" && (
        <div className="flex flex-wrap items-end gap-2 rounded border border-border p-2">
          <label className="flex flex-col gap-1 text-xs text-muted">
            Date and time ({tz})
            <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className={`${inputClass} py-1.5 text-sm`} />
          </label>
          <button className={btn} disabled={busy !== null || !when} onClick={submitSchedule}>{busy === "schedule" ? "Checking…" : "Confirm"}</button>
        </div>
      )}
      {(form === "reject" || form === "cancel" || form === "hold") && (
        <div className="flex flex-wrap items-end gap-2 rounded border border-border p-2">
          <label className="flex min-w-60 flex-1 flex-col gap-1 text-xs text-muted">
            {form === "reject" ? "Reason (required, shown to the author)" : "Reason (optional)"}
            <input value={reason} onChange={(e) => setReason(e.target.value)} className={`${inputClass} py-1.5 text-sm`} />
          </label>
          <button className={btn} disabled={busy !== null || (form === "reject" && reason.trim().length < 3)} onClick={() => run(form, { reason: reason.trim() || undefined })}>Confirm</button>
        </div>
      )}
      {error && (
        <div>
          <Banner tone="error">{error.message}</Banner>
          <IssueList issues={error.issues.filter((i) => i.severity === "ERROR")} compact />
        </div>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------------------------- destination picker

const SELECTION_KEY = "publishing.selectedDestinations";

export function readStoredSelection(): string[] {
  try {
    const raw = window.sessionStorage.getItem(SELECTION_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
export function storeSelection(ids: string[]): void {
  try {
    window.sessionStorage.setItem(SELECTION_KEY, JSON.stringify(ids));
  } catch {
    /* private mode: the picker still works, the selection just is not remembered */
  }
}

/** Search + filters over the organization's publishing destinations, with readiness and capability indicators. */
export function DestinationPicker({ selected, onChange }: { selected: string[]; onChange: (ids: string[]) => void }) {
  const [search, setSearch] = useState("");
  const [f, setF] = useState({ platform: "", creatorId: "", managedPageId: "", readyOnly: false });
  const [page, setPage] = useState(1);
  const creators = useFetch<{ id: string; name: string }[]>("/api/creators");
  const pages = useFetch<{ id: string; name: string }[]>("/api/managed-pages");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(t);
  }, [search]);
  const query = buildQueryString({ search: debounced || undefined, platform: f.platform || undefined, creatorId: f.creatorId || undefined, managedPageId: f.managedPageId || undefined, readyOnly: f.readyOnly ? "true" : undefined, page, pageSize: 25 });
  const { data, error, loading } = useFetch<DestinationPage>(`/api/publishing/destinations${query}`);
  const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  const pageCount = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-muted">
          Search
          <input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder="Handle or name…" className={`${inputClass} w-48 py-1.5 text-sm`} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">
          Platform
          <select value={f.platform} onChange={(e) => { setF({ ...f, platform: e.target.value }); setPage(1); }} className={`${inputClass} py-1.5 text-sm`}>
            <option value="">All</option>
            {Object.entries(PLATFORM_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">
          Creator
          <select value={f.creatorId} onChange={(e) => { setF({ ...f, creatorId: e.target.value }); setPage(1); }} className={`${inputClass} py-1.5 text-sm`}>
            <option value="">All</option>
            {(creators.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">
          Managed page
          <select value={f.managedPageId} onChange={(e) => { setF({ ...f, managedPageId: e.target.value }); setPage(1); }} className={`${inputClass} py-1.5 text-sm`}>
            <option value="">All</option>
            {(pages.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2 pb-2 text-sm">
          <input type="checkbox" checked={f.readyOnly} onChange={(e) => { setF({ ...f, readyOnly: e.target.checked }); setPage(1); }} />
          Ready to publish only
        </label>
      </div>
      {error && <Banner tone="error">{error}</Banner>}
      {loading && !data && <p className="text-sm text-muted">Loading…</p>}
      {data && (
        <>
          <div className="overflow-x-auto rounded border border-border">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-border text-xs uppercase tracking-wide text-muted">
                <tr><th className="w-8 px-3 py-2"></th><th className="px-3 py-2">Destination</th><th className="px-3 py-2">Creator / page</th><th className="px-3 py-2">Availability</th><th className="px-3 py-2">Capabilities</th><th className="px-3 py-2">Today</th></tr>
              </thead>
              <tbody>
                {data.items.map((d) => (
                  <tr key={d.id} className="border-b border-border align-top last:border-0">
                    <td className="px-3 py-2"><input type="checkbox" checked={selected.includes(d.id)} onChange={() => toggle(d.id)} aria-label={`Select ${d.handle}`} /></td>
                    <td className="px-3 py-2"><div className="font-medium">@{d.handle.replace(/^@/, "")}</div><div className="text-xs text-muted">{PLATFORM_LABEL[d.platform] ?? d.platform} · {d.provider === "UPLOAD_POST" ? "via Upload-Post" : "native"}</div></td>
                    <td className="px-3 py-2 text-xs">{d.creator?.name ?? <span className="text-muted">no creator</span>}<br />{d.managedPage?.name ?? <span className="text-muted">no page</span>}</td>
                    <td className="px-3 py-2">
                      {d.ready ? <Chip tone={TONES.GREEN}>READY</Chip> : <Chip tone={TONES.RED}>NOT READY</Chip>}
                      {d.problems.map((p) => <div key={p.code} className="mt-1 max-w-xs text-xs text-muted">{p.message}</div>)}
                    </td>
                    <td className="px-3 py-2"><div className="flex flex-wrap gap-1"><Chip>video</Chip>{d.supports.images && <Chip>photos</Chip>}{d.platform === "TIKTOK" && <Chip tone={d.supports.music ? TONES.GREEN : TONES.NEUTRAL} title="TikTok Commercial Music Library via Upload-Post">{d.supports.music ? "track ✓" : "no track"}</Chip>}</div></td>
                    <td className="px-3 py-2 text-xs"><span className={d.today.capReached ? "text-amber-400" : ""}>{d.today.count}/{d.today.cap}</span></td>
                  </tr>
                ))}
                {data.items.length === 0 && <tr><td colSpan={6} className="px-3 py-6 text-center text-muted">No destinations match.</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex items-center justify-between text-sm text-muted">
            <span>{data.total} destination{data.total === 1 ? "" : "s"} · {selected.length} selected</span>
            <span className="flex gap-2">
              <button disabled={page <= 1} onClick={() => setPage(page - 1)} className="rounded border border-border px-3 py-1 disabled:opacity-40">Previous</button>
              <button disabled={page >= pageCount} onClick={() => setPage(page + 1)} className="rounded border border-border px-3 py-1 disabled:opacity-40">Next</button>
            </span>
          </div>
        </>
      )}
    </div>
  );
}
