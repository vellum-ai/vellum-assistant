/**
 * Workspace migration 021: Move signals directory from root to workspace.
 *
 * Previously, `~/.vellum/signals/` lived directly under the Vellum root. This
 * migration moves any existing signal files into `~/.vellum/workspace/signals/`
 * so that getSignalsDir() resolves correctly under the workspace.
 *
 * Signal files are ephemeral IPC artifacts (written, read once, then stale),
 * so the migration simply ensures the workspace signals directory exists and
 * copies over any files that may still be pending. The old root-level
 * directory is left in place (but empty) to avoid breaking concurrent
 * watchers during the transition.
 */

import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";
import { getVellumRoot } from "./utils.js";

export const moveSignalsToWorkspaceMigration: WorkspaceMigration = {
  id: "021-move-signals-to-workspace",
  description: "Move signals directory from root to workspace",

  run(workspaceDir: string): void {
    const oldSignalsDir = join(getVellumRoot(), "signals");
    const newSignalsDir = join(workspaceDir, "signals");

    mkdirSync(newSignalsDir, { recursive: true });

    if (!existsSync(oldSignalsDir)) return;

    // Move any pending signal files to the new location
    try {
      const entries = readdirSync(oldSignalsDir);
      for (const entry of entries) {
        const oldPath = join(oldSignalsDir, entry);
        const newPath = join(newSignalsDir, entry);
        if (!existsSync(newPath)) {
          try {
            renameSync(oldPath, newPath);
          } catch {
            // Best-effort: file may have been consumed between readdir and rename
          }
        }
      }
    } catch {
      // Best-effort: old directory may not be readable
    }
  },

  down(workspaceDir: string): void {
    const oldSignalsDir = join(getVellumRoot(), "signals");
    const newSignalsDir = join(workspaceDir, "signals");

    mkdirSync(oldSignalsDir, { recursive: true });

    if (!existsSync(newSignalsDir)) return;

    // Move signal files back to the root-level directory
    try {
      const entries = readdirSync(newSignalsDir);
      for (const entry of entries) {
        const newPath = join(newSignalsDir, entry);
        const oldPath = join(oldSignalsDir, entry);
        if (!existsSync(oldPath)) {
          try {
            renameSync(newPath, oldPath);
          } catch {
            // Best-effort
          }
        }
      }
    } catch {
      // Best-effort
    }
  },
};
