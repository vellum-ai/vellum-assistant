import { describe, expect, test } from "bun:test";

import { MemoryConfigSchema } from "../memory.js";
import { MemoryV2ConfigSchema } from "../memory-v2.js";

describe("MemoryV2ConfigSchema", () => {
  test("parses an empty object to documented defaults", () => {
    const parsed = MemoryV2ConfigSchema.parse({});
    expect(parsed).toEqual({
      enabled: false,
      d: 0.3,
      c_user: 0.3,
      c_assistant: 0.2,
      c_now: 0.2,
      k: 0.5,
      hops: 2,
      top_k: 20,
      epsilon: 0.01,
      dense_weight: 0.7,
      sparse_weight: 0.3,
      consolidation_interval_hours: 1,
      max_page_chars: 5000,
    });
  });

  test("defaults satisfy both weight-sum constraints", () => {
    const parsed = MemoryV2ConfigSchema.parse({});
    expect(parsed.d + parsed.c_user + parsed.c_assistant + parsed.c_now).toBe(
      1,
    );
    expect(parsed.dense_weight + parsed.sparse_weight).toBe(1);
  });

  test("accepts an explicit override that still sums to 1.0", () => {
    const parsed = MemoryV2ConfigSchema.parse({
      d: 0.4,
      c_user: 0.3,
      c_assistant: 0.2,
      c_now: 0.1,
    });
    expect(parsed.d).toBe(0.4);
    expect(parsed.c_user).toBe(0.3);
    expect(parsed.c_assistant).toBe(0.2);
    expect(parsed.c_now).toBe(0.1);
  });

  test("accepts hybrid weights that still sum to 1.0", () => {
    const parsed = MemoryV2ConfigSchema.parse({
      dense_weight: 0.5,
      sparse_weight: 0.5,
    });
    expect(parsed.dense_weight).toBe(0.5);
    expect(parsed.sparse_weight).toBe(0.5);
  });

  test("rejects activation weights that do not sum to 1.0", () => {
    expect(() =>
      MemoryV2ConfigSchema.parse({
        d: 0.5,
        c_user: 0.5,
        c_assistant: 0.5,
        c_now: 0.5,
      }),
    ).toThrow(/activation weights/);
  });

  test("rejects activation weights that sum to less than 1.0", () => {
    expect(() =>
      MemoryV2ConfigSchema.parse({
        d: 0.1,
        c_user: 0.1,
        c_assistant: 0.1,
        c_now: 0.1,
      }),
    ).toThrow(/activation weights/);
  });

  test("rejects hybrid weights that do not sum to 1.0", () => {
    expect(() =>
      MemoryV2ConfigSchema.parse({
        dense_weight: 0.8,
        sparse_weight: 0.5,
      }),
    ).toThrow(/hybrid weights/);
  });

  test("allows weight sums within the 0.001 tolerance and rejects beyond it", () => {
    // Just inside the tolerance (gap ~0.0005) — accepted.
    const ok = MemoryV2ConfigSchema.parse({
      d: 0.3005,
      c_user: 0.3,
      c_assistant: 0.2,
      c_now: 0.2,
    });
    expect(ok.d).toBe(0.3005);

    // Beyond the tolerance (gap = 0.005) — rejected.
    expect(() =>
      MemoryV2ConfigSchema.parse({
        d: 0.305,
        c_user: 0.3,
        c_assistant: 0.2,
        c_now: 0.2,
      }),
    ).toThrow(/activation weights/);
  });

  test("rejects negative weight values", () => {
    expect(() =>
      MemoryV2ConfigSchema.parse({
        d: -0.1,
        c_user: 0.4,
        c_assistant: 0.4,
        c_now: 0.3,
      }),
    ).toThrow();
  });

  test("rejects non-integer hops", () => {
    expect(() => MemoryV2ConfigSchema.parse({ hops: 1.5 })).toThrow();
  });

  test("rejects zero or negative top_k", () => {
    expect(() => MemoryV2ConfigSchema.parse({ top_k: 0 })).toThrow();
    expect(() => MemoryV2ConfigSchema.parse({ top_k: -5 })).toThrow();
  });

  test("rejects zero or negative consolidation_interval_hours", () => {
    expect(() =>
      MemoryV2ConfigSchema.parse({ consolidation_interval_hours: 0 }),
    ).toThrow();
  });

  test("rejects zero or negative max_page_chars", () => {
    expect(() => MemoryV2ConfigSchema.parse({ max_page_chars: 0 })).toThrow();
  });

  test("rejects non-boolean enabled", () => {
    expect(() => MemoryV2ConfigSchema.parse({ enabled: "yes" })).toThrow();
  });

  test("rejects epsilon outside [0, 1]", () => {
    expect(() => MemoryV2ConfigSchema.parse({ epsilon: -0.01 })).toThrow();
    expect(() => MemoryV2ConfigSchema.parse({ epsilon: 1.5 })).toThrow();
  });
});

describe("MemoryConfigSchema integration with v2 block", () => {
  test("parses an empty memory config and includes a v2 block with defaults", () => {
    const parsed = MemoryConfigSchema.parse({});
    expect(parsed.v2).toBeDefined();
    expect(parsed.v2.enabled).toBe(false);
    expect(parsed.v2.d).toBe(0.3);
    expect(parsed.v2.dense_weight).toBe(0.7);
    expect(parsed.v2.sparse_weight).toBe(0.3);
    expect(parsed.v2.consolidation_interval_hours).toBe(1);
    expect(parsed.v2.max_page_chars).toBe(5000);
  });

  test("propagates v2 overrides through MemoryConfigSchema", () => {
    const parsed = MemoryConfigSchema.parse({
      v2: { enabled: true, top_k: 50 },
    });
    expect(parsed.v2.enabled).toBe(true);
    expect(parsed.v2.top_k).toBe(50);
    // Non-overridden v2 fields keep their defaults.
    expect(parsed.v2.d).toBe(0.3);
  });

  test("rejects invalid v2 weights when nested in MemoryConfigSchema", () => {
    expect(() =>
      MemoryConfigSchema.parse({
        v2: {
          d: 0.5,
          c_user: 0.5,
          c_assistant: 0.5,
          c_now: 0.5,
        },
      }),
    ).toThrow(/activation weights/);
  });
});
