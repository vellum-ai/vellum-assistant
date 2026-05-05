/**
 * Workspace migration 061: Move backup.key from protected/ to workspace.
 *
 * The backup encryption key previously lived at ~/.vellum/protected/backup.key.
 * This migration copies it to ~/.vellum/workspace/.backup.key so the daemon
 * no longer depends on the protected directory (owned by the gateway).
 *
 * The old file is removed after a successful copy. If the new file already
 * exists (e.g. from VELLUM_BACKUP_KEY_PATH override or re-run), the old
 * file is simply cleaned up.
 */

import { copyFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";
import { getVellumRoot } from "./utils.js";

export const moveBackupKeyToWorkspaceMigration: WorkspaceMigration = {
  id: "061-move-backup-key-to-workspace",
  description: "Move backup.key from protected/ to workspace",

  run(workspaceDir: string): void {
    const oldPath = join(getVellumRoot(), "protected", "backup.key");
    const newPath = join(workspaceDir, ".backup.key");
    if (!existsSync(oldPath)) return;
    if (existsSync(newPath)) {
      try {
        unlinkSync(oldPath);
      } catch {}
      return;
    }
    try {
      copyFileSync(oldPath, newPath);
      unlinkSync(oldPath);
    } catch {}
  },

  down(workspaceDir: string): void {
    const oldPath = join(getVellumRoot(), "protected", "backup.key");
    const newPath = join(workspaceDir, ".backup.key");
    if (!existsSync(newPath)) return;
    if (existsSync(oldPath)) {
      try {
        unlinkSync(newPath);
      } catch {}
      return;
    }
    try {
      copyFileSync(newPath, oldPath);
      unlinkSync(newPath);
    } catch {}
  },
};
