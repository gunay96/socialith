import { describe, expect, it } from "vitest";
import { computeContentRollup, type TargetGroup } from "./content-rollup.js";

const g = (status: TargetGroup["status"], count = 1, exception: TargetGroup["exception"] = null, minScheduledAt: Date | null = null): TargetGroup => ({ status, exception, count, minScheduledAt });
const T1 = new Date("2026-11-20T10:00:00Z");
const T2 = new Date("2026-11-21T10:00:00Z");

describe("computeContentRollup", () => {
  it("any scheduled target keeps the content SCHEDULED at the EARLIEST scheduled time (even if others published or are running)", () => {
    expect(computeContentRollup([g("SCHEDULED", 2, null, T2), g("SCHEDULED", 1, null, T1), g("PUBLISHED"), g("PUBLISHING")])).toEqual({ status: "SCHEDULED", scheduledAt: T1 });
  });
  it("publishing beats settled states", () => {
    expect(computeContentRollup([g("PUBLISHING"), g("PUBLISHED"), g("FAILED")]).status).toBe("PUBLISHING");
  });
  it("everything settled: FAILED if any failed, else PUBLISHED", () => {
    expect(computeContentRollup([g("PUBLISHED", 2), g("FAILED")]).status).toBe("FAILED");
    expect(computeContentRollup([g("PUBLISHED", 3)]).status).toBe("PUBLISHED");
    expect(computeContentRollup([g("FAILED", 1, "STALE")]).status).toBe("FAILED"); // a stale hold on the only target is the legacy behaviour
  });
  it("held and cancelled targets do not keep a content open", () => {
    expect(computeContentRollup([g("PUBLISHED"), g("PENDING", 1, "HELD"), g("PENDING", 1, "CANCELLED")]).status).toBe("PUBLISHED");
    expect(computeContentRollup([g("PENDING", 2, "CANCELLED")]).status).toBe("READY");
  });
  it("a draft/approved target still to schedule means work remains: READY if nothing ran yet, else PUBLISHING (the legacy roll-up)", () => {
    expect(computeContentRollup([g("PENDING", 2)]).status).toBe("READY");
    expect(computeContentRollup([g("PUBLISHED"), g("PENDING")]).status).toBe("PUBLISHING");
  });
  it("no targets at all → READY", () => {
    expect(computeContentRollup([])).toEqual({ status: "READY", scheduledAt: null });
  });
});