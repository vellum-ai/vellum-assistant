import { rmSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

/**
 * Delete the legacy `memory/edges.json` file from any workspace that ran
 * migration 060 before the v2 edge model moved to per-page frontmatter.
 *
 * Memory v2 now stores each page's outgoing directed edges directly in its
 * frontmatter `edges:` list — there is no separate index file. Existing
 * v1-shape edges.json files (undirected canonical 2-tuples) would fail
 * validation under the new design and are no longer read by anything, so
 * the safe move is simply to delete the file.
 */
export const dropMemoryV2EdgesJsonMigration: WorkspaceMigration = {
  id: "062-drop-memory-v2-edges-json",
  description: "Delete legacy memory/edges.json (edges now live per-page)",

  run(workspaceDir: string): void {
    rmSync(join(workspaceDir, "memory", "edges.json"), { force: true });
  },

  down(): void {
    // No reversal — we don't reconstruct a legacy index file.
  },
};
