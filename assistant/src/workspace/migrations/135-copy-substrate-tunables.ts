import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getLogger } from "../../util/logger.js";
import type { WorkspaceMigration } from "./types.js";

const log = getLogger("workspace-migration-135");

/**
 * Marks the two optional `memory.v2` keys that ship with no schema default
 * (`min_sparse_spread`, `full_sparse_spread`) — for those, raw presence IS
 * user intent, so they copy on presence alone.
 */
const NO_DEFAULT: unique symbol = Symbol("no-default");

/**
 * The fifteen substrate tunables shared between the historical `memory.v2`
 * namespace and the new `memory.substrate` namespace, each paired with the
 * shipped `memory.v2` schema default (from `config/schemas/memory-v2.ts`).
 * `memory.v2.k` and `memory.v2.hops` were renamed to `spread_k` /
 * `spread_hops` on the substrate side; every other key keeps its name.
 *
 * The defaults matter because raw presence in config.json is NOT user intent:
 * the config loader serializes the fully-parsed configuration for
 * normally-created workspaces, so defaulted `memory.v2` leaves are persisted
 * for most existing assistants. Copying those seeded values would populate
 * the override-only `memory.substrate` namespace with today's defaults and
 * permanently pin those assistants when substrate defaults are later retuned
 * — the same default-pinning problem migration 119 solves for `memory.v3`
 * tuning, distinguished the same way (value-vs-shipped-default comparison,
 * table inlined per the migrations self-containment rule).
 */
const SUBSTRATE_KEY_PAIRS: ReadonlyArray<{
  v2Key: string;
  substrateKey: string;
  shippedDefault: number | boolean | string | null | typeof NO_DEFAULT;
  /**
   * Additional values the loader has seeded as this key's default in earlier
   * releases (multi-default keys, mirroring migration 119). A persisted value
   * matching any of them is seeded, not a user override.
   */
  priorDefaults?: ReadonlyArray<number | boolean | string | null>;
}> = [
  {
    v2Key: "sweep_enabled",
    substrateKey: "sweep_enabled",
    shippedDefault: false,
  },
  { v2Key: "dense_weight", substrateKey: "dense_weight", shippedDefault: 0.85 },
  {
    v2Key: "sparse_weight",
    substrateKey: "sparse_weight",
    shippedDefault: 0.15,
  },
  {
    v2Key: "min_sparse_spread",
    substrateKey: "min_sparse_spread",
    shippedDefault: NO_DEFAULT,
  },
  {
    v2Key: "full_sparse_spread",
    substrateKey: "full_sparse_spread",
    shippedDefault: NO_DEFAULT,
  },
  { v2Key: "bm25_k1", substrateKey: "bm25_k1", shippedDefault: 1.2 },
  {
    v2Key: "bm25_b",
    substrateKey: "bm25_b",
    shippedDefault: 0.4,
    // Workspaces seeded before migration 075 carry the earlier 0.75 default.
    priorDefaults: [0.75],
  },
  {
    v2Key: "consolidation_interval_hours",
    substrateKey: "consolidation_interval_hours",
    shippedDefault: 8,
  },
  {
    v2Key: "consolidation_max_buffer_lines",
    substrateKey: "consolidation_max_buffer_lines",
    shippedDefault: 100,
  },
  {
    v2Key: "consolidation_max_entries_per_run",
    substrateKey: "consolidation_max_entries_per_run",
    shippedDefault: 150,
  },
  {
    v2Key: "max_page_chars",
    substrateKey: "max_page_chars",
    shippedDefault: 5000,
  },
  {
    v2Key: "consolidation_prompt_path",
    substrateKey: "consolidation_prompt_path",
    shippedDefault: null,
  },
  { v2Key: "k", substrateKey: "spread_k", shippedDefault: 0.5 },
  { v2Key: "hops", substrateKey: "spread_hops", shippedDefault: 2 },
  {
    v2Key: "ann_candidate_limit",
    substrateKey: "ann_candidate_limit",
    shippedDefault: null,
  },
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Copy user-overridden substrate tunables from `memory.v2` to
 * `memory.substrate` so the substrate namespace carries the user's tuned
 * values itself, independent of the runtime resolver's substrate→v2 fallback.
 *
 * Value-based, not presence-based: a key is copied only when it is present
 * under `memory.v2`, absent under `memory.substrate`, AND its value differs
 * from the shipped v2 schema default. The config loader persists the
 * fully-parsed configuration for normally-created workspaces, so a defaulted
 * `memory.v2` leaf in config.json is seeded, not user intent — copying it
 * would pin the assistant to today's value when substrate defaults are later
 * retuned (migration 119's rationale). A persisted value equal to its shipped
 * default is treated as seeded even if a user typed it deliberately — the
 * acceptable trade-off 119 already makes — so `memory.substrate` stays an
 * override-only surface. The two no-default keys (`min_sparse_spread`,
 * `full_sparse_spread`) copy on presence alone.
 *
 * That rule is narrower than "explicitly present", and the gap is deliberate:
 * a value equal to a shipped default never copies, even when the user typed it
 * on purpose. For every key whose shipped default is the current one that costs
 * nothing — `memory.substrate` plus the shipped defaults resolve to exactly
 * what the resolver's fallback produces. `bm25_b`'s retired `0.75` is the sole
 * exception: it is skipped as seeded yet differs from today's `0.4`, so on a
 * workspace carrying it the value survives only through the resolver's
 * `memory.v2` fallback. That is the one case where dropping the fallback would
 * change behavior — see the equivalence proof in this migration's test.
 *
 * `memory.v2.*` is never modified — the v2 injection engine still reads it.
 * An already-present `memory.substrate` key is never clobbered. `memory.substrate` is only
 * written at all when at least one key copies, so a fresh config never gains
 * an empty object.
 *
 * Weight-pair safety: copying cannot create an invalid config. The v2
 * schema's own refinement validates `dense_weight + sparse_weight` on the
 * PERSISTED values (absent leaves resolve to defaults before the check), so a
 * valid config carrying a non-default weight necessarily carries its
 * non-default twin — both differ from their defaults, both copy, and the
 * copied substrate pair is exactly the pair v2 already accepted.
 */
export const copySubstrateTunablesMigration: WorkspaceMigration = {
  id: "135-copy-substrate-tunables",
  description:
    "Copy memory.v2 substrate tunables that differ from their shipped defaults to memory.substrate (k→spread_k, hops→spread_hops) without touching memory.v2, clobbering existing memory.substrate values, or pinning loader-seeded defaults",
  // run() only ever adds missing memory.substrate keys and never clobbers
  // present ones, so retrying after a failed write attempt is safe.
  retryFailedCheckpoint: true,

  run(workspaceDir: string): void {
    const configPath = join(workspaceDir, "config.json");
    if (!existsSync(configPath)) {
      return;
    }

    // A filesystem read failure propagates so the failed checkpoint retries
    // on the next boot; only malformed JSON is a permanent no-op (the config
    // loader owns surfacing that error).
    const rawText = readFileSync(configPath, "utf-8");
    let config: Record<string, unknown>;
    try {
      const raw = JSON.parse(rawText);
      if (!isPlainObject(raw)) {
        return;
      }
      config = raw;
    } catch {
      return;
    }

    const memory = config.memory;
    if (!isPlainObject(memory)) {
      return;
    }
    const v2 = memory.v2;
    if (!isPlainObject(v2)) {
      return;
    }
    // A malformed (non-object) persisted memory.substrate is left alone — the
    // config loader surfaces that error; this migration must not clobber it.
    if (memory.substrate !== undefined && !isPlainObject(memory.substrate)) {
      return;
    }

    // Staged separately so memory.substrate is only attached when a key
    // actually copies — never introduce an empty object.
    const substrate: Record<string, unknown> = isPlainObject(memory.substrate)
      ? memory.substrate
      : {};

    let copied = false;
    for (const {
      v2Key,
      substrateKey,
      shippedDefault,
      priorDefaults,
    } of SUBSTRATE_KEY_PAIRS) {
      if (!(v2Key in v2) || substrateKey in substrate) {
        continue;
      }
      // A persisted value equal to a shipped default (current or from an
      // earlier release) is loader-seeded, not a user override — skip it so
      // the substrate namespace stays override-only. Strict equality
      // suffices: every tunable value is a primitive or null.
      const value = v2[v2Key];
      if (shippedDefault !== NO_DEFAULT && value === shippedDefault) {
        continue;
      }
      if (priorDefaults?.some((seeded) => seeded === value)) {
        continue;
      }
      substrate[substrateKey] = v2[v2Key];
      copied = true;
    }
    if (!copied) {
      return;
    }
    memory.substrate = substrate;

    // Write-then-rename keeps the migration rerunnable: a crash mid-write
    // must not leave a truncated config.json that a retry reads as malformed
    // and "completes" past, stranding the user's v2 overrides. A write or
    // rename failure propagates to the runner, which checkpoints this
    // migration as failed and (via retryFailedCheckpoint) retries it on the
    // next boot instead of recording it as completed.
    const tmpPath = `${configPath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(config, null, 2) + "\n");
    renameSync(tmpPath, configPath);
    log.info(
      "Copied non-default memory.v2 substrate tunables to memory.substrate",
    );
  },

  down(_workspaceDir: string): void {
    // Forward-only: a copied value is indistinguishable from one the user set
    // under memory.substrate directly, so removal could destroy deliberate
    // overrides. The copy is also behavior-preserving, so there is nothing to
    // unwind.
  },
};
