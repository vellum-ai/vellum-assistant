/**
 * Workspace migration 027: Remove orphaned optimized-images cache directory.
 *
 * The optimized image cache was moved from `workspace/cache/optimized-images/`
 * to `os.tmpdir()/vellum-optimized-images/`. This migration cleans up the old
 * directory and removes the parent `cache/` directory if it is now empty.
 *
 * Idempotent: safe to re-run after interruption at any point.
 */

import { existsSync, readdirSync, rmSync, rmdirSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

export const removeOrphanedOptimizedImagesCacheMigration: WorkspaceMigration = {
  id: "027-remove-orphaned-optimized-images-cache",
  description:
    "Remove orphaned cache/optimized-images/ directory after cache moved to tmpdir",

  run(workspaceDir: string): void {
    const cacheDir = join(workspaceDir, "cache");
    const optimizedImagesDir = join(cacheDir, "optimized-images");

    if (existsSync(optimizedImagesDir)) {
      rmSync(optimizedImagesDir, { recursive: true, force: true });
    }

    // Remove the parent cache/ directory if it is now empty
    if (existsSync(cacheDir)) {
      const remaining = readdirSync(cacheDir);
      if (remaining.length === 0) {
        rmdirSync(cacheDir);
      }
    }
  },

  down(_workspaceDir: string): void {
    // The old cache directory contained ephemeral cached data that does not
    // need to be restored. The cache will be rebuilt in tmpdir on next use.
  },
};
