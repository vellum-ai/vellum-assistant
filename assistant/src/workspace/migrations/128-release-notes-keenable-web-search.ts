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
  "workspace-migration-128-release-notes-keenable-web-search",
);

const MIGRATION_ID = "128-release-notes-keenable-web-search";
const MARKER = `<!-- release-note-id:${MIGRATION_ID} -->`;

const RELEASE_NOTE = `${MARKER}
## Keenable web search

Keenable is now available as a web search provider. It is keyless by default —
select Keenable for Web Search and it works with no API key (rate-limited). To
lift the rate limit, add a Keenable API key in Settings → Models & Services, or
run \`assistant keys set keenable <key>\`.
`;

export const releaseNotesKeenableWebSearchMigration: WorkspaceMigration = {
  id: MIGRATION_ID,
  description: "Append release notes for Keenable web search to UPDATES.md",

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
        "Appended Keenable web search release note",
      );
    } catch (err) {
      log.warn(
        { err, path: updatesPath },
        "Failed to append Keenable web search release note to UPDATES.md",
      );
    }
  },

  down(_workspaceDir: string): void {
    // Forward-only: UPDATES.md is a user-facing bulletin the assistant
    // processes and deletes on its own.
  },
};
