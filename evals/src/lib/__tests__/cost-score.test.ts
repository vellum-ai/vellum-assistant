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

  test("the score decays as the inverse cost ratio past the baseline", () => {
    // GIVEN a baseline budget
    const baseline = 0.02;

    // WHEN the run spends 2× and 4× the baseline
    // THEN the score is the inverse ratio: 1/2 and 1/4
    expect(scoreCostAgainstBaseline(0.04, baseline)).toBeCloseTo(0.5, 10);
    expect(scoreCostAgainstBaseline(0.08, baseline)).toBeCloseTo(0.25, 10);
  });

  test("the score approaches but never reaches zero for runaway cost", () => {
    // GIVEN a baseline budget
    const baseline = 0.02;

    // WHEN the run spends far beyond the baseline
    // THEN the score stays a small positive fraction rather than flooring at 0
    const score = scoreCostAgainstBaseline(1, baseline);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeCloseTo(0.02, 10);
  });

  test("a non-positive baseline cannot define a budget and scores zero", () => {
    // GIVEN a missing/zero baseline
    // WHEN any cost is scored against it
    // THEN the score is 0 rather than NaN or Infinity
    expect(scoreCostAgainstBaseline(0.01, 0)).toBe(0);
    expect(scoreCostAgainstBaseline(0.01, -1)).toBe(0);
  });
});
