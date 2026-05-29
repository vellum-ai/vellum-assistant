/**
 * Workspace migration 028: Recover conversations from disk-view directories.
 *
 * If the SQLite database was recreated empty but the disk-view directories
 * under `workspace/conversations/` still exist, this migration reads each
 * conversation's `meta.json` and `messages.jsonl` and re-inserts the rows
 * into the database.
 *
 * Idempotent: conversations already present in the DB are skipped.
 * Malformed files are skipped with warnings — they do not crash the migration.
 *
 * Core logic lives in `../recovery/conversations-from-disk.ts` and is also
 * invoked by the `assistant db repair` command.
 */

import { getDb } from "../../memory/db-connection.js";
import { getLogger } from "../../util/logger.js";
import { recoverConversationsFromDisk } from "../recovery/conversations-from-disk.js";
import type { WorkspaceMigration } from "./types.js";

const log = getLogger("workspace-migrations");

export const recoverConversationsFromDiskViewMigration: WorkspaceMigration = {
  id: "028-recover-conversations-from-disk-view",
  description:
    "Recover conversations from disk-view directories into the database",

  run(workspaceDir: string): void {
    const { recovered, skipped, errors, warnings } =
      recoverConversationsFromDisk(workspaceDir, getDb());

    for (const w of warnings) log.warn(w);

    if (recovered > 0 || errors > 0) {
      log.info(
        `Recover conversations from disk-view: recovered=${recovered}, skipped=${skipped}, errors=${errors}`,
      );
    }
  },

  // No-op: deleting recovered conversation data from the database would cause
  // data loss — the disk-view files are the only remaining copy after the
  // original DB was lost.
  down(_workspaceDir: string): void {},
};
