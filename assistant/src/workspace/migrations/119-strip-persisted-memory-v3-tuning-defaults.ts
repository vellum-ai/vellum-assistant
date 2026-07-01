import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getLogger } from "../../util/logger.js";
import type { WorkspaceMigration } from "./types.js";

const log = getLogger("workspace-migration-119");

/**
 * Every memory.v3 tuning leaf paired with the schema default value(s) it has
 * ever shipped.
 *
 * The first-launch seed used to write the fully-defaulted config.json to disk,
 * so an assistant seeded before this migration (and the matching loader change
 * that stops persisting v3 tuning) persisted EVERY tuning knob as an explicit
 * value. Those persisted values then shadow any future schema-default change
 * (e.g. the gate-threshold retune), pinning the assistant forever. Stripping a
 * leaf whose persisted value equals a shipped default lets the schema default
 * re-apply on load and, crucially, keeps tracking future default changes.
 *
 * `memory.v3.live` is NEVER touched: it is genuine per-assistant state (some
 * workspaces predate the v3 migration and must stay on v2), not a tuning
 * default.
 *
 * Per-leaf (not whole-signature): a config with a deliberate override on one
 * knob keeps that override while its other defaulted knobs are still stripped.
 * A value equal to a shipped default is treated as seeded even if a user typed
 * it deliberately — for these internal tuning knobs that trade-off is acceptable
 * (mirrors 117). Values matching no shipped default are preserved.
 *
 * Gate thresholds that were retuned carry their superseded defaults too, so
 * assistants seeded at the earlier values also normalize. Likewise the retired
 * LEAN-profile defaults (needleK 12, denseK 0, replyQueryK 0, selectorEnabled
 * false, hotSet.k / freshSet.k 8, learnedEdges.cap 0, edge.seedCount 6,
 * edge.perSeed 1, edge.cap 6) are included: migration 117 only un-pins them on
 * an exact full lean signature, so a mixed lean-era config (one lean leaf later
 * edited) reaches this per-leaf pass with the rest still lean-pinned — listing
 * the lean values here strips those too.
 *
 * Inlined per the migrations self-containment rule.
 */
const TUNING_LEAVES: ReadonlyArray<{
  parent: string | null;
  key: string;
  defaults: ReadonlyArray<number | boolean | string | null>;
}> = [
  { parent: null, key: "needleK", defaults: [100, 12] },
  { parent: null, key: "denseK", defaults: [100, 0] },
  { parent: null, key: "replyQueryK", defaults: [12, 0] },
  { parent: null, key: "selectorEnabled", defaults: [true, false] },
  { parent: null, key: "selectorPromptPath", defaults: [null] },
  { parent: "prune", key: "maxResidentBytes", defaults: [393216] },
  { parent: "prune", key: "targetResidentBytes", defaults: [262144] },
  { parent: "hotSet", key: "k", defaults: [40, 8] },
  { parent: "hotSet", key: "halfLifeDays", defaults: [14] },
  { parent: "freshSet", key: "k", defaults: [100, 8] },
  { parent: "learnedEdges", key: "halfLifeDays", defaults: [30] },
  { parent: "learnedEdges", key: "minCount", defaults: [3] },
  { parent: "learnedEdges", key: "npmiFloor", defaults: [0.2] },
  { parent: "learnedEdges", key: "maxPerPage", defaults: [6] },
  { parent: "learnedEdges", key: "perSeed", defaults: [3] },
  { parent: "learnedEdges", key: "cap", defaults: [20, 0] },
  { parent: "spotlight", key: "n", defaults: [6] },
  { parent: "spotlight", key: "windowTurns", defaults: [2] },
  { parent: "edge", key: "hubDegree", defaults: [30] },
  { parent: "edge", key: "seedCount", defaults: [18, 6] },
  { parent: "edge", key: "perSeed", defaults: [6, 1] },
  { parent: "edge", key: "cap", defaults: [45, 6] },
  { parent: "entity", key: "enabled", defaults: [true] },
  { parent: "entity", key: "idfFloor", defaults: [4] },
  { parent: "entity", key: "cap", defaults: [8] },
  // Gate thresholds — current default first, then superseded values.
  { parent: "gate", key: "denseThreshold", defaults: [0.66, 0.52] },
  { parent: "gate", key: "sparseThreshold", defaults: [0.35] },
  { parent: "gate", key: "sparseOnlyThreshold", defaults: [0.75, 0.62, 0.45] },
  { parent: "gate", key: "denseClusterThreshold", defaults: [0.6, 0.47] },
  { parent: "gate", key: "denseClusterMaxDelta", defaults: [0.02, 0.04] },
  { parent: "gate", key: "topK", defaults: [5] },
  { parent: "gate", key: "bm25NormK", defaults: [null] },
  { parent: "gate", key: "bypassForCore", defaults: [false] },
];

/** Nested tuning objects, dropped wholesale once emptied by leaf stripping. */
const TUNING_PARENTS = [
  "prune",
  "hotSet",
  "freshSet",
  "learnedEdges",
  "spotlight",
  "edge",
  "entity",
  "gate",
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

export const stripPersistedMemoryV3TuningDefaultsMigration: WorkspaceMigration =
  {
    id: "119-strip-persisted-memory-v3-tuning-defaults",
    description:
      "Strip persisted memory.v3 tuning knobs whose values match a shipped schema default so future default changes propagate to already-seeded assistants; preserves memory.v3.live and deliberate non-default overrides",

    run(workspaceDir: string): void {
      const configPath = join(workspaceDir, "config.json");
      if (!existsSync(configPath)) return;

      let config: Record<string, unknown>;
      try {
        const raw = JSON.parse(readFileSync(configPath, "utf-8"));
        if (!isPlainObject(raw)) return;
        config = raw;
      } catch {
        return;
      }

      const memory = config.memory;
      if (!isPlainObject(memory)) return;
      const v3 = memory.v3;
      if (!isPlainObject(v3)) return;

      let changed = false;

      for (const leaf of TUNING_LEAVES) {
        const container =
          leaf.parent === null
            ? v3
            : isPlainObject(v3[leaf.parent])
              ? (v3[leaf.parent] as Record<string, unknown>)
              : undefined;
        if (container === undefined || !(leaf.key in container)) continue;
        if (
          (leaf.defaults as ReadonlyArray<unknown>).includes(
            container[leaf.key],
          )
        ) {
          delete container[leaf.key];
          changed = true;
        }
      }

      // Drop now-empty tuning parents so they resolve wholesale from the schema.
      for (const parent of TUNING_PARENTS) {
        const child = v3[parent];
        if (isPlainObject(child) && Object.keys(child).length === 0) {
          delete v3[parent];
          changed = true;
        }
      }

      if (!changed) return;

      try {
        writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
        log.info(
          "Stripped persisted memory-v3 tuning defaults from config.json",
        );
      } catch (err) {
        log.warn({ err }, "Failed to write normalized config.json");
      }
    },

    down(_workspaceDir: string): void {
      // Forward-only: a stripped default is indistinguishable from a value the
      // user never set, and re-adding it would re-freeze the assistant at the
      // old default and defeat the purpose.
    },
  };
