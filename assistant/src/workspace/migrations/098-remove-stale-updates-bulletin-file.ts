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
 * Marker embedded by the historical release-note migrations in every block
 * they appended. Its presence identifies a file as system-written bulletin
 * content; a file without any release-note marker may have been repurposed
 * by the user and is left untouched.
 */
const RELEASE_NOTE_MARKER_PREFIX = "<!-- release-note-id:";

/**
 * Remove a leftover `UPDATES.md` from workspaces.
 *
 * Release notes used to be appended to `<workspace>/UPDATES.md` by workspace
 * migrations and processed by a background conversation dispatched at daemon
 * startup. That processing job has been removed, so any accumulated release
 * notes in the file will never be consumed — they are stale noise that the
 * agent could stumble over. Delete the file only when it is identifiable as
 * bulletin content (contains a release-note marker) and contains no
 * config-quarantine note (those remain meaningful as passive workspace
 * context).
 *
 * Idempotent: deleting an already-deleted file is a no-op, and skipped files
 * are skipped again on re-run.
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
    if (!content.includes(RELEASE_NOTE_MARKER_PREFIX)) {
      return;
    }

    rmSync(updatesPath, { force: true });
  },

  down(_workspaceDir: string): void {
    // Forward-only: the removed content was pending release-note bulletins
    // for a feature that no longer exists.
  },
};
