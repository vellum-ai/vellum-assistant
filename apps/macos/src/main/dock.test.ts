import { describe, expect, test } from "bun:test";

import { computePolicy, formatBadge } from "./dock";

describe("formatBadge", () => {
  test("returns empty string for zero", () => {
    expect(formatBadge(0)).toBe("");
  });

  test("returns empty string for negatives", () => {
    expect(formatBadge(-1)).toBe("");
    expect(formatBadge(-99)).toBe("");
  });

  test("returns empty string for NaN and ±Infinity", () => {
    expect(formatBadge(Number.NaN)).toBe("");
    expect(formatBadge(Number.POSITIVE_INFINITY)).toBe("");
    expect(formatBadge(Number.NEGATIVE_INFINITY)).toBe("");
  });

  test("passes through 1..99", () => {
    expect(formatBadge(1)).toBe("1");
    expect(formatBadge(42)).toBe("42");
    expect(formatBadge(99)).toBe("99");
  });

  test("truncates anything beyond 99 to \"99+\"", () => {
    expect(formatBadge(100)).toBe("99+");
    expect(formatBadge(1_000_000)).toBe("99+");
  });

  test("floors fractional counts in the 1..99 range", () => {
    expect(formatBadge(2.9)).toBe("2");
    expect(formatBadge(98.7)).toBe("98");
  });

  test("anything strictly greater than 99 truncates to \"99+\" before flooring", () => {
    // 99.0001 fails the `count > 99` check and bypasses `Math.floor`,
    // landing on `"99+"`. This is intentional — Swift Vellum caps at 99
    // and matching its cap avoids visual jitter at the boundary.
    expect(formatBadge(99.0001)).toBe("99+");
    expect(formatBadge(99.9)).toBe("99+");
  });
});

describe("computePolicy", () => {
  test("regular while any window is visible (signed out, gate off)", () => {
    expect(computePolicy(1, false, false)).toBe("regular");
    expect(computePolicy(3, false, false)).toBe("regular");
  });

  test("regular while signed in even with no visible windows", () => {
    expect(computePolicy(0, true, false)).toBe("regular");
    expect(computePolicy(0, true, true)).toBe("regular");
  });

  test("regular when signed out + no windows AND accessory gate off", () => {
    expect(computePolicy(0, false, false)).toBe("regular");
  });

  test("accessory only when signed out + no windows + gate on", () => {
    expect(computePolicy(0, false, true)).toBe("accessory");
  });

  test("visible windows override every other signal", () => {
    expect(computePolicy(2, false, true)).toBe("regular");
    expect(computePolicy(1, true, true)).toBe("regular");
  });
});
