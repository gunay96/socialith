import { describe, expect, it, vi } from "vitest";
import { isUpsertRaceError, withUpsertRaceRetry } from "./db-retry.js";

const prismaError = (code: string) => Object.assign(new Error(`prisma ${code}`), { code });
const noSleep = vi.fn(async () => undefined);

describe("isUpsertRaceError", () => {
  it("recognizes unique-violation and deadlock/write-conflict codes", () => {
    expect(isUpsertRaceError(prismaError("P2002"))).toBe(true);
    expect(isUpsertRaceError(prismaError("P2034"))).toBe(true);
  });

  it("rejects everything else", () => {
    expect(isUpsertRaceError(prismaError("P2025"))).toBe(false);
    expect(isUpsertRaceError(new Error("plain"))).toBe(false);
    expect(isUpsertRaceError(null)).toBe(false);
    expect(isUpsertRaceError("P2002")).toBe(false);
    expect(isUpsertRaceError({ code: 2002 })).toBe(false);
  });
});

describe("withUpsertRaceRetry", () => {
  it("returns the first result without retrying or sleeping", async () => {
    const fn = vi.fn(async () => "ok");
    noSleep.mockClear();
    await expect(withUpsertRaceRetry(fn, { sleep: noSleep })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(noSleep).not.toHaveBeenCalled();
  });

  it("retries a lost race and returns the eventual success", async () => {
    const fn = vi.fn().mockRejectedValueOnce(prismaError("P2002")).mockRejectedValueOnce(prismaError("P2034")).mockResolvedValue("done");
    noSleep.mockClear();
    await expect(withUpsertRaceRetry(fn, { sleep: noSleep })).resolves.toBe("done");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(noSleep).toHaveBeenCalledTimes(2);
  });

  it("backs off with growing, jittered delays", async () => {
    const delays: number[] = [];
    const fn = vi.fn().mockRejectedValueOnce(prismaError("P2002")).mockRejectedValueOnce(prismaError("P2002")).mockResolvedValue(1);
    await withUpsertRaceRetry(fn, { baseDelayMs: 100, sleep: async (ms) => void delays.push(ms) });
    expect(delays).toHaveLength(2);
    expect(delays[0]).toBeGreaterThanOrEqual(100);
    expect(delays[0]).toBeLessThan(200);
    expect(delays[1]).toBeGreaterThanOrEqual(200);
    expect(delays[1]).toBeLessThan(300);
  });

  it("gives up after the configured attempts and rethrows the last error", async () => {
    const fn = vi.fn().mockRejectedValue(prismaError("P2002"));
    await expect(withUpsertRaceRetry(fn, { attempts: 3, sleep: noSleep })).rejects.toMatchObject({ code: "P2002" });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("never retries an unrelated error", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(withUpsertRaceRetry(fn, { sleep: noSleep })).rejects.toThrow("boom");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
