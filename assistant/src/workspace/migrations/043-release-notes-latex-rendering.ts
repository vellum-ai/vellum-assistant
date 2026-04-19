import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { getLogger } from "../../util/logger.js";
import type { WorkspaceMigration } from "./types.js";

const log = getLogger("workspace-migration-043-release-notes-latex-rendering");

const MIGRATION_ID = "043-release-notes-latex-rendering";
const MARKER = `<!-- release-note-id:${MIGRATION_ID} -->`;

const RELEASE_NOTE = `${MARKER}
## LaTeX math rendering in chat

I can now render LaTeX block-math expressions in the macOS chat. Content wrapped in \`$$...$$\` is typeset instead of shown as raw monospace text. Inline \`$...$\` math is planned as a follow-up.
`;

/**
 * Release-notes migration for LaTeX block-math rendering in the macOS chat.
 *
 * Per AGENTS.md § Release Update Hygiene, user-facing changes ship notes via a
 * workspace migration that appends to `<workspace>/UPDATES.md`. The in-file
 * HTML marker guards against duplicate appends if the runner re-executes this
 * migration after a mid-run crash (between `appendFileSync` and the runner's
 * checkpoint promotion to `applied`), which the runner's own checkpoint state
 * does not cover on its own.
 */
export const releaseNotesLatexRenderingMigration: WorkspaceMigration = {
  id: MIGRATION_ID,
  description:
    "Append release notes for LaTeX block-math rendering to UPDATES.md",

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
      log.info({ path: updatesPath }, "Appended LaTeX rendering release note");
    } catch (err) {
      log.warn(
        { err, path: updatesPath },
        "Failed to append LaTeX rendering release note to UPDATES.md",
      );
    }
  },

  down(_workspaceDir: string): void {
    // Forward-only: UPDATES.md is a user-facing bulletin the assistant
    // processes and deletes on its own. Attempting to reverse a note that may
    // have already been read/deleted would risk surprising user-visible state.
  },
};
