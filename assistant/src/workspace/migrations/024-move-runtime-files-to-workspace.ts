/**
 * Workspace migration 024: Move remaining root-level runtime files/dirs to workspace.
 *
 * Previously, several runtime files and directories lived directly under
 * ~/.vellum/ (the root dir). This migration moves them into the workspace
 * directory so that the root dir can eventually be cleaned up.
 *
 * Files moved:
 *   - daemon-stderr.log      -> workspace/logs/daemon-stderr.log
 *   - daemon-startup.lock    -> workspace/daemon-startup.lock
 *   - embed-worker.pid       -> workspace/embed-worker.pid
 *   - feature-flag-token     -> workspace/feature-flag-token
 *
 * NOT moved (stays at root because it contains secrets):
 *   - .env
 *
 * Directories moved:
 *   - external/              -> workspace/external/
 *   - bin/                   -> workspace/bin/
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

/** Inlined from platform.ts to satisfy migration self-containment rule (AGENTS.md). */
function getRootDir(): string {
  const base = process.env.BASE_DATA_DIR?.trim() || homedir();
  return join(base, ".vellum");
}

/** Individual files to move from root → workspace (with optional subdirectory). */
const FILE_MOVES: Array<{ name: string; subdir?: string }> = [
  { name: "daemon-stderr.log", subdir: "logs" },
  { name: "daemon-startup.lock" },
  // .env stays at root — it contains secrets (API keys) and the entire
  // workspace directory is included in diagnostic log exports.
  { name: "embed-worker.pid" },
  { name: "feature-flag-token" },
];

/** Directories to move from root → workspace. */
const DIR_MOVES = ["external", "bin"] as const;

/**
 * Move a single file from oldPath to newPath. If the destination already
 * exists, remove the old file instead of overwriting.
 */
function moveFile(oldPath: string, newPath: string): void {
  if (!existsSync(oldPath)) return;
  if (existsSync(newPath)) {
    try {
      unlinkSync(oldPath);
    } catch {
      // Best-effort cleanup
    }
    return;
  }
  try {
    renameSync(oldPath, newPath);
  } catch {
    // Best-effort: cross-device rename or permission issue
  }
}

/**
 * Move all entries from one directory to another. If the destination already
 * has an entry with the same name, the source entry is removed.
 */
function moveDirContents(oldDir: string, newDir: string): void {
  if (!existsSync(oldDir)) return;
  mkdirSync(newDir, { recursive: true });

  try {
    const entries = readdirSync(oldDir);
    for (const entry of entries) {
      moveFile(join(oldDir, entry), join(newDir, entry));
    }
  } catch {
    // Best-effort: old directory may not be readable
  }
}

export const moveRuntimeFilesToWorkspaceMigration: WorkspaceMigration = {
  id: "024-move-runtime-files-to-workspace",
  description:
    "Move daemon-stderr.log, daemon-startup.lock, embed-worker.pid, feature-flag-token, external/, and bin/ from root to workspace",

  run(workspaceDir: string): void {
    const rootDir = getRootDir();

    // Move individual files
    for (const { name, subdir } of FILE_MOVES) {
      const oldPath = join(rootDir, name);
      const destDir = subdir ? join(workspaceDir, subdir) : workspaceDir;
      mkdirSync(destDir, { recursive: true });
      moveFile(oldPath, join(destDir, name));
    }

    // Move directories
    for (const dir of DIR_MOVES) {
      moveDirContents(join(rootDir, dir), join(workspaceDir, dir));
    }
  },

  down(workspaceDir: string): void {
    const rootDir = getRootDir();

    // Move individual files back
    for (const { name, subdir } of FILE_MOVES) {
      const srcDir = subdir ? join(workspaceDir, subdir) : workspaceDir;
      moveFile(join(srcDir, name), join(rootDir, name));
    }

    // Move directories back
    for (const dir of DIR_MOVES) {
      moveDirContents(join(workspaceDir, dir), join(rootDir, dir));
    }
  },
};
