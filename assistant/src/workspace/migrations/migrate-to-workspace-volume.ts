/**
 * Workspace migration: Migrate workspace data from /data to /workspace volume.
 *
 * In the old Docker volume layout, workspace data lived at
 * `$BASE_DATA_DIR/.vellum/workspace`. In the new layout, WORKSPACE_DIR points
 * to a dedicated volume (e.g. `/workspace`). On first boot with the new layout,
 * this migration copies existing workspace data from the old location to the
 * new volume so nothing is lost.
 *
 * Idempotent:
 * - Skips if WORKSPACE_DIR is not set (non-Docker or old layout).
 * - Skips if the workspace volume already has data (config.json exists).
 * - Skips if the sentinel file exists (already migrated).
 * - Skips if the old workspace directory doesn't exist or is empty.
 */

import {
  cpSync,
  existsSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  getBaseDataDir,
  getWorkspaceDirOverride,
} from "../../config/env-registry.js";
import type { WorkspaceMigration } from "./types.js";

const SENTINEL_FILENAME = ".workspace-volume-migrated";

export const migrateToWorkspaceVolumeMigration: WorkspaceMigration = {
  id: "014-migrate-to-workspace-volume",
  description:
    "Copy workspace data from old /data/.vellum/workspace to new WORKSPACE_DIR volume on first boot",

  down(workspaceDir: string): void {
    // This migration copies data between volumes. Actually reversing the copy
    // (deleting data from the workspace volume) is dangerous and could cause
    // data loss. Instead, we just remove the sentinel file so the migration
    // will re-run and re-evaluate on next startup.
    const sentinelPath = join(workspaceDir, SENTINEL_FILENAME);
    if (existsSync(sentinelPath)) {
      try {
        unlinkSync(sentinelPath);
      } catch {
        // Best-effort — the migration runner's checkpoint removal will
        // also ensure the migration re-runs.
      }
    }
  },

  run(workspaceDir: string): void {
    const workspaceDirOverride = getWorkspaceDirOverride();

    // Only relevant when WORKSPACE_DIR is explicitly set (Docker with separate volume)
    if (!workspaceDirOverride) return;

    const sentinelPath = join(workspaceDir, SENTINEL_FILENAME);

    // Already migrated — skip
    if (existsSync(sentinelPath)) return;

    // If the workspace volume already has data (config.json), assume it's
    // already populated — either by a previous migration or manual setup.
    if (existsSync(join(workspaceDir, "config.json"))) {
      // Write sentinel so we don't re-check on every boot
      writeSentinel(sentinelPath);
      return;
    }

    // Resolve the old workspace location: $BASE_DATA_DIR/.vellum/workspace
    const baseDataDir = getBaseDataDir();
    if (!baseDataDir) {
      // No BASE_DATA_DIR means there's no old location to migrate from
      writeSentinel(sentinelPath);
      return;
    }

    const oldWorkspaceDir = join(baseDataDir, ".vellum", "workspace");

    // If the old workspace doesn't exist or is empty, nothing to migrate
    if (!existsSync(oldWorkspaceDir)) {
      writeSentinel(sentinelPath);
      return;
    }

    let entries: string[];
    try {
      entries = readdirSync(oldWorkspaceDir);
    } catch {
      // Can't read old workspace — write sentinel and move on
      writeSentinel(sentinelPath);
      return;
    }

    if (entries.length === 0) {
      writeSentinel(sentinelPath);
      return;
    }

    // Copy everything from old workspace to new workspace volume.
    // Use cpSync with recursive to handle nested directories.
    // Copy each entry individually rather than the whole directory to avoid
    // overwriting the target directory itself (which may already have
    // sub-directories created by ensureDataDir).
    for (const entry of entries) {
      const src = join(oldWorkspaceDir, entry);
      const dst = join(workspaceDir, entry);

      // Skip if destination already exists (partial previous run)
      if (existsSync(dst)) continue;

      try {
        cpSync(src, dst, { recursive: true });
      } catch {
        // Best-effort per entry — continue with remaining items
      }
    }

    // Mark migration complete
    writeSentinel(sentinelPath);
  },
};

function writeSentinel(sentinelPath: string): void {
  try {
    writeFileSync(sentinelPath, new Date().toISOString() + "\n", "utf-8");
  } catch {
    // Best-effort — if we can't write the sentinel, the migration runner's
    // checkpoint will still prevent re-running the migration function.
  }
}
