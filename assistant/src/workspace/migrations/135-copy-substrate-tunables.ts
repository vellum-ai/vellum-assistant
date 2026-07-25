import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getLogger } from "../../util/logger.js";
import type { WorkspaceMigration } from "./types.js";

const log = getLogger("workspace-migration-135");

/**
 * The fifteen substrate tunables shared between the historical `memory.v2`
 * namespace and the new `memory.substrate` namespace. `memory.v2.k` and
 * `memory.v2.hops` were renamed to `spread_k` / `spread_hops` on the substrate
 * side; every other key keeps its name.
 *
 * Inlined per the migrations self-containment rule (no `../../config/`
 * imports).
 */
const SUBSTRATE_KEY_PAIRS: ReadonlyArray<{
  v2Key: string;
  substrateKey: string;
}> = [
  { v2Key: "sweep_enabled", substrateKey: "sweep_enabled" },
  { v2Key: "dense_weight", substrateKey: "dense_weight" },
  { v2Key: "sparse_weight", substrateKey: "sparse_weight" },
  { v2Key: "min_sparse_spread", substrateKey: "min_sparse_spread" },
  { v2Key: "full_sparse_spread", substrateKey: "full_sparse_spread" },
  { v2Key: "bm25_k1", substrateKey: "bm25_k1" },
  { v2Key: "bm25_b", substrateKey: "bm25_b" },
  {
    v2Key: "consolidation_interval_hours",
    substrateKey: "consolidation_interval_hours",
  },
  {
    v2Key: "consolidation_max_buffer_lines",
    substrateKey: "consolidation_max_buffer_lines",
  },
  {
    v2Key: "consolidation_max_entries_per_run",
    substrateKey: "consolidation_max_entries_per_run",
  },
  { v2Key: "max_page_chars", substrateKey: "max_page_chars" },
  {
    v2Key: "consolidation_prompt_path",
    substrateKey: "consolidation_prompt_path",
  },
  { v2Key: "k", substrateKey: "spread_k" },
  { v2Key: "hops", substrateKey: "spread_hops" },
  { v2Key: "ann_candidate_limit", substrateKey: "ann_candidate_limit" },
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Copy explicitly-set substrate tunables from `memory.v2` to
 * `memory.substrate` so the substrate namespace becomes self-sufficient before
 * the runtime resolver's substrate→v2 fallback (and eventually the whole
 * `memory.v2` subtree) is deleted.
 *
 * Presence-based, not value-based: a key is copied when it is EXPLICITLY
 * present under `memory.v2` and absent under `memory.substrate` — an explicit
 * `null` on a nullable key (`ann_candidate_limit`,
 * `consolidation_prompt_path`, ...) is an explicit value and is copied, since
 * the resolver treats an explicit substrate `null` as set. The common case is
 * a no-op: `memory.v2` tuning defaults were never persisted to config.json.
 *
 * `memory.v2.*` is never modified — the v2 injection engine still reads it
 * until the whole subtree is deleted with v2. An already-present
 * `memory.substrate` key is never clobbered. `memory.substrate` is only
 * written at all when at least one key copies, so a fresh config never gains
 * an empty object.
 *
 * Weight-pair safety: copying a lone explicit weight (say `dense_weight`)
 * cannot create an invalid config. The parent memory schema validates the
 * RESOLVED pair — the copied substrate weight plus the `memory.v2` fallback
 * for its twin — which is exactly the pair the v2 schema's own refinement
 * already accepted before the migration. Same effective values, same
 * validity.
 */
export const copySubstrateTunablesMigration: WorkspaceMigration = {
  id: "135-copy-substrate-tunables",
  description:
    "Copy explicitly-set memory.v2 substrate tunables to memory.substrate (k→spread_k, hops→spread_hops) without touching memory.v2 or clobbering existing memory.substrate values",

  run(workspaceDir: string): void {
    const configPath = join(workspaceDir, "config.json");
    if (!existsSync(configPath)) {
      return;
    }

    let config: Record<string, unknown>;
    try {
      const raw = JSON.parse(readFileSync(configPath, "utf-8"));
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
    for (const { v2Key, substrateKey } of SUBSTRATE_KEY_PAIRS) {
      if (v2Key in v2 && !(substrateKey in substrate)) {
        substrate[substrateKey] = v2[v2Key];
        copied = true;
      }
    }
    if (!copied) {
      return;
    }
    memory.substrate = substrate;

    try {
      writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
      log.info(
        "Copied explicitly-set memory.v2 substrate tunables to memory.substrate",
      );
    } catch (err) {
      log.warn({ err }, "Failed to write config.json with copied tunables");
    }
  },

  down(_workspaceDir: string): void {
    // Forward-only: a copied value is indistinguishable from one the user set
    // under memory.substrate directly, so removal could destroy deliberate
    // overrides. The copy is also behavior-preserving, so there is nothing to
    // unwind.
  },
};
