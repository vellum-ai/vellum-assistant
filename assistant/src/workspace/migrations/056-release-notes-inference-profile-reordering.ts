import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { getLogger } from "../../util/logger.js";
import type { WorkspaceMigration } from "./types.js";

const log = getLogger("workspace-migration-056-release-notes-inference-profile-reordering");

const MIGRATION_ID = "056-release-notes-inference-profile-reordering";
const MARKER = `<!-- release-note-id:${MIGRATION_ID} -->`;

const RELEASE_NOTE = `${MARKER}
## Inference profiles can be reordered

You can now drag inference profiles into the order you want from Settings.
The same order appears anywhere you pick a profile, including the active
profile dropdown, chat profile picker, and per-call-site overrides.
`;

export const releaseNotesInferenceProfileReorderingMigration: WorkspaceMigration =
  {
    id: MIGRATION_ID,
    description: "Append release notes for inference profile reordering to UPDATES.md",

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
          "Appended inference profile reordering release note",
        );
      } catch (err) {
        log.warn(
          { err, path: updatesPath },
          "Failed to append inference profile reordering release note to UPDATES.md",
        );
      }
    },

    down(_workspaceDir: string): void {
      // Forward-only: UPDATES.md is a user-facing bulletin the assistant
      // processes and deletes on its own.
    },
  };
