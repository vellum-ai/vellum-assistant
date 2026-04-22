import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { getLogger } from "../../util/logger.js";
import type { WorkspaceMigration } from "./types.js";

const log = getLogger("workspace-migration-047-release-notes-default-sonnet");

const MIGRATION_ID = "047-release-notes-default-sonnet";
const MARKER = `<!-- release-note-id:${MIGRATION_ID} -->`;

const RELEASE_NOTE = `${MARKER}
## Default LLM is now Claude Sonnet 4.6

For new installs and configs that don't explicitly set
\`llm.default.model\`, the default is now \`claude-sonnet-4-6\` instead
of \`claude-opus-4-7\`. If you've already chosen a model, nothing
changes — your persisted config takes precedence.

The \`quality-optimized\` model intent still resolves to Opus, so call
sites that explicitly request that tier are unaffected. To switch back
to Opus as the default, run:

\`\`\`bash
assistant config set llm.default.model claude-opus-4-7
\`\`\`
`;

export const releaseNotesDefaultSonnetMigration: WorkspaceMigration = {
  id: MIGRATION_ID,
  description:
    "Append release notes for default LLM switch to Claude Sonnet 4.6 to UPDATES.md",

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
      log.info({ path: updatesPath }, "Appended default-Sonnet release note");
    } catch (err) {
      log.warn(
        { err, path: updatesPath },
        "Failed to append default-Sonnet release note to UPDATES.md",
      );
    }
  },

  down(_workspaceDir: string): void {
    // Forward-only: UPDATES.md is a user-facing bulletin the assistant
    // processes and deletes on its own.
  },
};
