import { describe, expect, test } from "bun:test";

import { computeRecallBudget } from "../memory/retrieval-budget.js";

describe("memory retrieval budget", () => {
  test("clamps to maxInjectTokens when headroom is large", () => {
    const budget = computeRecallBudget({
      estimatedPromptTokens: 20_000,
      maxInputTokens: 180_000,
      targetHeadroomTokens: 8_000,
      minInjectTokens: 1_200,
      maxInjectTokens: 10_000,
    });
    expect(budget).toBe(10_000);
  });

  test("clamps to minInjectTokens when headroom is tight", () => {
    const budget = computeRecallBudget({
      estimatedPromptTokens: 172_000,
      maxInputTokens: 180_000,
      targetHeadroomTokens: 8_000,
      minInjectTokens: 1_200,
      maxInjectTokens: 10_000,
    });
    expect(budget).toBe(1_200);
  });

  test("returns computed value when between min and max", () => {
    const budget = computeRecallBudget({
      estimatedPromptTokens: 165_000,
      maxInputTokens: 180_000,
      targetHeadroomTokens: 8_000,
      minInjectTokens: 1_200,
      maxInjectTokens: 10_000,
    });
    expect(budget).toBe(7_000);
  });

  test("normalizes invalid min/max ordering safely", () => {
    const budget = computeRecallBudget({
      estimatedPromptTokens: 150_000,
      maxInputTokens: 180_000,
      targetHeadroomTokens: 8_000,
      minInjectTokens: 12_000,
      maxInjectTokens: 1_200,
    });
    expect(budget).toBe(12_000);
  });
});
