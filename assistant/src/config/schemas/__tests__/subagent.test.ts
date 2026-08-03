import { describe, expect, test } from "bun:test";

import { SubagentConfigSchema } from "../subagent.js";

describe("SubagentConfigSchema", () => {
  test("defaults the iteration budget to soft 60 / hard 100", () => {
    expect(SubagentConfigSchema.parse({})).toEqual({
      softNudgeAtCalls: 60,
      maxCallsPerRun: 100,
    });
  });

  test("honors explicit threshold overrides", () => {
    expect(
      SubagentConfigSchema.parse({ softNudgeAtCalls: 40, maxCallsPerRun: 80 }),
    ).toEqual({ softNudgeAtCalls: 40, maxCallsPerRun: 80 });
  });

  test("allows soft threshold equal to the hard cap", () => {
    expect(
      SubagentConfigSchema.parse({ softNudgeAtCalls: 50, maxCallsPerRun: 50 }),
    ).toEqual({ softNudgeAtCalls: 50, maxCallsPerRun: 50 });
  });

  test("rejects a soft threshold above the hard cap", () => {
    expect(() =>
      SubagentConfigSchema.parse({
        softNudgeAtCalls: 120,
        maxCallsPerRun: 100,
      }),
    ).toThrow();
  });

  test("rejects non-positive thresholds", () => {
    expect(() => SubagentConfigSchema.parse({ maxCallsPerRun: 0 })).toThrow();
    expect(() =>
      SubagentConfigSchema.parse({ softNudgeAtCalls: -1 }),
    ).toThrow();
  });

  test("rejects non-integer thresholds", () => {
    expect(() =>
      SubagentConfigSchema.parse({ maxCallsPerRun: 100.5 }),
    ).toThrow();
  });
});
