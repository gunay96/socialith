import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import { EMPTY_FILTERS, explainError, filtersToQuery, fmt } from "@/lib/publishing";

describe("filtersToQuery", () => {
  it("sends nothing for empty filters", () => {
    expect(filtersToQuery(EMPTY_FILTERS, "Europe/Istanbul")).toBe("");
  });

  it("turns the entered DAYS into UTC instants of the organization's day, end exclusive (Istanbul = UTC+3)", () => {
    const q = new URLSearchParams(filtersToQuery({ ...EMPTY_FILTERS, from: "2026-11-20", to: "2026-11-20" }, "Europe/Istanbul").replace(/^\?/, ""));
    expect(q.get("from")).toBe("2026-11-19T21:00:00.000Z"); // 00:00 local
    expect(q.get("to")).toBe("2026-11-20T21:00:00.000Z"); // the whole of 20 Nov local, so the range ends at 00:00 on 21 Nov
  });

  it("keeps the other filters and the extra parameters", () => {
    const q = new URLSearchParams(filtersToQuery({ ...EMPTY_FILTERS, platform: "TIKTOK", artist: "Wave", state: "FAILED,STALE" }, "Europe/Istanbul", { page: 2, sort: "scheduledAt_asc", owner: undefined }).replace(/^\?/, ""));
    expect(Object.fromEntries(q.entries())).toEqual({ platform: "TIKTOK", artist: "Wave", state: "FAILED,STALE", page: "2", sort: "scheduledAt_asc" });
  });
});

describe("explainError", () => {
  it("returns the server message and the validation issues it carried", () => {
    const issues = [{ code: "CAPTION_TOO_LONG", severity: "ERROR", field: "caption", message: "Shorten it by 100." }];
    const e = explainError(new ApiError(422, "VALIDATION_FAILED", "It cannot be scheduled: Shorten it by 100.", { issues }));
    expect(e.message).toMatch(/cannot be scheduled/);
    expect(e.issues).toEqual(issues);
  });
  it("is safe for anything else", () => {
    expect(explainError(new ApiError(409, "CONFLICT", "Nope"))).toEqual({ message: "Nope", issues: [] });
    expect(explainError(new Error("boom"))).toEqual({ message: "Something went wrong.", issues: [] });
  });
});

describe("fmt", () => {
  it("shows an instant in the organization's timezone, 24-hour, and a dash for nothing", () => {
    expect(fmt("2026-11-20T11:30:00.000Z", "Europe/Istanbul")).toMatch(/20 Nov 2026,? 14:30/);
    expect(fmt(null, "Europe/Istanbul")).toBe("—");
    expect(fmt("garbage", "Europe/Istanbul")).toBe("—");
  });
});
