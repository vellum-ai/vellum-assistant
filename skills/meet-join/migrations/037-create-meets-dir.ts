import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "../../../assistant/src/workspace/migrations/types.js";

/**
 * `.keep` sentinel content. Keeps the directory tracked/visible even when
 * empty and documents the purpose for anyone inspecting the workspace.
 */
const KEEP_CONTENT =
  "# Per-meeting artifacts live under <workspace>/meets/<meeting-id>/.\n";

export const createMeetsDirMigration: WorkspaceMigration = {
  id: "037-create-meets-dir",
  description:
    "Create meets/ storage directory with a .keep sentinel file for per-meeting artifacts",

  down(workspaceDir: string): void {
    // Best-effort: only remove the seeded .keep file and the meets/ directory
    // itself if it is otherwise empty. Never delete user/meeting content.
    const meetsDir = join(workspaceDir, "meets");
    if (!existsSync(meetsDir)) return;

    const keepPath = join(meetsDir, ".keep");
    if (existsSync(keepPath)) {
      try {
        unlinkSync(keepPath);
      } catch {
        // Best-effort — leave the file alone if we can't remove it.
      }
    }

    try {
      const entries = readdirSync(meetsDir);
      if (entries.length === 0) {
        rmdirSync(meetsDir);
      }
    } catch {
      // Best-effort — directory missing or unreadable; skip.
    }
  },

  run(workspaceDir: string): void {
    const meetsDir = join(workspaceDir, "meets");
    mkdirSync(meetsDir, { recursive: true });

    // Seed the .keep sentinel only if it doesn't already exist so re-runs
    // don't clobber user edits (idempotent).
    const keepPath = join(meetsDir, ".keep");
    if (!existsSync(keepPath)) {
      writeFileSync(keepPath, KEEP_CONTENT, "utf-8");
    }
  },
};
