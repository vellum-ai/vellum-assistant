/**
 * Tests for the `memory.substrate.*` config namespace and its resolver.
 *
 * The substrate schema mirrors the substrate-consumed subset of `memory.v2.*`
 * with every field optional and no defaults; `resolveSubstrateTuning` is the
 * single choke point that resolves each tunable from `memory.substrate` with
 * fallback to the historical `memory.v2` key. Coverage:
 *
 *   - Fallback resolution: substrate unset → v2 value (defaults and explicit
 *     values); substrate set → wins; `spread_k`/`spread_hops` map onto
 *     `memory.v2.k`/`memory.v2.hops`; explicit `null` on a nullable substrate
 *     key wins over a non-null v2 value.
 *   - Namespace parsing (LUM-2758 guard): configs carrying only old keys,
 *     only new keys, or both parse cleanly with no refinement misfires, both
 *     through the memory slice schema and the full assistant schema.
 *   - The substrate hybrid-weight refinement fires only when BOTH weights are
 *     set and mis-summed.
 */
import { describe, expect, test } from "bun:test";

import { AssistantConfigSchema } from "../config/schema.js";
import { MemoryConfigSchema } from "../config/schemas/memory.js";
import { MemorySubstrateConfigSchema } from "../config/schemas/memory-substrate.js";
import { resolveSubstrateTuning } from "../plugins/defaults/memory/substrate/tuning.js";

describe("memory.substrate schema", () => {
  test("empty object parses and every field stays unset", () => {
    const parsed = MemorySubstrateConfigSchema.parse({});
    expect(parsed).toEqual({});
  });

  test("memory slice parse mounts substrate as an empty object by default", () => {
    const memory = MemoryConfigSchema.parse({});
    expect(memory.substrate).toEqual({});
  });

  test("config with only historical memory.v2 keys parses cleanly", () => {
    const memory = MemoryConfigSchema.parse({
      v2: { consolidation_interval_hours: 3, bm25_k1: 1.5 },
    });
    expect(memory.v2.consolidation_interval_hours).toBe(3);
    expect(memory.substrate).toEqual({});
  });

  test("config with only memory.substrate keys parses cleanly", () => {
    const memory = MemoryConfigSchema.parse({
      substrate: { consolidation_interval_hours: 3, spread_k: 0.4 },
    });
    expect(memory.substrate.consolidation_interval_hours).toBe(3);
    expect(memory.substrate.spread_k).toBe(0.4);
    // v2 defaults are untouched by substrate keys.
    expect(memory.v2.consolidation_interval_hours).toBe(8);
  });

  test("config with both namespaces parses cleanly", () => {
    const memory = MemoryConfigSchema.parse({
      v2: { consolidation_interval_hours: 3 },
      substrate: { consolidation_interval_hours: 5 },
    });
    expect(memory.v2.consolidation_interval_hours).toBe(3);
    expect(memory.substrate.consolidation_interval_hours).toBe(5);
  });

  test("full assistant config parse accepts either, both, or neither namespace", () => {
    for (const memory of [
      {},
      { v2: { max_page_chars: 4000 } },
      { substrate: { max_page_chars: 4000 } },
      { v2: { max_page_chars: 4000 }, substrate: { max_page_chars: 6000 } },
    ]) {
      const result = AssistantConfigSchema.safeParse({ memory });
      expect(result.success).toBe(true);
    }
  });

  test("hybrid-weight refinement fires only when both weights are set and mis-summed", () => {
    // Only one weight set — no refinement, even though it can't sum to 1.0
    // with an absent sibling (the resolver pairs it with the v2 twin).
    expect(
      MemorySubstrateConfigSchema.safeParse({ dense_weight: 0.5 }).success,
    ).toBe(true);
    expect(
      MemorySubstrateConfigSchema.safeParse({ sparse_weight: 0.5 }).success,
    ).toBe(true);

    // Both set and summing to 1.0 — valid.
    expect(
      MemorySubstrateConfigSchema.safeParse({
        dense_weight: 0.7,
        sparse_weight: 0.3,
      }).success,
    ).toBe(true);

    // Both set and mis-summed — one issue per contributing field.
    const bad = MemorySubstrateConfigSchema.safeParse({
      dense_weight: 0.7,
      sparse_weight: 0.7,
    });
    expect(bad.success).toBe(false);
    if (!bad.success) {
      const paths = bad.error.issues.map((issue) => issue.path.join("."));
      expect(paths.sort()).toEqual(["dense_weight", "sparse_weight"]);
      expect(bad.error.issues[0].message).toContain(
        "memory.substrate hybrid weights",
      );
    }
  });
});

describe("resolveSubstrateTuning", () => {
  test("substrate unset resolves to the v2 schema defaults", () => {
    const memory = MemoryConfigSchema.parse({});
    const tuning = resolveSubstrateTuning(memory);
    expect(tuning).toEqual({
      sweep_enabled: false,
      dense_weight: 0.85,
      sparse_weight: 0.15,
      min_sparse_spread: undefined,
      full_sparse_spread: undefined,
      bm25_k1: 1.2,
      bm25_b: 0.4,
      consolidation_interval_hours: 8,
      consolidation_max_buffer_lines: 100,
      consolidation_max_entries_per_run: 150,
      max_page_chars: 5000,
      consolidation_prompt_path: null,
      spread_k: 0.5,
      spread_hops: 2,
      ann_candidate_limit: null,
    });
  });

  test("substrate unset resolves to explicitly-set v2 values", () => {
    const memory = MemoryConfigSchema.parse({
      v2: {
        sweep_enabled: true,
        consolidation_interval_hours: 3,
        consolidation_max_buffer_lines: null,
        bm25_b: 0.9,
      },
    });
    const tuning = resolveSubstrateTuning(memory);
    expect(tuning.sweep_enabled).toBe(true);
    expect(tuning.consolidation_interval_hours).toBe(3);
    expect(tuning.consolidation_max_buffer_lines).toBeNull();
    expect(tuning.bm25_b).toBe(0.9);
  });

  test("a set substrate key wins over the v2 twin", () => {
    const memory = MemoryConfigSchema.parse({
      v2: {
        consolidation_interval_hours: 3,
        max_page_chars: 4000,
        sweep_enabled: true,
      },
      substrate: {
        consolidation_interval_hours: 12,
        max_page_chars: 9000,
        sweep_enabled: false,
      },
    });
    const tuning = resolveSubstrateTuning(memory);
    expect(tuning.consolidation_interval_hours).toBe(12);
    expect(tuning.max_page_chars).toBe(9000);
    expect(tuning.sweep_enabled).toBe(false);
  });

  test("spread_k / spread_hops map onto memory.v2.k / memory.v2.hops", () => {
    const fallback = resolveSubstrateTuning(
      MemoryConfigSchema.parse({ v2: { k: 0.7, hops: 4 } }),
    );
    expect(fallback.spread_k).toBe(0.7);
    expect(fallback.spread_hops).toBe(4);

    const overridden = resolveSubstrateTuning(
      MemoryConfigSchema.parse({
        v2: { k: 0.7, hops: 4 },
        substrate: { spread_k: 0.2, spread_hops: 1 },
      }),
    );
    expect(overridden.spread_k).toBe(0.2);
    expect(overridden.spread_hops).toBe(1);
  });

  test("an explicit substrate null wins over a non-null v2 value", () => {
    const memory = MemoryConfigSchema.parse({
      v2: {
        ann_candidate_limit: 500,
        consolidation_max_entries_per_run: 50,
      },
      substrate: {
        ann_candidate_limit: null,
        consolidation_max_entries_per_run: null,
      },
    });
    const tuning = resolveSubstrateTuning(memory);
    expect(tuning.ann_candidate_limit).toBeNull();
    expect(tuning.consolidation_max_entries_per_run).toBeNull();
  });
});
