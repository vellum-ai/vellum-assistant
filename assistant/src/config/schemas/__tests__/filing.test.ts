import { describe, expect, test } from "bun:test";

import { FilingConfigSchema } from "../filing.js";

describe("FilingConfigSchema", () => {
  test("defaults compactionEnabled to true", () => {
    const parsed = FilingConfigSchema.parse({});
    expect(parsed.compactionEnabled).toBe(true);
  });

  test("defaults compactionIntervalMs to 24 hours", () => {
    const parsed = FilingConfigSchema.parse({});
    expect(parsed.compactionIntervalMs).toBe(24 * 3_600_000);
  });

  test("defaults intervalMs to 4 hours (regression check)", () => {
    const parsed = FilingConfigSchema.parse({});
    expect(parsed.intervalMs).toBe(4 * 3_600_000);
  });

  test("rejects negative compactionIntervalMs", () => {
    expect(() =>
      FilingConfigSchema.parse({ compactionIntervalMs: -1 }),
    ).toThrow();
  });

  test("rejects zero compactionIntervalMs", () => {
    expect(() =>
      FilingConfigSchema.parse({ compactionIntervalMs: 0 }),
    ).toThrow();
  });

  test("rejects non-integer compactionIntervalMs", () => {
    expect(() =>
      FilingConfigSchema.parse({ compactionIntervalMs: 1.5 }),
    ).toThrow();
  });

  test("accepts custom compactionIntervalMs", () => {
    const parsed = FilingConfigSchema.parse({ compactionIntervalMs: 60_000 });
    expect(parsed.compactionIntervalMs).toBe(60_000);
  });

  test("rejects non-boolean compactionEnabled", () => {
    expect(() =>
      FilingConfigSchema.parse({ compactionEnabled: "yes" }),
    ).toThrow();
  });

  test("compaction fields are independent of filing.enabled", () => {
    const parsed = FilingConfigSchema.parse({
      enabled: false,
      compactionEnabled: true,
    });
    expect(parsed.enabled).toBe(false);
    expect(parsed.compactionEnabled).toBe(true);
  });
});
