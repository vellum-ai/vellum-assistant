import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getLogger } from "../../util/logger.js";
import type { WorkspaceMigration } from "./types.js";

const log = getLogger("workspace-migration-117");

/**
 * The lean (TTFT-oriented) memory-v3 tuning values that shipped as the schema
 * defaults for a brief window. Because the first-launch seed writes the
 * fully-defaulted config.json to disk, assistants first launched in that window
 * persisted these values as if they were explicit user choices — so once such
 * an assistant's corpus grew past the v3 full-profile threshold it would copy
 * the stale lean values back and never upgrade to the restored full retrieval
 * profile. Stripping the matching leaves lets the full schema defaults re-apply
 * at load.
 *
 * Values that differ (a deliberate user override, or the pre-lean full default
 * persisted before the window) do not match and are preserved. Fields the lean
 * profile never changed (hotSet.halfLifeDays, edge.hubDegree, the learnedEdges
 * math fields, spotlight, prune) are not touched.
 *
 * Inlined per the migrations self-containment rule.
 */
const LEAN_V3_TOP_LEVEL: Record<string, number | boolean> = {
  needleK: 12,
  denseK: 0,
  replyQueryK: 0,
  selectorEnabled: false,
};
const LEAN_V3_NESTED: Record<string, Record<string, number>> = {
  hotSet: { k: 8 },
  freshSet: { k: 8 },
  edge: { seedCount: 6, perSeed: 1, cap: 6 },
  learnedEdges: { cap: 0 },
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

export const normalizeStaleLeanMemoryV3DefaultsMigration: WorkspaceMigration = {
  id: "117-normalize-stale-lean-memory-v3-defaults",
  description:
    "Strip persisted memory.v3 tuning values matching the retired lean defaults so the restored full schema defaults re-apply for assistants seeded during the lean-default window",

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

    // Top-level leaves: drop only when the persisted value equals the lean
    // default (a changed value, or the pre-lean full default, differs and is
    // preserved).
    for (const [key, leanValue] of Object.entries(LEAN_V3_TOP_LEVEL)) {
      if (key in v3 && v3[key] === leanValue) {
        delete v3[key];
        changed = true;
      }
    }

    // Nested sub-object leaves: drop the matching leaf and leave the parent in
    // place — it may still carry untouched siblings (e.g. hotSet.halfLifeDays).
    // An emptied sub-object (e.g. freshSet: {}) re-parses to the full schema
    // default, so it is harmless to leave behind.
    for (const [parentKey, leaves] of Object.entries(LEAN_V3_NESTED)) {
      const parent = v3[parentKey];
      if (!isPlainObject(parent)) continue;
      for (const [leafKey, leanValue] of Object.entries(leaves)) {
        if (leafKey in parent && parent[leafKey] === leanValue) {
          delete parent[leafKey];
          changed = true;
        }
      }
    }

    if (!changed) return;

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
