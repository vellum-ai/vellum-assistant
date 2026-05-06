import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { getLogger } from "../../util/logger.js";
import type { WorkspaceMigration } from "./types.js";

const log = getLogger("workspace-migration-068-release-notes-local-timezone");

const MIGRATION_ID = "068-release-notes-local-timezone";
const MARKER = `<!-- release-note-id:${MIGRATION_ID} -->`;

const RELEASE_NOTE = `${MARKER}
## Local timezone grounding

The assistant now grounds \`current_time\` in your local timezone across clients,
instead of falling back to UTC when the client can report the device timezone.

Manual timezone overrides still win when configured, and the assistant can help
update a stale override after you confirm that your device timezone should be
used going forward.
`;

export const releaseNotesLocalTimezoneMigration: WorkspaceMigration = {
  id: MIGRATION_ID,
  description:
    "Append release notes for local timezone grounding to UPDATES.md",

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
      log.info({ path: updatesPath }, "Appended local timezone release note");
    } catch (err) {
      log.warn(
        { err, path: updatesPath },
        "Failed to append local timezone release note to UPDATES.md",
      );
    }
  },

  down(_workspaceDir: string): void {
    // Forward-only: UPDATES.md is a user-facing bulletin the assistant
    // processes and deletes on its own.
  },
};
