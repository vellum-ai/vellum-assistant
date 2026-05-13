import type { WorkspaceMigration } from "./types.js";

const MIGRATION_ID = "045-release-notes-meet-avatar";

export const releaseNotesMeetAvatarMigration: WorkspaceMigration = {
  id: MIGRATION_ID,
  description: "Reserved migration slot for meet avatar release notes",

  run(_workspaceDir: string): void {
    // Registered no-op slot retained for workspace migration checkpoint compatibility.
  },

  down(_workspaceDir: string): void {},
};
