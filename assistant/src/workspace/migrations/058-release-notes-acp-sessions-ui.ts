import type { WorkspaceMigration } from "./types.js";

const MIGRATION_ID = "058-release-notes-acp-sessions-ui";

export const releaseNotesAcpSessionsUiMigration: WorkspaceMigration = {
  id: MIGRATION_ID,
  description: "Reserved migration slot for ACP sessions UI release notes",

  run(_workspaceDir: string): void {
    // Registered no-op slot retained for workspace migration checkpoint compatibility.
  },

  down(_workspaceDir: string): void {},
};
