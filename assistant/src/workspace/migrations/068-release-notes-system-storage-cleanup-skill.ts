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
  "workspace-migration-068-release-notes-system-storage-cleanup-skill",
);

const MIGRATION_ID = "068-release-notes-system-storage-cleanup-skill";
const MARKER = `<!-- release-note-id:${MIGRATION_ID} -->`;

const RELEASE_NOTE = `${MARKER}
## Storage cleanup guide

Storage cleanup mode now uses a dedicated cleanup guide. When storage is
critically low, the assistant can diagnose large files, identify when database
growth needs product maintenance, and ask before deleting anything.
`;

export const releaseNotesSystemStorageCleanupSkillMigration: WorkspaceMigration =
  {
    id: MIGRATION_ID,
    description:
      "Append release notes for the system storage cleanup skill to UPDATES.md",

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
          "Appended system storage cleanup skill release note",
        );
      } catch (err) {
        log.warn(
          { err, path: updatesPath },
          "Failed to append system storage cleanup skill release note to UPDATES.md",
        );
      }
    },

    down(_workspaceDir: string): void {
      // Forward-only: UPDATES.md is a user-facing bulletin the assistant
      // processes and deletes on its own.
    },
  };
