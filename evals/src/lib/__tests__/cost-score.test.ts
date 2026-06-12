import { describe, expect, test } from "bun:test";

import { scoreCostAgainstBaseline } from "../cost-score";

describe("scoreCostAgainstBaseline", () => {
  test("spending at or under the baseline earns full marks", () => {
    // GIVEN a baseline budget
    const baseline = 0.02;

    // WHEN the run spends under, exactly at, or nothing
    // THEN the score is a full 1.0 in every case
    expect(scoreCostAgainstBaseline(0.01, baseline)).toBe(1);
    expect(scoreCostAgainstBaseline(baseline, baseline)).toBe(1);
    expect(scoreCostAgainstBaseline(0, baseline)).toBe(1);
  });

  test("the score decays linearly between the baseline and twice the baseline", () => {
    // GIVEN a baseline budget
    const baseline = 0.02;

    // WHEN the run spends 1.5× the baseline
    // THEN the score is halfway down to zero
    expect(scoreCostAgainstBaseline(0.03, baseline)).toBeCloseTo(0.5, 10);
  });

  test("spending twice the baseline or more scores zero", () => {
    // GIVEN a baseline budget
    const baseline = 0.02;

    // WHEN the run spends 2× or well beyond
    // THEN the score floors at 0 (never negative)
    expect(scoreCostAgainstBaseline(0.04, baseline)).toBe(0);
    expect(scoreCostAgainstBaseline(1, baseline)).toBe(0);
  });

  test("a non-positive baseline cannot define a budget and scores zero", () => {
    // GIVEN a missing/zero baseline
    // WHEN any cost is scored against it
    // THEN the score is 0 rather than NaN or Infinity
    expect(scoreCostAgainstBaseline(0.01, 0)).toBe(0);
    expect(scoreCostAgainstBaseline(0.01, -1)).toBe(0);
  });
});
