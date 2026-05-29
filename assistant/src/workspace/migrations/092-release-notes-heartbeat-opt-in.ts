import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { getLogger } from "../../util/logger.js";
import type { WorkspaceMigration } from "./types.js";

const log = getLogger("workspace-migration-092-release-notes-heartbeat-opt-in");

const MIGRATION_ID = "092-release-notes-heartbeat-opt-in";
const MARKER = `<!-- release-note-id:${MIGRATION_ID} -->`;

const RELEASE_NOTE = `${MARKER}
## Heartbeats are now opt-in

Periodic heartbeat check-ins are now off by default. To turn them on, set
\`heartbeat.enabled\` to \`true\` in your config.json, then restart the
assistant. Configs that already set it to \`true\` are unchanged.
`;

export const releaseNotesHeartbeatOptInMigration: WorkspaceMigration = {
  id: MIGRATION_ID,
  description:
    "Append release notes for heartbeat opt-in default to UPDATES.md",

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
      log.info({ path: updatesPath }, "Appended heartbeat opt-in release note");
    } catch (err) {
      log.warn(
        { err, path: updatesPath },
        "Failed to append heartbeat opt-in release note to UPDATES.md",
      );
    }
  },

  down(_workspaceDir: string): void {
    // Forward-only: UPDATES.md is a user-facing bulletin the assistant
    // processes and deletes on its own.
  },
};
