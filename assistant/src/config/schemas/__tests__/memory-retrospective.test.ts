import { describe, expect, test } from "bun:test";

import { MemoryRetrospectiveConfigSchema } from "../memory-retrospective.js";

describe("MemoryRetrospectiveConfigSchema", () => {
  test("parses an empty object to documented defaults", () => {
    const parsed = MemoryRetrospectiveConfigSchema.parse({});
    expect(parsed).toEqual({
      timeThresholdMs: 30 * 60 * 1000,
      messageThreshold: 25,
      minCooldownMs: 10 * 60 * 1000,
      maxRunsPerAssistantPerDay: 40,
      sweepIntervalMs: 8 * 60 * 60 * 1000,
      keepSupersededRuns: false,
      matchConversationProfile: false,
      promptPath: null,
    });
  });

  test("an explicit override is preserved and only unset fields take defaults (backward compat)", () => {
    // Configs written against the prior defaults keep their explicit values;
    // a field they never set (the new cap) falls back to its default.
    const parsed = MemoryRetrospectiveConfigSchema.parse({
      messageThreshold: 10,
      minCooldownMs: 5 * 60 * 1000,
    });
    expect(parsed.messageThreshold).toBe(10);
    expect(parsed.minCooldownMs).toBe(5 * 60 * 1000);
    expect(parsed.maxRunsPerAssistantPerDay).toBe(40);
  });

  test("rejects a non-positive cap", () => {
    expect(() =>
      MemoryRetrospectiveConfigSchema.parse({ maxRunsPerAssistantPerDay: 0 }),
    ).toThrow();
    expect(() =>
      MemoryRetrospectiveConfigSchema.parse({ maxRunsPerAssistantPerDay: -1 }),
    ).toThrow();
  });
});
