import type { WorkspaceMigration } from "./types.js";

const MIGRATION_ID = "049-release-notes-default-sonnet";

export const releaseNotesDefaultSonnetMigration: WorkspaceMigration = {
  id: MIGRATION_ID,
  description: "Reserved migration slot for default Sonnet release notes",

  run(_workspaceDir: string): void {
    // Registered no-op slot retained for workspace migration checkpoint compatibility.
  },

  down(_workspaceDir: string): void {},
};
