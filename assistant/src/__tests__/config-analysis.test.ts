import { describe, expect, test } from "bun:test";

import {
  AnalysisConfigSchema,
  AssistantConfigSchema,
} from "../config/schema.js";

describe("AnalysisConfigSchema", () => {
  test("empty object parses to documented defaults", () => {
    const parsed = AnalysisConfigSchema.parse({});
    expect(parsed.batchSize).toBe(30);
    expect(parsed.idleTimeoutMs).toBe(600_000);
  });

  test("custom batch/idle values round-trip", () => {
    const input = {
      batchSize: 50,
      idleTimeoutMs: 120_000,
    };
    const parsed = AnalysisConfigSchema.parse(input);
    expect(parsed).toEqual(input);
  });

  test("legacy modelIntent/modelOverride are stripped after PR 19 cleanup", () => {
    // Both fields moved to llm.callSites.analyzeConversation in PR 4 and
    // were removed from the schema in PR 19. Zod silently strips unknown
    // keys; migration 039 erases them from disk.
    const parsed = AnalysisConfigSchema.parse({
      modelIntent: "quality-optimized",
      modelOverride: "anthropic/claude-opus-4-6",
    });
    expect((parsed as Record<string, unknown>).modelIntent).toBeUndefined();
    expect((parsed as Record<string, unknown>).modelOverride).toBeUndefined();
  });

  test("rejects batchSize: 0 (must be positive)", () => {
    const result = AnalysisConfigSchema.safeParse({ batchSize: 0 });
    expect(result.success).toBe(false);
  });

  test("rejects negative batchSize", () => {
    const result = AnalysisConfigSchema.safeParse({ batchSize: -1 });
    expect(result.success).toBe(false);
  });

  test("rejects non-integer batchSize", () => {
    const result = AnalysisConfigSchema.safeParse({ batchSize: 3.5 });
    expect(result.success).toBe(false);
  });

  test("rejects idleTimeoutMs: 0 (must be positive)", () => {
    const result = AnalysisConfigSchema.safeParse({ idleTimeoutMs: 0 });
    expect(result.success).toBe(false);
  });

  test("rejects negative idleTimeoutMs", () => {
    const result = AnalysisConfigSchema.safeParse({ idleTimeoutMs: -1000 });
    expect(result.success).toBe(false);
  });
});

describe("AssistantConfigSchema — analysis integration", () => {
  test("analysis key is populated with defaults when config is empty", () => {
    const parsed = AssistantConfigSchema.parse({});
    expect(parsed.analysis).toEqual({
      batchSize: 30,
      idleTimeoutMs: 600_000,
    });
  });

  test("analysis overrides are threaded through to the parent config", () => {
    const parsed = AssistantConfigSchema.parse({
      analysis: {
        batchSize: 15,
        idleTimeoutMs: 300_000,
      },
    });
    expect(parsed.analysis).toEqual({
      batchSize: 15,
      idleTimeoutMs: 300_000,
    });
  });
});
