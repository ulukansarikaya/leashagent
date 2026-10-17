import { describe, expect, it } from "vitest";
import { dec, decScale, isDec } from "../src";

describe("dec", () => {
  it("validates decimal strings", () => {
    expect(isDec("50")).toBe(true);
    expect(isDec("-0.5")).toBe(true);
    for (const bad of ["", "1e5", ".5", "5.", "abc", "1,5", " 1"]) expect(isDec(bad)).toBe(false);
    expect(() => dec("1e5")).toThrow();
  });

  it("adds/subtracts exactly (no float error)", () => {
    expect(dec("0.1").add("0.2").toString()).toBe("0.3");
    expect(dec("1").sub("0.0001").toString()).toBe("0.9999");
    expect(dec("-1.5").add("1.5").toString()).toBe("0.0");
  });

  it("multiplies and applies bps", () => {
    expect(dec("2").mul("0.5").toString()).toBe("1.0");
    expect(dec("100").mulBps(10).toString()).toBe("0.1000");
    expect(dec("100").add(dec("100").mulBps(10).toString()).toString()).toBe("100.1000");
  });

  it("compares across scales", () => {
    expect(dec("50").eq("50.00000000")).toBe(true);
    expect(dec("1.10").gt("1.1")).toBe(false);
    expect(dec("-2").lt("1")).toBe(true);
    expect(dec("0.0").isZero()).toBe(true);
    expect(dec("-0.01").isNegative()).toBe(true);
  });

  it("floors to step and formats at fixed scale", () => {
    expect(dec("0.123456789").floorToStep("0.00000001").toFixed(8)).toBe("0.12345678");
    expect(dec("50").floorToStep("0.1").toFixed(1)).toBe("50.0");
    expect(dec("0.0004").floorToStep("0.001").isZero()).toBe(true);
    expect(dec("-0.0004").floorToStep("0.001").toFixed(3)).toBe("-0.001");
    expect(() => dec("1").floorToStep("0")).toThrow();
  });

  it("toFixed pads and floors", () => {
    expect(dec("50").toFixed(8)).toBe("50.00000000");
    expect(dec("1.999").toFixed(2)).toBe("1.99");
    expect(dec("-1.001").toFixed(2)).toBe("-1.01");
    expect(decScale("0.001")).toBe(3);
  });
});
