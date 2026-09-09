/**
 * Pins the alias vocabulary and its membership test.
 *
 * The tokens are a wire contract with claude-agent-acp's resolver, not display
 * text: `opusplan` and `sonnet[1m]` are spelled exactly as the adapter accepts
 * them, and a typo here saves a value that every spawn rejects. The membership
 * helper decides whether a stored setting lists as a row or falls through to
 * the custom input, so an unknown value must answer `false` rather than throw.
 */
import { describe, expect, test } from "bun:test";

import {
  ACP_SELECTABLE_MODELS,
  isAcpSelectableModel,
} from "@/assistant/acp-model-options";

describe("ACP_SELECTABLE_MODELS", () => {
  test("offers the verified adapter aliases in picker order", () => {
    expect(ACP_SELECTABLE_MODELS.map((option) => option.value)).toEqual([
      "default",
      "sonnet",
      "opus",
      "haiku",
      "fable",
      "best",
      "opusplan",
      "sonnet[1m]",
      "opus[1m]",
      "fable[1m]",
    ]);
  });

  test("every row carries a settings catalog label key", () => {
    for (const option of ACP_SELECTABLE_MODELS) {
      expect(option.labelKey).toStartWith("codingAgentsCard.modelOptions.");
    }
    const keys = ACP_SELECTABLE_MODELS.map((option) => option.labelKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("isAcpSelectableModel", () => {
  test("accepts every listed alias, bracket variants included", () => {
    for (const option of ACP_SELECTABLE_MODELS) {
      expect(isAcpSelectableModel(option.value)).toBe(true);
    }
  });

  test("rejects values the picker cannot list", () => {
    expect(isAcpSelectableModel("claude-opus-4-1")).toBe(false);
    expect(isAcpSelectableModel("gpt-5")).toBe(false);
    expect(isAcpSelectableModel("Opus")).toBe(false);
    expect(isAcpSelectableModel("")).toBe(false);
    expect(isAcpSelectableModel(null)).toBe(false);
    expect(isAcpSelectableModel(undefined)).toBe(false);
  });
});
