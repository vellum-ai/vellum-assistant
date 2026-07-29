// ---------------------------------------------------------------------------
// Memory substrate — twin-namespace shadowing detection
// ---------------------------------------------------------------------------

/** One `memory.v2` tunable's `memory.substrate` twin. */
interface SubstrateTwin {
  /** The twin's `memory.substrate` key, e.g. `spread_k` for `k`. */
  readonly substrateKey: string;
  /**
   * Whether the v2 injection engine reads the `memory.v2` key straight out of
   * its own namespace (`v2/injection.ts`, `v2/activation.ts`,
   * `v2/backfill-jobs.ts`) rather than through `resolveSubstrateTuning`. For
   * these keys the two namespaces feed two different consumers, so a
   * `memory.v2` write retunes the v2 engine while substrate recall keeps
   * reading the substrate twin — the pair can hold different effective values
   * at once.
   */
  readonly alsoReadByV2Engine: boolean;
}

/**
 * `memory.v2` key → its `memory.substrate` twin, for the fifteen substrate
 * tunables that exist in both namespaces. `k` / `hops` are the historical
 * `memory.v2` names for `spread_k` / `spread_hops`; every other key shares its
 * name with its twin.
 *
 * Substrate precedence lives in `resolveSubstrateTuning`
 * (`plugins/defaults/memory/substrate/tuning.ts`), which resolves each tunable
 * as `memory.substrate.X ?? memory.v2.X`. Twelve keys reach the runtime only
 * through that resolver; the three carrying `alsoReadByV2Engine` are read a
 * second time by the live v2 injection engine off `config.memory.v2` directly.
 *
 * This table is the config surface's view of the same pairing, kept honest by
 * `__tests__/substrate-twin-shadowing.test.ts`, which asserts it covers exactly
 * the `memory.substrate` schema's keys.
 */
export const SUBSTRATE_TWIN_BY_V2_KEY: Readonly<Record<string, SubstrateTwin>> =
  {
    sweep_enabled: { substrateKey: "sweep_enabled", alsoReadByV2Engine: false },
    dense_weight: { substrateKey: "dense_weight", alsoReadByV2Engine: false },
    sparse_weight: { substrateKey: "sparse_weight", alsoReadByV2Engine: false },
    min_sparse_spread: {
      substrateKey: "min_sparse_spread",
      alsoReadByV2Engine: false,
    },
    full_sparse_spread: {
      substrateKey: "full_sparse_spread",
      alsoReadByV2Engine: false,
    },
    bm25_k1: { substrateKey: "bm25_k1", alsoReadByV2Engine: false },
    bm25_b: { substrateKey: "bm25_b", alsoReadByV2Engine: false },
    consolidation_interval_hours: {
      substrateKey: "consolidation_interval_hours",
      alsoReadByV2Engine: false,
    },
    consolidation_max_buffer_lines: {
      substrateKey: "consolidation_max_buffer_lines",
      alsoReadByV2Engine: false,
    },
    consolidation_max_entries_per_run: {
      substrateKey: "consolidation_max_entries_per_run",
      alsoReadByV2Engine: false,
    },
    max_page_chars: {
      substrateKey: "max_page_chars",
      alsoReadByV2Engine: false,
    },
    consolidation_prompt_path: {
      substrateKey: "consolidation_prompt_path",
      alsoReadByV2Engine: false,
    },
    // The v2 injection engine reads these three off `config.memory.v2`:
    // `k` / `hops` in `v2/injection.ts` and `v2/backfill-jobs.ts`,
    // `ann_candidate_limit` in `v2/activation.ts`.
    k: { substrateKey: "spread_k", alsoReadByV2Engine: true },
    hops: { substrateKey: "spread_hops", alsoReadByV2Engine: true },
    ann_candidate_limit: {
      substrateKey: "ann_candidate_limit",
      alsoReadByV2Engine: true,
    },
  };

/** A `memory.substrate` value set on the twin of a given `memory.v2` key. */
export type SubstrateShadowing = {
  /** Dotted path of the twin, e.g. `memory.substrate.spread_k`. */
  substratePath: string;
  /** The twin's persisted value — what substrate recall resolves to. */
  substrateValue: unknown;
  /**
   * Whether the v2 injection engine also reads the `memory.v2` key directly,
   * so the write is not inert (see {@link SubstrateTwin.alsoReadByV2Engine}).
   */
  alsoReadByV2Engine: boolean;
};

function readPlainObject(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The `memory.substrate` twin covering `path`, or `undefined` when `path` is
 * not a shadowable `memory.v2` tunable or its twin is unset.
 *
 * `memory.substrate` is override-only and wins for substrate recall whenever
 * its key is present — including when it holds an explicit `null`, which
 * `resolveSubstrateTuning` treats as present. Detection therefore keys on
 * presence, not truthiness. What that means for the `memory.v2` key depends on
 * `alsoReadByV2Engine`: for a substrate-only twin the `memory.v2` value has no
 * remaining consumer, while for the three engine-read twins it still tunes v2
 * injection.
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
  const twin = SUBSTRATE_TWIN_BY_V2_KEY[key];
  if (twin === undefined) {
    return undefined;
  }
  const substrate = readPlainObject(readPlainObject(raw.memory)?.substrate);
  if (!substrate || !(twin.substrateKey in substrate)) {
    return undefined;
  }
  return {
    substratePath: `memory.substrate.${twin.substrateKey}`,
    substrateValue: substrate[twin.substrateKey],
    alsoReadByV2Engine: twin.alsoReadByV2Engine,
  };
}

/**
 * Operator-facing warning for a `config set` on a `memory.v2` tunable whose
 * `memory.substrate` twin is set.
 *
 * Two classes, two messages. A substrate-only twin leaves the write with no
 * consumer, so the warning names the winning key and the command that actually
 * retunes it. An engine-read twin (`k`, `hops`, `ann_candidate_limit`) makes
 * the write effective for v2 injection while substrate recall stays on the
 * twin, so the warning reports the split rather than a no-op.
 */
export function describeShadowedConfigSet(
  shadowing: SubstrateShadowing,
  path: string,
): string {
  const value = JSON.stringify(shadowing.substrateValue) ?? "undefined";
  if (shadowing.alsoReadByV2Engine) {
    return (
      `${path} is read directly by the memory-v2 injection engine, so this write ` +
      `does change its behavior. Substrate recall reads ${shadowing.substratePath} ` +
      `(${value}) instead, so the two can diverge. ` +
      `Run 'assistant config set ${shadowing.substratePath} <value>' to move substrate recall with it.`
    );
  }
  return (
    `${shadowing.substratePath} is set (${value}) and takes precedence over ${path}, ` +
    `so this write does not change the effective value. ` +
    `Run 'assistant config set ${shadowing.substratePath} <value>' to retune it.`
  );
}

/**
 * Operator-facing annotation for a `config get` of a `memory.v2` tunable whose
 * `memory.substrate` twin is set — the read-side counterpart of
 * {@link describeShadowedConfigSet}, split along the same two classes so a read
 * never confirms a value the runtime ignores nor denies one it honors.
 */
export function describeShadowedConfigGet(
  shadowing: SubstrateShadowing,
  path: string,
): string {
  const value = JSON.stringify(shadowing.substrateValue) ?? "undefined";
  if (shadowing.alsoReadByV2Engine) {
    return (
      `Split: ${shadowing.substratePath} = ${value} is the effective value for ` +
      `substrate recall, while the memory-v2 injection engine reads ${path} above.`
    );
  }
  return (
    `Shadowed: ${shadowing.substratePath} = ${value} takes precedence and is ` +
    `the effective value.`
  );
}
