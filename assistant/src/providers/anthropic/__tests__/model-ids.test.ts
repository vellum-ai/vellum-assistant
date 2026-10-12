import { describe, expect, test } from "bun:test";

import {
  claudeModelGeneration,
  isAnthropicModelId,
  normalizeAnthropicModelId,
} from "../model-ids.js";

describe("normalizeAnthropicModelId", () => {
  test.each([
    ["anthropic/claude-opus-4.6", "claude-opus-4-6"],
    ["anthropic/claude-fable-5.1", "claude-fable-5-1"],
    ["claude-4-7-opus-20260416", "claude-opus-4-7-20260416"],
    ["claude-3-5-sonnet-20241022", "claude-sonnet-3-5-20241022"],
    ["claude-opus-4-7", "claude-opus-4-7"],
    ["gpt-5", "gpt-5"],
  ])("%s normalizes to %s", (model, expected) => {
    expect(normalizeAnthropicModelId(model)).toBe(expected);
  });
});

describe("claudeModelGeneration", () => {
  test.each([
    ["claude-opus-4-7", 4, 7],
    ["claude-sonnet-5", 5, 0],
    ["claude-fable-5-1", 5, 1],
    ["claude-haiku-4-5-20251001", 4, 5],
    ["anthropic/claude-opus-4.8", 4, 8],
    ["claude-4-7-opus-20260416", 4, 7],
    ["claude-3-opus-20240229", 3, 0],
  ])("%s is generation %d.%d", (model, major, minor) => {
    expect(claudeModelGeneration(model)).toEqual({ major, minor });
  });

  test.each(["gpt-5", "gemini-2.5-pro", "claude-2.1", "claude", ""])(
    "%j has no Claude generation",
    (model) => {
      expect(claudeModelGeneration(model)).toBeNull();
    },
  );
});

describe("isAnthropicModelId", () => {
  test("accepts the native and gateway forms", () => {
    expect(isAnthropicModelId("claude-opus-4-7")).toBe(true);
    expect(isAnthropicModelId("anthropic/claude-opus-4.7")).toBe(true);
    expect(isAnthropicModelId("gpt-5")).toBe(false);
  });
});
