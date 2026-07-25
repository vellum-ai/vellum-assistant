// ---------------------------------------------------------------------------
// Memory substrate — twin-namespace shadowing detection
// ---------------------------------------------------------------------------

/**
 * `memory.v2` key → `memory.substrate` key, for the fifteen substrate tunables
 * that exist in both namespaces. `k` / `hops` are the historical `memory.v2`
 * names for `spread_k` / `spread_hops`; every other key shares its name with
 * its twin.
 *
 * The runtime precedence lives in `resolveSubstrateTuning`
 * (`plugins/defaults/memory/substrate/tuning.ts`), which resolves each tunable
 * as `memory.substrate.X ?? memory.v2.X`. This table is the config surface's
 * view of the same pairing, kept honest by
 * `__tests__/substrate-twin-shadowing.test.ts`, which asserts it covers exactly
 * the `memory.substrate` schema's keys.
 */
export const SUBSTRATE_KEY_BY_V2_KEY: Readonly<Record<string, string>> = {
  sweep_enabled: "sweep_enabled",
  dense_weight: "dense_weight",
  sparse_weight: "sparse_weight",
  min_sparse_spread: "min_sparse_spread",
  full_sparse_spread: "full_sparse_spread",
  bm25_k1: "bm25_k1",
  bm25_b: "bm25_b",
  consolidation_interval_hours: "consolidation_interval_hours",
  consolidation_max_buffer_lines: "consolidation_max_buffer_lines",
  consolidation_max_entries_per_run: "consolidation_max_entries_per_run",
  max_page_chars: "max_page_chars",
  consolidation_prompt_path: "consolidation_prompt_path",
  k: "spread_k",
  hops: "spread_hops",
  ann_candidate_limit: "ann_candidate_limit",
};

/** A `memory.substrate` value that wins over the `memory.v2` key it shadows. */
export type SubstrateShadowing = {
  /** Dotted path of the winning key, e.g. `memory.substrate.spread_k`. */
  substratePath: string;
  /** The winning key's persisted value — the effective tunable. */
  substrateValue: unknown;
};

function readPlainObject(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The `memory.substrate` twin that shadows `path`, or `undefined` when `path`
 * is not a shadowable `memory.v2` tunable or its twin is unset.
 *
 * `memory.substrate` is override-only and wins whenever its key is present, so
 * a write to (or read of) the `memory.v2` twin is inert once the substrate key
 * exists — including when it holds an explicit `null`, which
 * `resolveSubstrateTuning` treats as present. Detection therefore keys on
 * presence, not truthiness.
 *
 * `raw` is the unparsed config object (`loadRawConfig()` / the `config_get`
 * payload), so the check sees exactly what is persisted.
 */
export function findSubstrateShadowing(
  raw: Record<string, unknown>,
  path: string,
): SubstrateShadowing | undefined {
  const segments = path.split(".");
  if (segments.length !== 3 || segments[0] !== "memory") {
    return undefined;
  }
  const [, namespace, key] = segments as [string, string, string];
  if (namespace !== "v2") {
    return undefined;
  }
  const substrateKey = SUBSTRATE_KEY_BY_V2_KEY[key];
  if (substrateKey === undefined) {
    return undefined;
  }
  const substrate = readPlainObject(readPlainObject(raw.memory)?.substrate);
  if (!substrate || !(substrateKey in substrate)) {
    return undefined;
  }
  return {
    substratePath: `memory.substrate.${substrateKey}`,
    substrateValue: substrate[substrateKey],
  };
}

/**
 * Operator-facing warning for a `config set` that lands on a shadowed
 * `memory.v2` tunable: the write persists but changes no behavior, so it names
 * the winning key and the command that actually retunes it.
 */
export function describeShadowedConfigSet(
  shadowing: SubstrateShadowing,
  path: string,
): string {
  const value = JSON.stringify(shadowing.substrateValue) ?? "undefined";
  return (
    `${shadowing.substratePath} is set (${value}) and takes precedence over ${path}, ` +
    `so this write does not change the effective value. ` +
    `Run 'assistant config set ${shadowing.substratePath} <value>' to retune it.`
  );
}
