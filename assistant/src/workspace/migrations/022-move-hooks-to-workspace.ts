/**
 * Workspace migration 022: Move hooks directory from root to workspace.
 *
 * Previously, `~/.vellum/hooks/` lived directly under the Vellum root. This
 * migration moves existing hook directories and files into
 * `~/.vellum/workspace/hooks/` so that getWorkspaceHooksDir() resolves
 * correctly under the workspace.
 *
 * Hooks are persistent user-installed scripts (manifests, config, executables),
 * so the migration recursively moves all entries from the old directory to the
 * new one. The old root-level directory is left in place (but empty) to avoid
 * breaking any external references during the transition.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";
import { getVellumRoot } from "./utils.js";

export const moveHooksToWorkspaceMigration: WorkspaceMigration = {
  id: "022-move-hooks-to-workspace",
  description: "Move hooks directory from root to workspace",

  run(workspaceDir: string): void {
    const oldHooksDir = join(getVellumRoot(), "hooks");
    const newHooksDir = join(workspaceDir, "hooks");

    mkdirSync(newHooksDir, { recursive: true });

    if (!existsSync(oldHooksDir)) return;

    // Move hook entries from root to workspace. The old (user) entries take
    // precedence over anything already at the destination. We remove the
    // destination first so renameSync succeeds atomically.
    try {
      const entries = readdirSync(oldHooksDir);
      for (const entry of entries) {
        const oldPath = join(oldHooksDir, entry);
        const newPath = join(newHooksDir, entry);
        try {
          if (existsSync(newPath)) {
            rmSync(newPath, { recursive: true, force: true });
          }
          renameSync(oldPath, newPath);
        } catch {
          // Best-effort: entry may have been modified concurrently
        }
      }
    } catch {
      // Best-effort: old directory may not be readable
    }
  },

  down(workspaceDir: string): void {
    const oldHooksDir = join(getVellumRoot(), "hooks");
    const newHooksDir = join(workspaceDir, "hooks");

    mkdirSync(oldHooksDir, { recursive: true });

    if (!existsSync(newHooksDir)) return;

    // Move hook entries back to the root-level directory
    try {
      const entries = readdirSync(newHooksDir);
      for (const entry of entries) {
        const newPath = join(newHooksDir, entry);
        const oldPath = join(oldHooksDir, entry);
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
