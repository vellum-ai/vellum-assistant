import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

const MIGRATION_ID = "098-remove-stale-updates-bulletin-file";

/**
 * Marker embedded by `appendQuarantineBulletin` in `config/loader.ts` when a
 * corrupt config file is quarantined. Those notes are still written and still
 * useful (the agent can discover them when the user asks why their settings
 * changed), so a file containing one is left untouched.
 */
const CONFIG_QUARANTINE_MARKER_PREFIX = "<!-- config-quarantine:";

/**
 * Remove a leftover `UPDATES.md` from workspaces.
 *
 * Release notes used to be appended to `<workspace>/UPDATES.md` by workspace
 * migrations and processed by a background conversation dispatched at daemon
 * startup. That processing job has been removed, so any accumulated release
 * notes in the file will never be consumed — they are stale noise that the
 * agent could stumble over. Delete the file unless it contains a
 * config-quarantine note (those remain meaningful as passive workspace
 * context).
 *
 * Idempotent: deleting an already-deleted file is a no-op, and a file that
 * only ever contains quarantine notes is permanently skipped.
 */
export const removeStaleUpdatesBulletinFileMigration: WorkspaceMigration = {
  id: MIGRATION_ID,
  description:
    "Delete leftover UPDATES.md release-note bulletins (processing job removed)",

  run(workspaceDir: string): void {
    const updatesPath = join(workspaceDir, "UPDATES.md");
    if (!existsSync(updatesPath)) {
      return;
    }

    const content = readFileSync(updatesPath, "utf-8");
    if (content.includes(CONFIG_QUARANTINE_MARKER_PREFIX)) {
      return;
    }

    rmSync(updatesPath, { force: true });
  },

  down(_workspaceDir: string): void {
    // Forward-only: the removed content was pending release-note bulletins
    // for a feature that no longer exists.
  },
};
