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
    expect(parsed.modelIntent).toBeUndefined();
    expect(parsed.modelOverride).toBeUndefined();
  });

  test("custom values round-trip", () => {
    const input = {
      batchSize: 50,
      idleTimeoutMs: 120_000,
      modelIntent: "quality-optimized" as const,
      modelOverride: "anthropic/claude-opus-4-6",
    };
    const parsed = AnalysisConfigSchema.parse(input);
    expect(parsed).toEqual(input);
  });

  test("accepts each valid modelIntent value", () => {
    for (const intent of [
      "latency-optimized",
      "quality-optimized",
      "vision-optimized",
    ] as const) {
      const parsed = AnalysisConfigSchema.parse({ modelIntent: intent });
      expect(parsed.modelIntent).toBe(intent);
    }
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

  test("rejects invalid modelIntent value", () => {
    const result = AnalysisConfigSchema.safeParse({
      modelIntent: "bogus-intent",
    });
    expect(result.success).toBe(false);
  });

  test("rejects non-string modelOverride", () => {
    const result = AnalysisConfigSchema.safeParse({ modelOverride: 42 });
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
        modelIntent: "latency-optimized",
      },
    });
    expect(parsed.analysis).toEqual({
      batchSize: 15,
      idleTimeoutMs: 300_000,
      modelIntent: "latency-optimized",
    });
  });
});
