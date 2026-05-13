import type { WorkspaceMigration } from "./types.js";

const MIGRATION_ID = "068-release-notes-local-timezone";

export const releaseNotesLocalTimezoneMigration: WorkspaceMigration = {
  id: MIGRATION_ID,
  description: "Reserved migration slot for local timezone release notes",

  run(_workspaceDir: string): void {
    // Registered no-op slot retained for workspace migration checkpoint compatibility.
  },

  down(_workspaceDir: string): void {},
};
