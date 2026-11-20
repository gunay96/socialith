import { describe, expect, it } from "vitest";
import { computeProgress, formatElapsed, type TaskProgressInput } from "./progress.js";

const now = new Date("2026-11-22T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const task = (over: Partial<TaskProgressInput>): TaskProgressInput => ({ status: "RUNNING", completedUnits: 0, totalUnits: null, ...over });

describe("computeProgress: a percentage exists only when both numbers are real", () => {
  it("is completed / total x 100", () => {
    expect(computeProgress(task({ completedUnits: 3, totalUnits: 8 }), now)).toMatchObject({ mode: "determinate", percentage: 37.5, completedUnits: 3, totalUnits: 8 });
    expect(computeProgress(task({ completedUnits: 1, totalUnits: 3 }), now).percentage).toBe(33.3);
    expect(computeProgress(task({ completedUnits: 8, totalUnits: 8, status: "SUCCEEDED" }), now).percentage).toBe(100);
    expect(computeProgress(task({ completedUnits: 0, totalUnits: 50, status: "QUEUED" }), now).percentage).toBe(0);
  });

  it("is indeterminate while running with no known total - never a made-up number", () => {
    const p = computeProgress(task({ completedUnits: 12, totalUnits: null }), now);
    expect(p).toMatchObject({ mode: "indeterminate", percentage: null, totalUnits: null });
    expect(computeProgress(task({ status: "QUEUED", totalUnits: null }), now).mode).toBe("indeterminate");
  });

  it("treats a zero, negative or non-finite total as unknown (no division by zero, no Infinity)", () => {
    for (const totalUnits of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const p = computeProgress(task({ completedUnits: 4, totalUnits }), now);
      expect(p.mode).toBe("indeterminate");
      expect(p.percentage).toBeNull();
    }
  });

  it("has no progress to draw for a finished task that never knew its total", () => {
    for (const status of ["SUCCEEDED", "FAILED", "CANCELLED"] as const) {
      expect(computeProgress(task({ status, totalUnits: null }), now)).toMatchObject({ mode: "none", percentage: null });
    }
  });

  it("keeps a failed task's real partial progress (the interface shows the error, not a bar)", () => {
    expect(computeProgress(task({ status: "FAILED", completedUnits: 2, totalUnits: 5 }), now)).toMatchObject({ mode: "determinate", percentage: 40 });
  });

  it("clamps an impossible overshoot and says it is inconsistent instead of showing 150 %", () => {
    expect(computeProgress(task({ completedUnits: 15, totalUnits: 10 }), now)).toMatchObject({ percentage: 100, inconsistent: true });
    expect(computeProgress(task({ completedUnits: -3, totalUnits: 10 }), now)).toMatchObject({ percentage: 0, completedUnits: 0, inconsistent: false });
  });

  it("works in any unit (milliseconds of a render, files of an archive)", () => {
    expect(computeProgress(task({ completedUnits: 45_000, totalUnits: 180_000 }), now).percentage).toBe(25);
  });
});

describe("computeProgress: real time and stalled tasks", () => {
  it("measures elapsed time from the real timestamps", () => {
    expect(computeProgress(task({ startedAt: ago(90_000) }), now).elapsedMs).toBe(90_000);
    expect(computeProgress(task({ status: "SUCCEEDED", startedAt: ago(90_000), finishedAt: ago(30_000), totalUnits: 1, completedUnits: 1 }), now).elapsedMs).toBe(60_000);
    expect(computeProgress(task({ status: "QUEUED" }), now).elapsedMs).toBeNull();
    expect(computeProgress(task({ startedAt: "not a date" }), now).elapsedMs).toBeNull();
  });

  it("flags a running task that has gone silent, and only a running one", () => {
    expect(computeProgress(task({ startedAt: ago(600_000), lastProgressAt: ago(10 * 60_000) }), now).stalled).toBe(true);
    expect(computeProgress(task({ startedAt: ago(600_000), lastProgressAt: ago(5_000) }), now).stalled).toBe(false);
    expect(computeProgress(task({ status: "SUCCEEDED", startedAt: ago(600_000), lastProgressAt: ago(10 * 60_000) }), now).stalled).toBe(false);
    expect(computeProgress(task({ status: "QUEUED", lastProgressAt: ago(10 * 60_000) }), now).stalled).toBe(false);
  });

  it("falls back to the start time when a running task never reported, and honours a custom window", () => {
    expect(computeProgress(task({ startedAt: ago(5 * 60_000) }), now).stalled).toBe(true);
    expect(computeProgress(task({ startedAt: ago(5_000), lastProgressAt: ago(5_000) }), now, 1_000).stalled).toBe(true);
  });
});

describe("formatElapsed", () => {
  it("formats real durations", () => {
    expect(formatElapsed(null)).toBe("—");
    expect(formatElapsed(45_000)).toBe("45 s");
    expect(formatElapsed(125_000)).toBe("2 min 05 s");
    expect(formatElapsed(3_780_000)).toBe("1 h 03 min");
  });
});
