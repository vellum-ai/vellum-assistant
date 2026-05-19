import { describe, expect, test } from "bun:test";

import {
  DEFAULT_LLM_USAGE_DIMENSION,
  LLM_USAGE_DIMENSION_ITEMS,
  LLM_USAGE_DIMENSION_LABELS,
  isLlmUsageDimension,
  toBillingGroupBy,
  toDaemonGroupBy,
  type LlmUsageDimension,
} from "@/lib/usage/llm-dimension.js";

describe("LlmUsageDimension", () => {
  test("defines ordered segment items with labels", () => {
    expect(LLM_USAGE_DIMENSION_ITEMS).toEqual([
      { value: "model", label: "Model" },
      { value: "task", label: "Action" },
      { value: "profile", label: "Profile" },
    ]);
  });

  test("defines labels keyed by dimension", () => {
    expect(LLM_USAGE_DIMENSION_LABELS).toEqual({
      model: "Model",
      task: "Action",
      profile: "Profile",
    });
  });

  test("defaults to model", () => {
    expect(DEFAULT_LLM_USAGE_DIMENSION).toBe("model");
  });

  test.each([
    ["task", true],
    ["model", true],
    ["profile", true],
    ["call_site", false],
    ["actor", false],
  ])("identifies %s as an LLM usage dimension", (value, expected) => {
    expect(isLlmUsageDimension(value)).toBe(expected);
  });

  test.each([
    ["model", "model"],
    ["task", "call_site"],
    ["profile", "inference_profile"],
  ] as Array<[LlmUsageDimension, ReturnType<typeof toDaemonGroupBy>]>)(
    "maps %s to daemon groupBy %s",
    (dimension, groupBy) => {
      expect(toDaemonGroupBy(dimension)).toBe(groupBy);
    },
  );

  test.each([
    ["model", "model"],
    ["task", "llm_call_site"],
    ["profile", "inference_profile"],
  ] as Array<[LlmUsageDimension, ReturnType<typeof toBillingGroupBy>]>)(
    "maps %s to billing group_by %s",
    (dimension, groupBy) => {
      expect(toBillingGroupBy(dimension)).toBe(groupBy);
    },
  );
});
