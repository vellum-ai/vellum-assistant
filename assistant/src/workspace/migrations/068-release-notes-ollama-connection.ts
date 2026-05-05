import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { getLogger } from "../../util/logger.js";
import type { WorkspaceMigration } from "./types.js";

const log = getLogger("workspace-migration-068-release-notes-ollama-connection");

const MIGRATION_ID = "068-release-notes-ollama-connection";
const MARKER = `<!-- release-note-id:${MIGRATION_ID} -->`;

const RELEASE_NOTE = `${MARKER}
## Local Ollama connections

Local Ollama still works without an API key. You can now save an optional
Ollama API key for authenticated proxies, and Docker self-hosted setups can
pass \`OLLAMA_BASE_URL\` so the assistant reaches the host's Ollama server.
`;

export const releaseNotesOllamaConnectionMigration: WorkspaceMigration = {
  id: MIGRATION_ID,
  description: "Append release notes for local Ollama connection settings",

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
      log.info({ path: updatesPath }, "Appended Ollama connection release note");
    } catch (err) {
      log.warn(
        { err, path: updatesPath },
        "Failed to append Ollama connection release note to UPDATES.md",
      );
    }
  },

  down(_workspaceDir: string): void {
    // Forward-only: UPDATES.md is a user-facing bulletin the assistant
    // processes and deletes on its own.
  },
};
