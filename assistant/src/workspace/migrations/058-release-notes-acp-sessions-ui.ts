import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { getLogger } from "../../util/logger.js";
import type { WorkspaceMigration } from "./types.js";

const log = getLogger("workspace-migration-058-release-notes-acp-sessions-ui");

const MIGRATION_ID = "058-release-notes-acp-sessions-ui";
const MARKER = `<!-- release-note-id:${MIGRATION_ID} -->`;

const RELEASE_NOTE = `${MARKER}
## Coding Agents panel for Codex and Claude sessions

A new "Coding Agents" panel in the macOS app and a matching iOS surface show
running and historical Codex and Claude Code sessions with live progress.

- Inline \`Acp Spawn\` step blocks in chat are now tap-to-open and show live
  status as the agent runs.
- A per-conversation filter narrows the panel to just the agents spawned by
  the current conversation.
- Sessions persist across assistant and app restarts: completed sessions
  appear in history, and any sessions that were running when the assistant
  stopped are clearly marked as ended with the assistant.
- \`agent_thought_chunk\` reasoning is now rendered as italic secondary text
  and can be toggled on or off.
`;

export const releaseNotesAcpSessionsUiMigration: WorkspaceMigration = {
  id: MIGRATION_ID,
  description:
    "Append release notes for the Coding Agents panel and ACP session UI to UPDATES.md",

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
      log.info({ path: updatesPath }, "Appended ACP sessions UI release note");
    } catch (err) {
      log.warn(
        { err, path: updatesPath },
        "Failed to append ACP sessions UI release note to UPDATES.md",
      );
    }
  },

  down(_workspaceDir: string): void {
    // Forward-only: UPDATES.md is a user-facing bulletin the assistant
    // processes and deletes on its own.
  },
};
