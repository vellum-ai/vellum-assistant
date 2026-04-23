import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { getLogger } from "../../util/logger.js";
import type { WorkspaceMigration } from "./types.js";

const log = getLogger("workspace-migration-049-release-notes-default-sonnet");

const MIGRATION_ID = "049-release-notes-default-sonnet";
const MARKER = `<!-- release-note-id:${MIGRATION_ID} -->`;

const RELEASE_NOTE = `${MARKER}
## Default LLM is now Claude Sonnet 4.6 (main agent stays on Opus)

The schema-level default for \`llm.default.model\` is now
\`claude-sonnet-4-6\` instead of \`claude-opus-4-7\`, so background call
sites that fall through to the default now use Sonnet. If you've
already chosen a model, your persisted config takes precedence.

The main agent conversation loop remains on Opus: a companion
migration seeds \`llm.callSites.mainAgent = { model: "claude-opus-4-7" }\`
when it's unset, and the \`quality-optimized\` model intent also still
resolves to Opus.

To switch the main agent to Sonnet, clear the call-site override:

\`\`\`bash
assistant config unset llm.callSites.mainAgent
\`\`\`

To switch the overall default back to Opus, run:

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
