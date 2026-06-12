import { rmSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

const MIGRATION_ID = "098-remove-stale-updates-bulletin-file";

/**
 * Delete `<workspace>/UPDATES.md`.
 *
 * Release notes used to be appended to the file by workspace migrations and
 * processed by a background conversation dispatched at daemon startup. That
 * feature has been removed — nothing consumes the file's contents anymore,
 * and it was system-written bulletin material, so it is deleted outright.
 *
 * Idempotent: `rmSync` with `force` is a no-op when the file is absent.
 */
export const removeStaleUpdatesBulletinFileMigration: WorkspaceMigration = {
  id: MIGRATION_ID,
  description:
    "Delete leftover UPDATES.md release-note bulletins (processing job removed)",

  run(workspaceDir: string): void {
    rmSync(join(workspaceDir, "UPDATES.md"), { force: true });
  },

  down(_workspaceDir: string): void {
    // Forward-only: the removed content was pending release-note bulletins
    // for a feature that no longer exists.
  },
};
