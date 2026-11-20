"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { addDays, addMonths, monthGrid, viewRange, weekDays, zonedDayKey, formatTimeInZone } from "@socialith/publishing";
import { Banner, Card, Chip, TONES, useFetch } from "@/lib/upload-post";
import { EMPTY_FILTERS, FilterBar, OwnerChip, PLATFORM_LABEL, PublicationActions, StateBadge, filtersToQuery, fmt, useTimezone, type FilterValues, type PubDetail, type PublicationState } from "@/lib/publishing";

type View = "day" | "week" | "month";
interface CalItem {
  id: string;
  state: PublicationState;
  schedulingOwner: "SOCIALITH" | "PROVIDER" | "NONE";
  scheduledAt: string | null;
  platform: string;
  handle: string;
  snippet: string;
  campaign: { name: string } | null;
}
interface Feed {
  items: CalItem[];
  truncated: boolean;
  timezone: string;
}

const TONE: Record<string, string> = {
  PUBLISHED: "border-green-900 bg-green-950/40 text-green-300",
  FAILED: "border-red-900 bg-red-950/40 text-red-300",
  STALE: "border-amber-900 bg-amber-950/40 text-amber-300",
  HELD: "border-amber-900 bg-amber-950/40 text-amber-300",
  DRAFT: "border-border bg-surface text-muted",
  READY_FOR_REVIEW: "border-amber-900 bg-amber-950/20 text-amber-300",
  APPROVED: "border-green-900 bg-green-950/20 text-green-300",
  REJECTED: "border-red-900 bg-red-950/20 text-red-300",
};
const toneOf = (s: PublicationState) => TONE[s] ?? "border-sky-900 bg-sky-950/40 text-sky-300";
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function title(view: View, key: string): string {
  const d = new Date(`${key}T12:00:00Z`);
  if (view === "month") return new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(d);
  if (view === "day") return new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(d);
  const days = weekDays(key);
  const f = (k: string) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${k}T12:00:00Z`));
  return `${f(days[0]!)} – ${f(days[6]!)} ${days[6]!.slice(0, 4)}`;
}

export default function CalendarPage() {
  const tz = useTimezone();
  const today = zonedDayKey(new Date(), tz);
  const [view, setView] = useState<View>("month");
  const [anchor, setAnchor] = useState<string | null>(null);
  const [filters, setFilters] = useState<FilterValues>(EMPTY_FILTERS);
  const [selected, setSelected] = useState<string | null>(null);
  const key = anchor ?? today;

  const range = useMemo(() => viewRange(view, key, tz), [view, key, tz]);
  const query = filtersToQuery({ ...filters, state: "", from: "", to: "" }, tz, { from: range.from.toISOString(), to: range.to.toISOString() });
  const feed = useFetch<Feed>(`/api/publishing/calendar${query}`);
  const detail = useFetch<PubDetail>(selected ? `/api/publishing/publications/${selected}` : null);

  const byDay = useMemo(() => {
    const m = new Map<string, CalItem[]>();
    for (const it of feed.data?.items ?? []) {
      if (!it.scheduledAt) continue;
      const k = zonedDayKey(new Date(it.scheduledAt), tz);
      (m.get(k) ?? m.set(k, []).get(k)!).push(it);
    }
    return m;
  }, [feed.data, tz]);

  const step = (dir: -1 | 1) => setAnchor(view === "month" ? addMonths(key, dir) : addDays(key, dir * (view === "week" ? 7 : 1)));
  const month = key.slice(0, 7);

  const Item = ({ it }: { it: CalItem }) => (
    <button
      onClick={() => setSelected(it.id)}
      title={`${it.snippet || "(no text)"} — ${it.state}${it.schedulingOwner === "PROVIDER" ? " — runs on the Upload-Post scheduler" : ""}`}
      className={`flex w-full items-center gap-1 truncate rounded border px-1.5 py-0.5 text-left text-[11px] ${toneOf(it.state)} ${selected === it.id ? "ring-1 ring-foreground" : ""}`}
    >
      <span className="font-mono">{it.scheduledAt ? formatTimeInZone(new Date(it.scheduledAt), tz) : "--:--"}</span>
      <span className="truncate">@{it.handle.replace(/^@/, "")}</span>
      {it.schedulingOwner === "PROVIDER" && <span className="ml-auto rounded bg-sky-900/60 px-1" aria-label="provider-scheduled">P</span>}
    </button>
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button onClick={() => step(-1)} className="rounded border border-border px-3 py-1.5 text-sm hover:border-foreground" aria-label="Previous">‹</button>
          <button onClick={() => setAnchor(null)} className="rounded border border-border px-3 py-1.5 text-sm hover:border-foreground">Today</button>
          <button onClick={() => step(1)} className="rounded border border-border px-3 py-1.5 text-sm hover:border-foreground" aria-label="Next">›</button>
          <h2 className="ml-2 text-lg font-semibold tracking-tight">{title(view, key)}</h2>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex overflow-hidden rounded border border-border text-sm">
            {(["day", "week", "month"] as const).map((v) => (
              <button key={v} onClick={() => setView(v)} className={`px-3 py-1.5 capitalize ${view === v ? "bg-accent/15 text-foreground" : "text-muted hover:text-foreground"}`}>{v}</button>
            ))}
          </div>
          <Link href={`/publishing/new?date=${view === "month" ? (key.startsWith(today.slice(0, 7)) ? today : `${month}-01`) : key}`} className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-background">Create schedule</Link>
        </div>
      </div>

      <FilterBar value={filters} onChange={setFilters} hide={["state", "from", "to"]} />
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted">
        <span>Times in <strong>{tz}</strong>.</span>
        <span className="flex items-center gap-1"><Chip tone={TONES.NEUTRAL}>SOCIALITH QUEUE</Chip> Socialith fires it</span>
        <span className="flex items-center gap-1"><span className="rounded bg-sky-900/60 px-1">P</span> handed to the Upload-Post scheduler (Socialith stays the master)</span>
      </div>
      {feed.error && <Banner tone="error">{feed.error}</Banner>}
      {feed.data?.truncated && <Banner tone="warn">This view holds more publications than can be drawn; narrow it with the filters.</Banner>}

      {view === "month" && (
        <div className="overflow-x-auto rounded border border-border">
          <div className="grid min-w-[44rem] grid-cols-7 border-b border-border text-xs uppercase tracking-wide text-muted">
            {WEEKDAYS.map((d) => <div key={d} className="px-2 py-1.5">{d}</div>)}
          </div>
          {monthGrid(key).map((week, wi) => (
            <div key={wi} className="grid min-w-[44rem] grid-cols-7 border-b border-border last:border-0">
              {week.map((day) => {
                const items = byDay.get(day) ?? [];
                const inMonth = day.startsWith(month);
                return (
                  <div key={day} className={`min-h-24 border-r border-border p-1.5 last:border-0 ${inMonth ? "" : "bg-background/40 text-muted"}`}>
                    <div className="mb-1 flex items-center justify-between text-xs">
                      <button onClick={() => { setAnchor(day); setView("day"); }} className={`rounded px-1 ${day === today ? "bg-accent text-background" : "hover:underline"}`}>{Number(day.slice(8))}</button>
                      <Link href={`/publishing/new?date=${day}`} className="text-muted hover:text-foreground" aria-label={`Create a publication on ${day}`}>+</Link>
                    </div>
                    <div className="flex flex-col gap-0.5">
                      {items.slice(0, 4).map((it) => <Item key={it.id} it={it} />)}
                      {items.length > 4 && <button onClick={() => { setAnchor(day); setView("day"); }} className="text-left text-[11px] text-muted hover:text-foreground">+{items.length - 4} more</button>}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}

      {view === "week" && (
        <div className="overflow-x-auto rounded border border-border">
          <div className="grid min-w-[44rem] grid-cols-7">
            {weekDays(key).map((day, i) => (
              <div key={day} className="min-h-48 border-r border-border p-2 last:border-0">
                <button onClick={() => { setAnchor(day); setView("day"); }} className={`mb-2 text-xs ${day === today ? "font-semibold text-accent" : "text-muted"}`}>{WEEKDAYS[i]} {Number(day.slice(8))}</button>
                <div className="flex flex-col gap-1">{(byDay.get(day) ?? []).map((it) => <Item key={it.id} it={it} />)}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {view === "day" && (
        <Card title={title("day", key)}>
          {(byDay.get(key) ?? []).length === 0 && <p className="text-sm text-muted">Nothing scheduled for this day. <Link href={`/publishing/new?date=${key}`} className="underline">Create a publication</Link>.</p>}
          <ul className="flex flex-col gap-2">
            {(byDay.get(key) ?? []).map((it) => (
              <li key={it.id} className="flex flex-wrap items-center gap-3 text-sm">
                <span className="w-14 font-mono text-xs">{it.scheduledAt ? formatTimeInZone(new Date(it.scheduledAt), tz) : "--:--"}</span>
                <StateBadge state={it.state} />
                <OwnerChip owner={it.schedulingOwner} />
                <button onClick={() => setSelected(it.id)} className="hover:underline">@{it.handle.replace(/^@/, "")} · {PLATFORM_LABEL[it.platform] ?? it.platform}</button>
                <span className="max-w-md truncate text-xs text-muted">{it.snippet}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {selected && (
        <Card title="Publication details" action={<button onClick={() => setSelected(null)} className="text-xs text-muted hover:text-foreground">Close</button>}>
          {detail.loading && !detail.data && <p className="text-sm text-muted">Loading…</p>}
          {detail.error && <Banner tone="error">{detail.error}</Banner>}
          {detail.data && (
            <div className="flex flex-col gap-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">@{detail.data.destination.handle.replace(/^@/, "")}</span>
                <span className="text-xs text-muted">{PLATFORM_LABEL[detail.data.destination.platform] ?? detail.data.destination.platform}</span>
                <StateBadge state={detail.data.state} />
                <OwnerChip owner={detail.data.schedulingOwner} />
                <Link href={`/publishing/publications/${detail.data.id}`} className="ml-auto text-xs underline">Open the full publication</Link>
              </div>
              <div className="text-xs text-muted">Scheduled {fmt(detail.data.scheduledAt, tz)}{detail.data.provider?.jobId ? ` · provider job ${detail.data.provider.jobId}` : ""}{detail.data.campaign ? ` · ${detail.data.campaign.name}` : ""}</div>
              <div className="whitespace-pre-wrap rounded border border-border p-2">{detail.data.effective.caption || <span className="text-muted">(no caption)</span>}</div>
              {detail.data.errorMessage && <p className="text-xs text-red-400">{detail.data.errorMessage}</p>}
              <PublicationActions pub={detail.data} tz={tz} onChanged={() => { detail.reload(); feed.reload(); }} />
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
