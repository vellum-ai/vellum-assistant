// ---------------------------------------------------------------------------
// Memory substrate — Config tuning resolver
// ---------------------------------------------------------------------------

import type { MemoryConfig } from "../../../../config/types.js";

/**
 * Effective substrate tunables after namespace resolution. Key names match
 * the `memory.substrate` schema; `spread_k` / `spread_hops` are the
 * substrate names for `memory.v2.k` / `memory.v2.hops`.
 */
export type SubstrateTuning = {
  sweep_enabled: boolean;
  dense_weight: number;
  sparse_weight: number;
  min_sparse_spread: number | undefined;
  full_sparse_spread: number | undefined;
  bm25_k1: number;
  bm25_b: number;
  consolidation_interval_hours: number;
  consolidation_max_buffer_lines: number | null;
  consolidation_max_entries_per_run: number | null;
  max_page_chars: number;
  consolidation_prompt_path: string | null;
  spread_k: number;
  spread_hops: number;
  ann_candidate_limit: number | null;
};

/**
 * `memory.substrate` value when the key is present — an explicit `null` on a
 * nullable key counts as present and wins — and the `memory.v2` twin
 * otherwise.
 */
function orV2<T>(substrateValue: T | undefined, v2Value: T): T {
  return substrateValue !== undefined ? substrateValue : v2Value;
}

/**
 * The memory-config subset the resolver reads. `substrate` is accepted as
 * absent so hand-built partial config slices (test fixtures) resolve to the
 * `memory.v2` values; schema-parsed configs always carry it.
 */
type SubstrateTuningSource = Pick<MemoryConfig, "v2"> &
  Partial<Pick<MemoryConfig, "substrate">>;

/**
 * Single choke point for substrate tunables. Values resolve from
 * `memory.substrate`, falling back to the historical `memory.v2` keys, which
 * the v2 injection engine also reads — the v2 schema supplies the effective
 * defaults for keys neither namespace sets explicitly.
 */
export function resolveSubstrateTuning(
  memory: SubstrateTuningSource,
): SubstrateTuning {
  const substrate = memory.substrate ?? {};
  const v2 = memory.v2;
  return {
    sweep_enabled: orV2(substrate.sweep_enabled, v2.sweep_enabled),
    dense_weight: orV2(substrate.dense_weight, v2.dense_weight),
    sparse_weight: orV2(substrate.sparse_weight, v2.sparse_weight),
    min_sparse_spread: orV2(substrate.min_sparse_spread, v2.min_sparse_spread),
    full_sparse_spread: orV2(
      substrate.full_sparse_spread,
      v2.full_sparse_spread,
    ),
    bm25_k1: orV2(substrate.bm25_k1, v2.bm25_k1),
    bm25_b: orV2(substrate.bm25_b, v2.bm25_b),
    consolidation_interval_hours: orV2(
      substrate.consolidation_interval_hours,
      v2.consolidation_interval_hours,
    ),
    consolidation_max_buffer_lines: orV2(
      substrate.consolidation_max_buffer_lines,
      v2.consolidation_max_buffer_lines,
    ),
    consolidation_max_entries_per_run: orV2(
      substrate.consolidation_max_entries_per_run,
      v2.consolidation_max_entries_per_run,
    ),
    max_page_chars: orV2(substrate.max_page_chars, v2.max_page_chars),
    consolidation_prompt_path: orV2(
      substrate.consolidation_prompt_path,
      v2.consolidation_prompt_path,
    ),
    spread_k: orV2(substrate.spread_k, v2.k),
    spread_hops: orV2(substrate.spread_hops, v2.hops),
    ann_candidate_limit: orV2(
      substrate.ann_candidate_limit,
      v2.ann_candidate_limit,
    ),
  };
}
