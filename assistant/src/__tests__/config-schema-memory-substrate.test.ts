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
 *   - The parent memory schema validates the RESOLVED weight pair: a single
 *     substrate weight is paired with its `memory.v2` twin (schema default
 *     applied), and the effective sum must respect the sum-to-one invariant.
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
    // Only one weight set — no refinement at the substrate schema level; the
    // parent memory schema validates the resolved pair against the v2 twin.
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

  describe("resolved hybrid-weight invariant (memory schema level)", () => {
    // Parses `memory` through both entry points that must agree: the memory
    // slice schema and the full assistant config schema.
    const parseBothWays = (memory: unknown) => ({
      slice: MemoryConfigSchema.safeParse(memory),
      full: AssistantConfigSchema.safeParse({ memory }),
    });

    test("a lone substrate dense_weight that breaks the effective sum is rejected", () => {
      // v2 sparse_weight defaults to 0.15 → effective sum 1.05.
      const { slice, full } = parseBothWays({
        substrate: { dense_weight: 0.9 },
      });
      for (const result of [slice, full]) {
        expect(result.success).toBe(false);
        if (!result.success) {
          const issue = result.error.issues.find((candidate) =>
            candidate.message.includes(
              "memory hybrid weights must sum to 1.0 after memory.substrate → memory.v2 fallback",
            ),
          );
          expect(issue).toBeDefined();
          expect(issue?.message).toContain("0.9000");
          expect(issue?.message).toContain("0.1500");
          expect(issue?.message).toContain("1.0500");
          expect(issue?.path.slice(-2)).toEqual(["substrate", "dense_weight"]);
        }
      }
    });

    test("a lone substrate sparse_weight that breaks the effective sum is rejected", () => {
      // v2 dense_weight defaults to 0.85 → effective sum 1.35.
      const { slice, full } = parseBothWays({
        substrate: { sparse_weight: 0.5 },
      });
      for (const result of [slice, full]) {
        expect(result.success).toBe(false);
        if (!result.success) {
          const issue = result.error.issues.find((candidate) =>
            candidate.message.includes(
              "memory hybrid weights must sum to 1.0 after memory.substrate → memory.v2 fallback",
            ),
          );
          expect(issue).toBeDefined();
          expect(issue?.path.slice(-2)).toEqual(["substrate", "sparse_weight"]);
        }
      }
    });

    test("a complete substrate pair summing to 1.0 is accepted", () => {
      const { slice, full } = parseBothWays({
        substrate: { dense_weight: 0.9, sparse_weight: 0.1 },
      });
      expect(slice.success).toBe(true);
      expect(full.success).toBe(true);
    });

    test("a lone substrate weight matching the v2 default pair is accepted", () => {
      // 0.85 pairs with the v2 sparse_weight default 0.15 → effective sum 1.0.
      const { slice, full } = parseBothWays({
        substrate: { dense_weight: 0.85 },
      });
      expect(slice.success).toBe(true);
      expect(full.success).toBe(true);
    });

    test("a lone substrate weight pairing with an explicit v2 twin is accepted", () => {
      const { slice, full } = parseBothWays({
        v2: { dense_weight: 0.7, sparse_weight: 0.3 },
        substrate: { sparse_weight: 0.3 },
      });
      expect(slice.success).toBe(true);
      expect(full.success).toBe(true);
    });

    test("a mis-summed complete substrate pair only fires the substrate refinement", () => {
      // Both substrate weights set → the parent check skips; only the
      // substrate schema's own refinement reports, so the two never
      // contradict each other.
      const { slice, full } = parseBothWays({
        substrate: { dense_weight: 0.7, sparse_weight: 0.7 },
      });
      for (const result of [slice, full]) {
        expect(result.success).toBe(false);
        if (!result.success) {
          const messages = result.error.issues.map((issue) => issue.message);
          expect(
            messages.some((message) =>
              message.includes("memory.substrate hybrid weights"),
            ),
          ).toBe(true);
          expect(
            messages.some((message) =>
              message.includes(
                "memory hybrid weights must sum to 1.0 after memory.substrate → memory.v2 fallback",
              ),
            ),
          ).toBe(false);
        }
      }
    });
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
