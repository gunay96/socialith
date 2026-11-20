/**
 * Timezone-aware date helpers on top of the IANA database that ships with the runtime (`Intl`), no dependency.
 * Instants are always UTC `Date`s; a "zoned" value is a wall-clock time in an IANA zone (default Europe/Istanbul).
 * A "day key" is `YYYY-MM-DD` in a zone and is plain calendar arithmetic (no zone needed once you have the key).
 */

export const DEFAULT_TIMEZONE = "Europe/Istanbul";

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatterCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    formatterCache.set(tz, f);
  }
  return f;
}

/** Wall-clock parts of an instant in `tz`. */
export function zonedParts(date: Date, tz: string): ZonedParts {
  const out: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(date)) if (p.type !== "literal") out[p.type] = Number(p.value);
  return { year: out.year!, month: out.month!, day: out.day!, hour: out.hour! % 24, minute: out.minute!, second: out.second! };
}

/** Offset of `tz` from UTC at an instant, in minutes (Istanbul: +180). */
export function tzOffsetMinutes(date: Date, tz: string): number {
  const p = zonedParts(date, tz);
  return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(date.getTime() / 1000) * 1000) / 60_000);
}

/**
 * Wall-clock time in `tz` → the UTC instant. A local time that does not exist (spring-forward gap) resolves to the
 * instant just after the gap; an ambiguous one (fall-back overlap) resolves to its first occurrence.
 */
export function zonedTimeToUtc(local: { year: number; month: number; day: number; hour?: number; minute?: number; second?: number }, tz: string): Date {
  const naive = Date.UTC(local.year, local.month - 1, local.day, local.hour ?? 0, local.minute ?? 0, local.second ?? 0);
  let guess = naive - tzOffsetMinutes(new Date(naive), tz) * 60_000;
  const second = naive - tzOffsetMinutes(new Date(guess), tz) * 60_000;
  if (second !== guess) {
    // the offset changed between the two guesses (we are near a transition): prefer the earlier valid instant
    const a = new Date(guess);
    const b = new Date(second);
    const check = (d: Date) => {
      const p = zonedParts(d, tz);
      return p.year === local.year && p.month === local.month && p.day === local.day && p.hour === (local.hour ?? 0) && p.minute === (local.minute ?? 0);
    };
    guess = check(a) && check(b) ? Math.min(a.getTime(), b.getTime()) : check(b) ? b.getTime() : check(a) ? a.getTime() : Math.max(a.getTime(), b.getTime());
  }
  return new Date(guess);
}

/** `"2026-11-20T14:30"` (a datetime-local value) → UTC instant in `tz`, or null when it is not a valid local time. */
export function parseLocalDateTime(value: string, tz: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!m) return null;
  const [year, month, day, hour, minute, second] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? "0"].map(Number) as [number, number, number, number, number, number];
  const probe = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day || hour > 23 || minute > 59) return null;
  return zonedTimeToUtc({ year, month, day, hour, minute, second }, tz);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** `YYYY-MM-DD` of an instant in `tz`. */
export function zonedDayKey(date: Date, tz: string): string {
  const p = zonedParts(date, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** `YYYY-MM-DDTHH:mm` of an instant in `tz` (the value a datetime-local input expects). */
export function toLocalInputValue(date: Date, tz: string): string {
  const p = zonedParts(date, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** Human display, 24-hour: `20 Nov 2026, 14:30`. */
export function formatInZone(date: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
}

export function formatTimeInZone(date: Date, tz: string): string {
  const p = zonedParts(date, tz);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

function parseKey(key: string): { year: number; month: number; day: number } {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  return { year: y, month: m, day: d };
}
const keyOf = (ms: number) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};
const keyMs = (key: string) => {
  const k = parseKey(key);
  return Date.UTC(k.year, k.month - 1, k.day);
};

export function addDays(key: string, n: number): string {
  return keyOf(keyMs(key) + n * 86_400_000);
}

/** The UTC range `[start, end)` covered by a calendar day in `tz` (23/25 hours on a DST change day). */
export function zonedDayRange(key: string, tz: string): { start: Date; end: Date } {
  const k = parseKey(key);
  const n = parseKey(addDays(key, 1));
  return { start: zonedTimeToUtc({ ...k }, tz), end: zonedTimeToUtc({ ...n }, tz) };
}

/** Monday of the week containing `key`. */
export function weekStartKey(key: string): string {
  const dow = new Date(keyMs(key)).getUTCDay(); // 0 = Sunday
  return addDays(key, -((dow + 6) % 7));
}

export function monthStartKey(key: string): string {
  const k = parseKey(key);
  return `${k.year}-${pad(k.month)}-01`;
}

export function addMonths(key: string, n: number): string {
  const k = parseKey(key);
  const total = k.year * 12 + (k.month - 1) + n;
  return `${Math.floor(total / 12)}-${pad((total % 12) + 1)}-01`;
}

/** Weeks (Monday-first) covering the month of `key`, each as seven day keys. */
export function monthGrid(key: string): string[][] {
  const first = monthStartKey(key);
  const last = addDays(addMonths(first, 1), -1);
  const weeks: string[][] = [];
  for (let cursor = weekStartKey(first); keyMs(cursor) <= keyMs(last); cursor = addDays(cursor, 7)) {
    weeks.push(Array.from({ length: 7 }, (_, i) => addDays(cursor, i)));
  }
  return weeks;
}

export function weekDays(key: string): string[] {
  const start = weekStartKey(key);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

/** The UTC range a calendar view covers, for the API's feed query. */
export function viewRange(view: "day" | "week" | "month", key: string, tz: string): { from: Date; to: Date } {
  if (view === "day") {
    const r = zonedDayRange(key, tz);
    return { from: r.start, to: r.end };
  }
  if (view === "week") {
    const days = weekDays(key);
    return { from: zonedDayRange(days[0]!, tz).start, to: zonedDayRange(days[6]!, tz).end };
  }
  const grid = monthGrid(key);
  return { from: zonedDayRange(grid[0]![0]!, tz).start, to: zonedDayRange(grid[grid.length - 1]![6]!, tz).end };
}
