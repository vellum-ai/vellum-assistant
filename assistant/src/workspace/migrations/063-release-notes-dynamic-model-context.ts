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
  "workspace-migration-063-release-notes-dynamic-model-context",
);

const MIGRATION_ID = "063-release-notes-dynamic-model-context";
const MARKER = `<!-- release-note-id:${MIGRATION_ID} -->`;

const RELEASE_NOTE = `${MARKER}
## Model-aware inference profile limits

Inference profiles now show max output tokens as a model-aware slider, so the
available range follows the selected model instead of accepting invalid values.

You can also configure the context window per profile. New managed profiles
stay at the conservative 200K context budget by default, and existing profiles
keep their current effective context budget unless you edit them.
`;

export const releaseNotesDynamicModelContextMigration: WorkspaceMigration = {
  id: MIGRATION_ID,
  description:
    "Append release notes for dynamic model context settings to UPDATES.md",

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
        "Appended dynamic model context release note",
      );
    } catch (err) {
      log.warn(
        { err, path: updatesPath },
        "Failed to append dynamic model context release note to UPDATES.md",
      );
    }
  },

  down(_workspaceDir: string): void {
    // Forward-only: UPDATES.md is a user-facing bulletin the assistant
    // processes and deletes on its own.
  },
};
