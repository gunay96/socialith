import { describe, expect, it } from "vitest";
import { formatCompactNumber } from "./format";

describe("formatCompactNumber", () => {
  it("formats large numbers compactly", () => {
    expect(formatCompactNumber(1200000)).toBe("1.2M");
  });

  it("leaves small numbers as-is", () => {
    expect(formatCompactNumber(42)).toBe("42");
  });
});
