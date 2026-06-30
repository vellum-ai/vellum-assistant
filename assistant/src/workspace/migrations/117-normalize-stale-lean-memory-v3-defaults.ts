import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getLogger } from "../../util/logger.js";
import type { WorkspaceMigration } from "./types.js";

const log = getLogger("workspace-migration-117");

/**
 * The memory-v3 tuning leaves whose schema defaults switched between the lean
 * (TTFT-oriented) profile and the restored full profile, each paired with its
 * retired lean default.
 *
 * The first-launch seed writes the fully-defaulted config.json to disk, so an
 * assistant first launched during the lean-default window persisted ALL of
 * these at lean — they then read back as explicit values and would pin the
 * assistant to the lean profile forever once its corpus passed the v3
 * full-profile threshold. The migration deletes the leaves so the restored full
 * schema defaults re-apply.
 *
 * To avoid clobbering a deliberate lean-valued override on a config that was NOT
 * lean-seeded, the migration acts only on the exact lean-seed signature: every
 * leaf present and equal to its lean default. A partial or mixed config (e.g. a
 * lone deliberate `denseK: 0`, or any non-lean tuning) does not match and is
 * left untouched. Fields the lean profile never changed (hotSet.halfLifeDays,
 * edge.hubDegree, the learnedEdges math fields, spotlight, prune) are not part
 * of the signature and are never touched.
 *
 * Inlined per the migrations self-containment rule.
 */
const LEAN_LEAVES: ReadonlyArray<{
  parent: string | null;
  key: string;
  lean: number | boolean;
}> = [
  { parent: null, key: "needleK", lean: 12 },
  { parent: null, key: "denseK", lean: 0 },
  { parent: null, key: "replyQueryK", lean: 0 },
  { parent: null, key: "selectorEnabled", lean: false },
  { parent: "hotSet", key: "k", lean: 8 },
  { parent: "freshSet", key: "k", lean: 8 },
  { parent: "learnedEdges", key: "cap", lean: 0 },
  { parent: "edge", key: "seedCount", lean: 6 },
  { parent: "edge", key: "perSeed", lean: 1 },
  { parent: "edge", key: "cap", lean: 6 },
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

export const normalizeStaleLeanMemoryV3DefaultsMigration: WorkspaceMigration = {
  id: "117-normalize-stale-lean-memory-v3-defaults",
  description:
    "Strip persisted memory.v3 tuning values matching the retired lean-default seed signature so the restored full schema defaults re-apply for assistants seeded during the lean-default window",

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

    // Resolve each switched leaf to its container object + presence/value.
    const resolved = LEAN_LEAVES.map((leaf) => {
      const container =
        leaf.parent === null
          ? v3
          : isPlainObject(v3[leaf.parent])
            ? (v3[leaf.parent] as Record<string, unknown>)
            : undefined;
      return { leaf, container };
    });

    // Act only on the exact lean-seed signature: every switched leaf present and
    // still equal to its lean default. Anything else (a deliberate lean
    // override, a mixed/partial config, or a pre-lean full seed) is preserved.
    const isLeanSeed = resolved.every(
      ({ leaf, container }) =>
        container !== undefined &&
        leaf.key in container &&
        container[leaf.key] === leaf.lean,
    );
    if (!isLeanSeed) return;

    for (const { leaf, container } of resolved) {
      delete container![leaf.key];
    }

    try {
      writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
      log.info(
        "Stripped stale lean memory-v3 tuning defaults from config.json",
      );
    } catch (err) {
      log.warn({ err }, "Failed to write normalized config.json");
    }
  },

  down(_workspaceDir: string): void {
    // Forward-only: a stripped leaf is indistinguishable from one the user never
    // set, and re-adding the lean value could re-pin the assistant to the lean
    // profile.
  },
};
