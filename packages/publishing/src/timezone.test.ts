import { describe, expect, it } from "vitest";
import { DEFAULT_TIMEZONE, addDays, addMonths, formatInZone, isValidTimeZone, monthGrid, parseLocalDateTime, toLocalInputValue, tzOffsetMinutes, viewRange, weekDays, weekStartKey, zonedDayKey, zonedDayRange, zonedTimeToUtc } from "./timezone.js";

const IST = DEFAULT_TIMEZONE;

describe("Europe/Istanbul (fixed UTC+3 since 2016)", () => {
  it("is the default zone and is valid", () => {
    expect(IST).toBe("Europe/Istanbul");
    expect(isValidTimeZone(IST)).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
  });

  it("converts wall-clock time to UTC and back", () => {
    const utc = parseLocalDateTime("2026-11-20T14:30", IST)!;
    expect(utc.toISOString()).toBe("2026-11-20T11:30:00.000Z");
    expect(toLocalInputValue(utc, IST)).toBe("2026-11-20T14:30");
    expect(tzOffsetMinutes(utc, IST)).toBe(180);
  });

  it("the Istanbul day boundary is 21:00 UTC: 00:30 local belongs to the NEXT UTC-evening", () => {
    const justAfterMidnight = parseLocalDateTime("2026-11-21T00:30", IST)!;
    expect(justAfterMidnight.toISOString()).toBe("2026-11-20T21:30:00.000Z");
    expect(zonedDayKey(justAfterMidnight, IST)).toBe("2026-11-21"); // not 2026-11-20, which a naive UTC date would say
    expect(zonedDayKey(new Date("2026-11-20T20:59:00Z"), IST)).toBe("2026-11-20");
    expect(zonedDayKey(new Date("2026-11-20T21:00:00Z"), IST)).toBe("2026-11-21");
  });

  it("a day range is [00:00, next 00:00) local", () => {
    const r = zonedDayRange("2026-11-20", IST);
    expect(r.start.toISOString()).toBe("2026-11-19T21:00:00.000Z");
    expect(r.end.toISOString()).toBe("2026-11-20T21:00:00.000Z");
  });

  it("rejects malformed and impossible local times", () => {
    for (const bad of ["", "2026-11-20", "2026-13-01T10:00", "2026-02-30T10:00", "2026-11-20T25:00", "2026-11-20T10:61", "nope"]) {
      expect(parseLocalDateTime(bad, IST), bad).toBeNull();
    }
    expect(parseLocalDateTime("2026-11-20 14:30", IST)!.toISOString()).toBe("2026-11-20T11:30:00.000Z"); // a space separator is accepted
  });

  it("formats in the zone", () => {
    expect(formatInZone(new Date("2026-11-20T11:30:00Z"), IST)).toMatch(/20 Nov 2026,? 14:30/);
  });
});

describe("zones with daylight saving (the helpers must not assume +3)", () => {
  const NY = "America/New_York";
  it("winter and summer offsets differ", () => {
    expect(tzOffsetMinutes(new Date("2026-01-15T12:00:00Z"), NY)).toBe(-300);
    expect(tzOffsetMinutes(new Date("2026-07-15T12:00:00Z"), NY)).toBe(-240);
  });
  it("a local time that does not exist (spring-forward gap) resolves to just after the gap", () => {
    // 2026-03-08 02:30 does not exist in New York; clocks jump 02:00 → 03:00
    const d = zonedTimeToUtc({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, NY);
    expect(d.toISOString()).toBe("2026-03-08T07:30:00.000Z"); // 03:30 EDT
  });
  it("an ambiguous local time (fall-back overlap) resolves to its first occurrence", () => {
    // 2026-11-01 01:30 happens twice in New York; the first is still EDT (UTC-4)
    const d = zonedTimeToUtc({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, NY);
    expect(d.toISOString()).toBe("2026-11-01T05:30:00.000Z");
  });
  it("a DST change day is 23 or 25 hours long", () => {
    const spring = zonedDayRange("2026-03-08", NY);
    expect((spring.end.getTime() - spring.start.getTime()) / 3_600_000).toBe(23);
    const fall = zonedDayRange("2026-11-01", NY);
    expect((fall.end.getTime() - fall.start.getTime()) / 3_600_000).toBe(25);
  });
});

describe("calendar arithmetic on day keys", () => {
  it("adds days and months across boundaries and leap years", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addMonths("2026-11-20", 1)).toBe("2026-12-01");
    expect(addMonths("2026-12-15", 1)).toBe("2027-01-01");
    expect(addMonths("2026-01-31", -1)).toBe("2025-12-01");
  });
  it("weeks start on Monday", () => {
    expect(weekStartKey("2026-11-20")).toBe("2026-11-16"); // 20 Nov 2026 is a Friday
    expect(weekStartKey("2026-11-22")).toBe("2026-11-16"); // Sunday
    expect(weekStartKey("2026-11-23")).toBe("2026-11-23");
    expect(weekDays("2026-11-20")).toEqual(["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20", "2026-11-21", "2026-11-22"]);
  });
  it("a month grid is whole Monday-first weeks covering the month", () => {
    const g = monthGrid("2026-11-20");
    expect(g[0]![0]).toBe("2026-10-26");
    expect(g[g.length - 1]![6]).toBe("2026-12-06");
    expect(g.every((w) => w.length === 7)).toBe(true);
    expect(g.flat()).toContain("2026-11-01");
    expect(g.flat()).toContain("2026-11-30");
  });
  it("the view range covers the whole view in UTC for the zone", () => {
    const day = viewRange("day", "2026-11-20", IST);
    expect(day.from.toISOString()).toBe("2026-11-19T21:00:00.000Z");
    const week = viewRange("week", "2026-11-20", IST);
    expect(week.from.toISOString()).toBe("2026-11-15T21:00:00.000Z");
    expect(week.to.toISOString()).toBe("2026-11-22T21:00:00.000Z");
    const month = viewRange("month", "2026-11-20", IST);
    expect(month.from.toISOString()).toBe("2026-10-25T21:00:00.000Z");
  });
});
