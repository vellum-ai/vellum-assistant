import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { getLogger } from "../../util/logger.js";
import type { WorkspaceMigration } from "./types.js";

const log = getLogger("workspace-migration-098-release-notes-acp-codex-auth");

const MIGRATION_ID = "098-release-notes-acp-codex-auth";
const MARKER = `<!-- release-note-id:${MIGRATION_ID} -->`;

const RELEASE_NOTE = `${MARKER}
## Codex coding-agent sessions now authenticate automatically

Codex ACP sessions no longer fail with a bare "Authentication required"
error. When Codex asks for authentication, the assistant now authenticates
it automatically using your API key and retries.

- Provide a key by setting \`OPENAI_API_KEY\` (or \`CODEX_API_KEY\`) under
  \`acp.agents.codex.env\` in config.json, or store it in the credential
  vault with \`assistant credentials set --service acp --field
  openai_api_key\` (config.json wins if both are set).
- If you sign in with ChatGPT instead, nothing changes: \`codex login\` in
  the workspace keeps working.
- When no usable key is available, spawn failures now list the auth
  methods the agent supports and how to satisfy them.
`;

export const releaseNotesAcpCodexAuthMigration: WorkspaceMigration = {
  id: MIGRATION_ID,
  description:
    "Append release notes for automatic Codex ACP authentication to UPDATES.md",

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
      log.info({ path: updatesPath }, "Appended Codex ACP auth release note");
    } catch (err) {
      log.warn(
        { err, path: updatesPath },
        "Failed to append Codex ACP auth release note to UPDATES.md",
      );
    }
  },

  down(_workspaceDir: string): void {
    // Forward-only: UPDATES.md is a user-facing bulletin the assistant
    // processes and deletes on its own.
  },
};
