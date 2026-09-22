import { describe, expect, test } from "bun:test";

import {
  extraCreditUsd,
  planCreditUsedFraction,
  usageGrantRatio,
} from "../plan-credit.js";

describe("usageGrantRatio", () => {
  test("reads the used share and clamps to 0..1", () => {
    expect(usageGrantRatio(20, 9.1)).toBeCloseTo(0.545);
    expect(usageGrantRatio(20, 0)).toBe(1);
    expect(usageGrantRatio(20, 25)).toBe(0);
  });

  test("has no reading without both figures or with nothing granted", () => {
    expect(usageGrantRatio(null, 5)).toBeNull();
    expect(usageGrantRatio(20, null)).toBeNull();
    expect(usageGrantRatio(0, 0)).toBeNull();
  });
});

describe("planCreditUsedFraction", () => {
  test("prefers the ratio whatever the plan", () => {
    expect(planCreditUsedFraction(20, 9.1, "base")).toBeCloseTo(0.545);
    expect(planCreditUsedFraction(20, 9.1, null)).toBeCloseTo(0.545);
  });

  test("treats a Pro plan with nothing granted as fully spent", () => {
    expect(planCreditUsedFraction(0, 0, "pro")).toBe(1);
    expect(planCreditUsedFraction(0, null, "pro")).toBe(1);
  });

  test("gives a base or unknown plan with nothing granted no reading", () => {
    expect(planCreditUsedFraction(0, 0, "base")).toBeNull();
    expect(planCreditUsedFraction(0, 0, null)).toBeNull();
    expect(planCreditUsedFraction(null, null, "pro")).toBeNull();
  });
});

describe("extraCreditUsd", () => {
  test("nets unused grant credit out of the balance to the cent", () => {
    expect(extraCreditUsd(42.17, 9.1)).toBe(33.07);
    expect(extraCreditUsd(34.65, 9.1)).toBe(25.55);
  });

  test("never goes below zero", () => {
    expect(extraCreditUsd(5, 9.1)).toBe(0);
    expect(extraCreditUsd(-2.5, 0)).toBe(0);
  });
});
