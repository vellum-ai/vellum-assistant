import * as fs from "node:fs";
import { dirname, join } from "node:path";

import { getLogger } from "../../util/logger.js";
import type { WorkspaceMigration } from "./types.js";

const log = getLogger("workspace-migration-089-move-memory-tree-out-of-v3");

function isNotFoundError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    err.code === "ENOENT"
  );
}

/**
 * Move `<workspace>/memory/<fromRel>` to `<workspace>/memory/<toRel>` when the
 * source exists and the destination does not. Idempotent: a missing source is a
 * no-op (already migrated, or never created), and an existing destination is
 * left untouched (we never clobber). Both directions go through here so `run`
 * and `down` share the same safety checks.
 */
function moveMemorySubdir(
  workspaceDir: string,
  fromRel: string,
  toRel: string,
): void {
  const memoryDir = join(workspaceDir, "memory");
  const src = join(memoryDir, fromRel);
  const dest = join(memoryDir, toRel);
  try {
    if (!fs.existsSync(src)) return;
    if (fs.existsSync(dest)) {
      log.warn(
        { src, dest },
        "Both source and destination tree dirs exist; leaving in place for manual resolution",
      );
      return;
    }
    fs.mkdirSync(dirname(dest), { recursive: true });
    fs.renameSync(src, dest);
    log.info({ src, dest }, "Moved memory tree directory");
  } catch (err) {
    if (isNotFoundError(err)) return;
    log.warn({ err, src, dest }, "Failed to move memory tree directory");
    throw err;
  }
}

/** Remove `<workspace>/memory/v3` if it is now an empty wrapper (the tree was
 *  its only child). Best-effort — a non-empty or missing dir is left alone. */
function removeEmptyV3Wrapper(workspaceDir: string): void {
  const v3Dir = join(workspaceDir, "memory", "v3");
  try {
    if (fs.existsSync(v3Dir) && fs.readdirSync(v3Dir).length === 0) {
      fs.rmdirSync(v3Dir);
    }
  } catch {
    // Non-fatal: leaving an empty memory/v3 wrapper is harmless.
  }
}

/**
 * Relocate the v3 memory tree from `memory/v3/tree` to `memory/tree`.
 *
 * The tree is a DAG overlay over the flat `memory/concepts/` pages and is now a
 * top-level sibling of `concepts/` (matching the storage design), no longer
 * nested under a `v3/` wrapper. `getTreeDir` reads `memory/tree` after this
 * change, so any pre-existing hand-authored tree must move with it.
 */
export const moveMemoryTreeOutOfV3Migration: WorkspaceMigration = {
  id: "089-move-memory-tree-out-of-v3",
  description: "Relocate the v3 memory tree from memory/v3/tree to memory/tree",
  retryFailedCheckpoint: true,

  run(workspaceDir: string): void {
    moveMemorySubdir(workspaceDir, join("v3", "tree"), "tree");
    removeEmptyV3Wrapper(workspaceDir);
  },

  down(workspaceDir: string): void {
    moveMemorySubdir(workspaceDir, "tree", join("v3", "tree"));
  },
};
