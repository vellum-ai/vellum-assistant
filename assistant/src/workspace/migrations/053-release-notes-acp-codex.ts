import type { WorkspaceMigration } from "./types.js";

const MIGRATION_ID = "053-release-notes-acp-codex";

export const releaseNotesAcpCodexMigration: WorkspaceMigration = {
  id: MIGRATION_ID,
  description: "Reserved migration slot for ACP Codex release notes",

  run(_workspaceDir: string): void {
    // Registered no-op slot retained for workspace migration checkpoint compatibility.
  },

  down(_workspaceDir: string): void {},
};
