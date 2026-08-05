import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import type { MigrationRunContext, WorkspaceMigration } from "./types.js";

/**
 * Repair assistants stuck on `memory.v3.live = false` by the first-launch
 * seed race fixed in #39847: the seed used to persist the schema default
 * (`false`) ~200ms before migration 105 ran, and 105's `"live" in v3Config`
 * guard then bailed: a brand-new workspace that should have come up on
 * memory-v3 ran v2 forever, with no signal to the user. 105 is checkpointed
 * as applied and never re-runs, so nothing self-heals the stamped value.
 *
 * The same stamp lands on an EXISTING v3 assistant whose config.json is
 * quarantined (corrupt JSON → renamed to `config.json.corrupt-<ts>.json`)
 * and reseeded: the reseed silently demotes it to v2.
 *
 * Flips `live` to `true` only when the `false` on disk is attributable to
 * the seed, never over a deliberate opt-out:
 *
 * - Quarantine carry-forward: the newest quarantined config next to
 *   config.json says `live: true`, meaning the assistant WAS on v3 before the
 *   reseed, so the current `false` is the seed's stamp.
 * - Seed-race repair: the workspace was created during the migration-105 era
 *   (105 completed in the first-boot sweep, i.e. at effectively the same
 *   time as the workspace's earliest checkpoint), the archived hatch-time
 *   overlay (`default-config.json`) records no `live: false` opt-out, AND
 *   memory-v3 never ran (no `memory_v3_selections` rows in either database,
 *   including the mid-drain `__relocating` staging name). A deliberate
 *   opt-out on such a workspace requires flipping v3 off before its first
 *   selection is logged; a workspace that DID run v3 and now reads `false`
 *   is treated as an opt-out and left alone.
 *
 * Everything else is skipped: `live` absent means a pre-105 assistant on the
 * deliberate manual-upgrade path (tier movement stays user-initiated), while
 * new workspaces are migration 105's job, where a post-#39847 hatch-time
 * `memory.v3.live=false` override merges after migrations and must win.
 */

const MIGRATION_105_ID = "105-enable-memory-v3-live-for-new-workspaces";

/** How close migration 105's checkpoint must be to the workspace's earliest
 *  checkpoint to count as "completed in the first-boot sweep". The sweep
 *  itself takes seconds; the margin absorbs a crash-restart mid-sweep. */
const FIRST_BOOT_SWEEP_TOLERANCE_MS = 60 * 60 * 1000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `memory.v3.live` from a parsed config-shaped value, or undefined. */
function readMemoryV3Live(config: unknown): unknown {
  if (!isPlainObject(config)) {
    return undefined;
  }
  const memory = config.memory;
  if (!isPlainObject(memory)) {
    return undefined;
  }
  const v3 = memory.v3;
  if (!isPlainObject(v3)) {
    return undefined;
  }
  return v3.live;
}

/**
 * Whether the newest quarantined config (`config.json.corrupt-*.json`)
 * carried `memory.v3.live: true`. Quarantine filenames embed a
 * filesystem-safe ISO timestamp, so a lexicographic sort is chronological.
 * A quarantined file is usually truncated JSON; every config writer
 * serializes via `JSON.stringify(config, null, 2)` and `memory.v3.live` is
 * the only config key named `"live"`, so when parsing fails a literal
 * `"live": true` match is unambiguous.
 */
function quarantinedConfigSaidLiveTrue(workspaceDir: string): boolean {
  try {
    const entries = readdirSync(workspaceDir)
      .filter(
        (name) =>
          name.startsWith("config.json.corrupt-") && name.endsWith(".json"),
      )
      .sort();
    const newest = entries[entries.length - 1];
    if (!newest) {
      return false;
    }
    const raw = readFileSync(join(workspaceDir, newest), "utf-8");
    try {
      return readMemoryV3Live(JSON.parse(raw)) === true;
    } catch {
      return /"live"\s*:\s*true/.test(raw);
    }
  } catch {
    return false;
  }
}

/**
 * Whether migration 105 completed in this workspace's first-boot sweep,
 * i.e. the workspace was CREATED in the era where 105 should have flipped it
 * to v3. On an older workspace 105 arrives in an upgrade sweep long after
 * the earliest checkpoint, so the gap exceeds the tolerance.
 */
function wasCreatedInMigration105Era(workspaceDir: string): boolean {
  try {
    const raw = readFileSync(
      join(workspaceDir, "data", ".workspace-migrations.json"),
      "utf-8",
    );
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainObject(parsed) || !isPlainObject(parsed.applied)) {
      return false;
    }
    let earliest = Number.POSITIVE_INFINITY;
    let applied105 = Number.NaN;
    for (const [id, entry] of Object.entries(parsed.applied)) {
      if (!isPlainObject(entry) || typeof entry.appliedAt !== "string") {
        continue;
      }
      const at = Date.parse(entry.appliedAt);
      if (!Number.isFinite(at)) {
        continue;
      }
      earliest = Math.min(earliest, at);
      if (id === MIGRATION_105_ID) {
        applied105 = at;
      }
    }
    return (
      Number.isFinite(applied105) &&
      Number.isFinite(earliest) &&
      applied105 - earliest < FIRST_BOOT_SWEEP_TOLERANCE_MS
    );
  } catch {
    return false;
  }
}

/**
 * Whether a hatch-time default workspace overlay recorded a deliberate
 * memory-v3 opt-out. `mergeDefaultWorkspaceConfig()` archives the consumed
 * overlay to `default-config.json` next to config.json; an overlay carrying
 * `memory.v3.live: false` merged AFTER workspace migrations, so the
 * persisted `false` is the user's hatch-time choice, not the seed's stamp,
 * even though the workspace otherwise fingerprints as a seed-race victim
 * (born in the 105 era, no v3 selection rows).
 */
function hatchOverlayOptedOut(workspaceDir: string): boolean {
  try {
    const raw = readFileSync(
      join(workspaceDir, "default-config.json"),
      "utf-8",
    );
    return readMemoryV3Live(JSON.parse(raw)) === false;
  } catch {
    return false;
  }
}

/**
 * Whether memory-v3 ever ran a selection on this workspace. The
 * `memory_v3_selections` table lives in `assistant-memory.db` after DB
 * migration 338 and in `assistant.db` before it; both are checked, along
 * with the `__relocating` staging name the relocation renames the source to
 * mid-drain (a crash there leaves the rows only under the staging name). A
 * database file that exists but cannot be read counts as "may have run v3"
 * so an unreadable database never causes an opt-out to be overridden.
 */
function memoryV3EverRan(workspaceDir: string): boolean {
  const tables = ["memory_v3_selections", "memory_v3_selections__relocating"];
  for (const file of ["assistant-memory.db", "assistant.db"]) {
    const dbPath = join(workspaceDir, "data", "db", file);
    if (!existsSync(dbPath)) {
      continue;
    }
    let db: Database | null = null;
    try {
      db = new Database(dbPath, { readonly: true });
      for (const table of tables) {
        const exists = db
          .query(
            `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
          )
          .get(table);
        if (!exists) {
          continue;
        }
        const row = db.query(`SELECT 1 FROM "${table}" LIMIT 1`).get();
        if (row) {
          return true;
        }
      }
    } catch {
      return true;
    } finally {
      db?.close();
    }
  }
  return false;
}

export const repairSeedPinnedMemoryV3LiveMigration: WorkspaceMigration = {
  id: "140-repair-seed-pinned-memory-v3-live",
  description:
    "Re-flip memory.v3.live=true for assistants the pre-#39847 first-launch seed pinned to false (seed-race and quarantine-reseed victims), leaving deliberate opt-outs alone",

  run(workspaceDir: string, ctx?: MigrationRunContext): void {
    // New workspaces are migration 105's job, and a post-#39847 hatch-time
    // memory.v3.live=false override (merged after migrations) must win.
    if (ctx?.isNewWorkspace) {
      return;
    }

    const configPath = join(workspaceDir, "config.json");
    if (!existsSync(configPath)) {
      return;
    }
    let config: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(readFileSync(configPath, "utf-8"));
      if (!isPlainObject(parsed)) {
        return;
      }
      config = parsed;
    } catch {
      return;
    }

    // Only a persisted explicit `false` is repairable: `true` is healthy and
    // an absent leaf is a pre-105 assistant on the manual-upgrade path.
    if (readMemoryV3Live(config) !== false) {
      return;
    }

    if (!quarantinedConfigSaidLiveTrue(workspaceDir)) {
      if (!wasCreatedInMigration105Era(workspaceDir)) {
        return;
      }
      if (hatchOverlayOptedOut(workspaceDir)) {
        return;
      }
      if (memoryV3EverRan(workspaceDir)) {
        return;
      }
    }

    // Narrow-write: only the one leaf changes; the shape was validated above.
    const memory = config.memory as Record<string, unknown>;
    const v3 = memory.v3 as Record<string, unknown>;
    v3.live = true;
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  },

  down(_workspaceDir: string): void {
    // Forward-only: cannot distinguish this repair from a user's explicit
    // choice after the fact (mirrors migration 105).
  },
};
