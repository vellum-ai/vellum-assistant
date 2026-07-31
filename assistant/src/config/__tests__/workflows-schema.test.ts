import { describe, expect, test } from "bun:test";

import { AssistantConfigSchema } from "../schema.js";
import { WorkflowsConfigSchema } from "../schemas/workflows.js";

describe("WorkflowsConfigSchema", () => {
  test("empty object parses to full defaults", () => {
    const parsed = WorkflowsConfigSchema.parse({});
    expect(parsed).toEqual({
      maxAgentsPerRun: 500,
      maxConcurrentLeaves: 6,
      maxConcurrentRuns: 3,
      journalRetentionDays: 30,
    });
  });

  test("custom values round-trip", () => {
    const parsed = WorkflowsConfigSchema.parse({
      maxAgentsPerRun: 100,
      maxConcurrentLeaves: 12,
      maxConcurrentRuns: 1,
      journalRetentionDays: 7,
    });
    expect(parsed).toEqual({
      maxAgentsPerRun: 100,
      maxConcurrentLeaves: 12,
      maxConcurrentRuns: 1,
      journalRetentionDays: 7,
    });
  });

  test("rejects non-positive and non-integer values", () => {
    expect(
      WorkflowsConfigSchema.safeParse({ maxAgentsPerRun: 0 }).success,
    ).toBe(false);
    expect(
      WorkflowsConfigSchema.safeParse({ maxConcurrentLeaves: -1 }).success,
    ).toBe(false);
    expect(
      WorkflowsConfigSchema.safeParse({ journalRetentionDays: 1.5 }).success,
    ).toBe(false);
  });

  test("root config resolves workflow defaults when section is absent", () => {
    const config = AssistantConfigSchema.parse({});
    expect(config.workflows.maxAgentsPerRun).toBe(500);
    expect(config.workflows.maxConcurrentLeaves).toBe(6);
    expect(config.workflows.maxConcurrentRuns).toBe(3);
    expect(config.workflows.journalRetentionDays).toBe(30);
  });

  test("root config applies workflow overrides", () => {
    const config = AssistantConfigSchema.parse({
      workflows: { maxConcurrentLeaves: 10 },
    });
    expect(config.workflows.maxConcurrentLeaves).toBe(10);
    // Unspecified leaves still fall back to defaults.
    expect(config.workflows.maxAgentsPerRun).toBe(500);
  });
});
