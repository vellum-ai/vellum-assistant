import type { WorkspaceMigration } from "./types.js";

const MIGRATION_ID = "056-release-notes-inference-profile-reordering";

export const releaseNotesInferenceProfileReorderingMigration: WorkspaceMigration = {
  id: MIGRATION_ID,
  description: "Reserved migration slot for inference profile reordering release notes",

  run(_workspaceDir: string): void {
    // Registered no-op slot retained for workspace migration checkpoint compatibility.
  },

  down(_workspaceDir: string): void {},
};
