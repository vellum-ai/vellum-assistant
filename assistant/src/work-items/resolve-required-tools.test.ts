import { describe, expect, test } from "bun:test";

import { resolveRequiredTools } from "./resolve-required-tools.js";

describe("resolveRequiredTools", () => {
  const taskTools = ["tool_a", "tool_b"];

  test("returns task tools when snapshot is null", () => {
    expect(resolveRequiredTools(null, taskTools)).toEqual(taskTools);
  });

  test("returns snapshot tools when snapshot is non-empty", () => {
    const snapshot = JSON.stringify(["tool_x", "tool_y"]);
    expect(resolveRequiredTools(snapshot, taskTools)).toEqual([
      "tool_x",
      "tool_y",
    ]);
  });

  test("falls back to task tools when snapshot is empty array", () => {
    const snapshot = JSON.stringify([]);
    expect(resolveRequiredTools(snapshot, taskTools)).toEqual(taskTools);
  });

  test("falls back to task tools when snapshot contains only invalid entries", () => {
    const snapshot = JSON.stringify(["", "", ""]);
    expect(resolveRequiredTools(snapshot, taskTools)).toEqual(taskTools);
  });

  test("deduplicates and sorts snapshot tools", () => {
    const snapshot = JSON.stringify(["tool_b", "tool_a", "tool_b"]);
    expect(resolveRequiredTools(snapshot, taskTools)).toEqual([
      "tool_a",
      "tool_b",
    ]);
  });
});
