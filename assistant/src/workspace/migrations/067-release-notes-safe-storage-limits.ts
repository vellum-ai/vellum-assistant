import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { getLogger } from "../../util/logger.js";
import type { WorkspaceMigration } from "./types.js";

const log = getLogger(
  "workspace-migration-067-release-notes-safe-storage-limits",
);

const MIGRATION_ID = "067-release-notes-safe-storage-limits";
const MARKER = `<!-- release-note-id:${MIGRATION_ID} -->`;

const RELEASE_NOTE = `${MARKER}
## Safe storage limits

A new storage protection mode is available behind the safe-storage-limits
rollout flag. When enabled, the assistant watches workspace disk usage and
enters cleanup mode if the volume reaches the critical 95% threshold.

In cleanup mode, background processes pause and remote messages, including
trusted-contact messages, are blocked until the guardian frees enough space or
explicitly overrides the lock. The macOS app now shows a storage cleanup banner
that must be acknowledged before cleanup chat continues, then keeps a status
banner visible while cleanup mode is active.
`;

export const releaseNotesSafeStorageLimitsMigration: WorkspaceMigration = {
  id: MIGRATION_ID,
  description: "Append release notes for safe storage limits to UPDATES.md",

  run(workspaceDir: string): void {
    const updatesPath = join(workspaceDir, "UPDATES.md");

    try {
      if (existsSync(updatesPath)) {
        const existing = readFileSync(updatesPath, "utf-8");
        if (existing.includes(MARKER)) {
          return;
        }
        const needsLeadingNewline = !existing.endsWith("\n\n");
        const prefix = existing.endsWith("\n") ? "\n" : "\n\n";
        appendFileSync(
          updatesPath,
          needsLeadingNewline ? `${prefix}${RELEASE_NOTE}` : RELEASE_NOTE,
          "utf-8",
        );
      } else {
        writeFileSync(updatesPath, RELEASE_NOTE, "utf-8");
      }
      log.info(
        { path: updatesPath },
        "Appended safe storage limits release note",
      );
    } catch (err) {
      log.warn(
        { err, path: updatesPath },
        "Failed to append safe storage limits release note to UPDATES.md",
      );
    }
  },

  down(_workspaceDir: string): void {
    // Forward-only: UPDATES.md is a user-facing bulletin the assistant
    // processes and deletes on its own.
  },
};
