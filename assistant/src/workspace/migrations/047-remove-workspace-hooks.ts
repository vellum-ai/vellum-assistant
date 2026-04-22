/**
 * Workspace migration 046: Remove legacy `workspace/hooks/` directory.
 *
 * Migration 022 moved `~/.vellum/hooks/` into `~/.vellum/workspace/hooks/`.
 * With the hook system entirely removed, that directory is dead state — it is
 * no longer read or written by the assistant. This migration deletes the
 * directory (and everything under it) so stale hook manifests, config, and
 * executables do not linger in user workspaces.
 *
 * Idempotent: safe to re-run after interruption. A no-op when the directory
 * is already absent.
 */

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { getLogger } from "../../util/logger.js";
import type { WorkspaceMigration } from "./types.js";

const log = getLogger("workspace-migration-047-remove-workspace-hooks");

/**
 * Count files under `dir` recursively. Best-effort — returns the count we
 * could successfully stat, and silently skips entries that fail (e.g. a
 * symlink whose target is missing, a file removed concurrently). This is
 * only used for log output, so a slightly stale count is acceptable.
 */
function countFilesRecursive(dir: string): number {
  let count = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const entryPath = join(dir, entry);
    try {
      const s = statSync(entryPath);
      if (s.isDirectory()) {
        count += countFilesRecursive(entryPath);
      } else {
        count += 1;
      }
    } catch {
      // best-effort
    }
  }
  return count;
}

export const removeWorkspaceHooksMigration: WorkspaceMigration = {
  id: "047-remove-workspace-hooks",
  description:
    "Remove legacy workspace/hooks/ directory now that the hook system is gone",

  run(workspaceDir: string): void {
    const hooksDir = join(workspaceDir, "hooks");
    if (!existsSync(hooksDir)) return;

    const fileCount = countFilesRecursive(hooksDir);
    try {
      rmSync(hooksDir, { recursive: true, force: true });
      log.info(
        { path: hooksDir, fileCount },
        "Removed legacy workspace hooks directory",
      );
    } catch (err) {
      log.warn(
        { err, path: hooksDir },
        "Failed to remove legacy workspace hooks directory; leaving in place",
      );
    }
  },

  down(_workspaceDir: string): void {
    // Forward-only: the hook system is gone and the directory contained no
    // data the assistant still consumes. Restoring an empty directory would
    // just reintroduce dead state.
  },
};
