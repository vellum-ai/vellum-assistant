import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { getLogger } from "../../util/logger.js";
import type { WorkspaceMigration } from "./types.js";

const log = getLogger("workspace-migration-053-release-notes-acp-codex");

const MIGRATION_ID = "053-release-notes-acp-codex";
const MARKER = `<!-- release-note-id:${MIGRATION_ID} -->`;

const RELEASE_NOTE = `${MARKER}
## ACP: Codex and Claude profiles + \`acp_steer\`

The assistant now ships with default ACP profiles for \`claude\` and
\`codex\`. They become available **after enabling ACP and installing the
corresponding adapter** — the profiles are wired in by default but the
underlying agent binaries are not bundled.

A new \`acp_steer\` tool lets the assistant interrupt and redirect a
running ACP session without ending it, so I can course-correct an agent
mid-task.

### Setup

1. Enable ACP in your config:

   \`\`\`bash
   assistant config set acp.enabled true
   \`\`\`

2. Install the adapter for whichever agent(s) you want to use:

   \`\`\`bash
   npm i -g @zed-industries/codex-acp
   npm i -g @agentclientprotocol/claude-agent-acp
   \`\`\`

If a required binary is missing when I try to spawn an ACP session, I'll
surface an install hint so you know which package to add.

### Known limitation (v1)

Live step-by-step progress for ACP sessions is not yet rendered in the
macOS app. The agent's final response lands in chat when it completes —
intermediate tool calls and partial output are still being plumbed
through. Live progress UI is a follow-up.
`;

/**
 * Release-notes migration for the ACP Codex/Claude defaults + \`acp_steer\`.
 *
 * Per AGENTS.md § Release Update Hygiene, user-facing changes ship notes via a
 * workspace migration that appends to `<workspace>/UPDATES.md`. The in-file
 * HTML marker guards against duplicate appends if the runner re-executes this
 * migration after a mid-run crash (between `appendFileSync` and the runner's
 * checkpoint promotion to `applied`), which the runner's own checkpoint state
 * does not cover on its own.
 */
export const releaseNotesAcpCodexMigration: WorkspaceMigration = {
  id: MIGRATION_ID,
  description:
    "Append release notes for ACP Codex/Claude defaults and acp_steer to UPDATES.md",

  run(workspaceDir: string): void {
    const updatesPath = join(workspaceDir, "UPDATES.md");

    try {
      if (existsSync(updatesPath)) {
        const existing = readFileSync(updatesPath, "utf-8");
        if (existing.includes(MARKER)) {
          // Marker already present — a prior run of this migration appended
          // the note. Short-circuit to keep the migration idempotent across
          // the narrow crash window between append and runner checkpoint.
          return;
        }
        // Ensure separation from prior content.
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
      log.info({ path: updatesPath }, "Appended ACP Codex/Claude release note");
    } catch (err) {
      log.warn(
        { err, path: updatesPath },
        "Failed to append ACP Codex/Claude release note to UPDATES.md",
      );
    }
  },

  down(_workspaceDir: string): void {
    // Forward-only: UPDATES.md is a user-facing bulletin the assistant
    // processes and deletes on its own. Attempting to reverse a note that may
    // have already been read/deleted would risk surprising user-visible state.
  },
};
