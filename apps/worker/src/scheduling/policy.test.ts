import { describe, expect, it } from "vitest";
import { buildReconcileConfig } from "./reconcile.js";
import { classifyJobState } from "./queue-port.js";
import { classifySchedule, stuckFailureMessage, staleHoldMessage } from "./policy.js";

const NOW = new Date("2026-11-19T12:00:00.000Z");
const MIN = 60_000;
const STALE = 30 * MIN;

describe("classifySchedule", () => {
  it("FUTURE: reports the remaining delay", () => {
    const v = classifySchedule(new Date(NOW.getTime() + 90 * MIN), NOW, STALE);
    expect(v).toEqual({ kind: "FUTURE", delayMs: 90 * MIN, lateByMs: 0 });
  });

  it("FUTURE: even 1 ms ahead is not due", () => {
    expect(classifySchedule(new Date(NOW.getTime() + 1), NOW, STALE).kind).toBe("FUTURE");
  });

  it("DUE: exactly now", () => {
    expect(classifySchedule(NOW, NOW, STALE)).toEqual({ kind: "DUE", delayMs: 0, lateByMs: 0 });
  });

  it("DUE: late but inside the window", () => {
    expect(classifySchedule(new Date(NOW.getTime() - 10 * MIN), NOW, STALE).kind).toBe("DUE");
  });

  it("DUE: the window boundary itself is inclusive", () => {
    expect(classifySchedule(new Date(NOW.getTime() - STALE), NOW, STALE).kind).toBe("DUE");
  });

  it("STALE: one millisecond past the window", () => {
    const v = classifySchedule(new Date(NOW.getTime() - STALE - 1), NOW, STALE);
    expect(v.kind).toBe("STALE");
    expect(v.lateByMs).toBe(STALE + 1);
  });

  it("STALE: the 58-day-old seed row that motivated this guard", () => {
    const scheduled = new Date("2026-09-23T17:19:55.224Z");
    expect(classifySchedule(scheduled, NOW, STALE).kind).toBe("STALE");
  });

  it("honours a different window", () => {
    const twoHoursAgo = new Date(NOW.getTime() - 120 * MIN);
    expect(classifySchedule(twoHoursAgo, NOW, 60 * MIN).kind).toBe("STALE");
    expect(classifySchedule(twoHoursAgo, NOW, 180 * MIN).kind).toBe("DUE");
  });
});

describe("messages", () => {
  it("stale hold message names the time, the window and the way out", () => {
    const msg = staleHoldMessage(new Date("2026-09-23T17:19:55.224Z"), 30);
    expect(msg).toContain("2026-09-23T17:19:55.224Z");
    expect(msg).toContain("30 minutes");
    expect(msg).toMatch(/not published automatically/);
    expect(msg).toMatch(/retry/i);
  });

  it("stuck failure message names the limit", () => {
    expect(stuckFailureMessage(24)).toContain("24 hours");
  });
});

describe("classifyJobState (BullMQ states → liveness)", () => {
  it.each(["waiting", "delayed", "active", "prioritized", "waiting-children"])("%s is live", (state) => {
    expect(classifyJobState(state)).toBe("live");
  });

  it.each(["completed", "failed"])("%s is finished", (state) => {
    expect(classifyJobState(state)).toBe("finished");
  });

  it("an unknown state is treated as live (never create a competing job)", () => {
    expect(classifyJobState("unknown")).toBe("live");
    expect(classifyJobState("something-new")).toBe("live");
  });
});

describe("buildReconcileConfig", () => {
  it("converts the environment settings to milliseconds", () => {
    expect(
      buildReconcileConfig({
        SCHEDULE_STALE_AFTER_MINUTES: 30,
        PUBLISHING_STUCK_AFTER_MINUTES: 20,
        PUBLISHING_RECOVERY_MAX_AGE_HOURS: 24,
      }),
    ).toEqual({ staleAfterMs: 30 * MIN, stuckAfterMs: 20 * MIN, recoveryMaxAgeMs: 24 * 3_600_000 });
  });
});
