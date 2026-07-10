import { describe, expect, test } from "bun:test";

import { isWeakOpenModel } from "../util/weak-open-model.js";

describe("isWeakOpenModel", () => {
  test("matches weak open models across provider naming conventions", () => {
    for (const model of [
      "accounts/fireworks/models/minimax-m3",
      "minimax/minimax-m3",
      "moonshotai/kimi-k2.6",
      "accounts/fireworks/models/kimi-k2p6",
      "deepseek/deepseek-chat",
      "accounts/fireworks/models/glm-5p2",
    ]) {
      expect(isWeakOpenModel(model)).toBe(true);
    }
  });

  test("does not match capable models", () => {
    for (const model of ["claude-opus-4-8", "claude-sonnet-4-6", "gpt-5.5"]) {
      expect(isWeakOpenModel(model)).toBe(false);
    }
  });

  test("is false for null/undefined/empty", () => {
    expect(isWeakOpenModel(null)).toBe(false);
    expect(isWeakOpenModel(undefined)).toBe(false);
    expect(isWeakOpenModel("")).toBe(false);
  });
});
