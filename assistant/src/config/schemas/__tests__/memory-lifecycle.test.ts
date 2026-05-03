import { describe, expect, test } from "bun:test";

import { MemoryJobsConfigSchema } from "../memory-lifecycle.js";

describe("MemoryJobsConfigSchema", () => {
  test("parses an empty object to documented defaults", () => {
    const parsed = MemoryJobsConfigSchema.parse({});
    expect(parsed).toEqual({
      workerConcurrency: 2,
      batchSize: 10,
      stalledJobTimeoutMs: 30 * 60 * 1000,
      slowLlmConcurrency: 1,
      fastConcurrency: 2,
      embedConcurrency: 2,
    });
  });

  test("derives lane caps from workerConcurrency when only it is set", () => {
    const parsed = MemoryJobsConfigSchema.parse({ workerConcurrency: 4 });
    expect(parsed.workerConcurrency).toBe(4);
    expect(parsed.slowLlmConcurrency).toBe(2);
    expect(parsed.fastConcurrency).toBe(4);
    expect(parsed.embedConcurrency).toBe(4);
  });

  test("floors and clamps slowLlmConcurrency to at least 1 when deriving", () => {
    const parsed = MemoryJobsConfigSchema.parse({ workerConcurrency: 1 });
    expect(parsed.slowLlmConcurrency).toBe(1);
    expect(parsed.fastConcurrency).toBe(1);
    expect(parsed.embedConcurrency).toBe(1);
  });

  test("explicit lane cap overrides the derivation", () => {
    const parsed = MemoryJobsConfigSchema.parse({
      workerConcurrency: 4,
      slowLlmConcurrency: 1,
    });
    expect(parsed.slowLlmConcurrency).toBe(1);
    expect(parsed.fastConcurrency).toBe(4);
    expect(parsed.embedConcurrency).toBe(4);
  });

  test("explicit lane caps without workerConcurrency keep workerConcurrency default", () => {
    const parsed = MemoryJobsConfigSchema.parse({
      slowLlmConcurrency: 3,
      fastConcurrency: 5,
      embedConcurrency: 7,
    });
    expect(parsed.workerConcurrency).toBe(2);
    expect(parsed.slowLlmConcurrency).toBe(3);
    expect(parsed.fastConcurrency).toBe(5);
    expect(parsed.embedConcurrency).toBe(7);
  });

  test.each([
    "slowLlmConcurrency",
    "fastConcurrency",
    "embedConcurrency",
    "workerConcurrency",
  ] as const)("rejects %s = 0", (field) => {
    expect(() => MemoryJobsConfigSchema.parse({ [field]: 0 })).toThrow();
  });

  test.each([
    "slowLlmConcurrency",
    "fastConcurrency",
    "embedConcurrency",
    "workerConcurrency",
  ] as const)("rejects negative %s", (field) => {
    expect(() => MemoryJobsConfigSchema.parse({ [field]: -1 })).toThrow();
  });

  test.each([
    "slowLlmConcurrency",
    "fastConcurrency",
    "embedConcurrency",
    "workerConcurrency",
  ] as const)("rejects non-integer %s", (field) => {
    expect(() => MemoryJobsConfigSchema.parse({ [field]: 1.5 })).toThrow();
  });
});
