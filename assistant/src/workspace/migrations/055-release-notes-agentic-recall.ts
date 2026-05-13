import type { WorkspaceMigration } from "./types.js";

const MIGRATION_ID = "055-release-notes-agentic-recall";

export const releaseNotesAgenticRecallMigration: WorkspaceMigration = {
  id: MIGRATION_ID,
  description: "Reserved migration slot for agentic recall release notes",

  run(_workspaceDir: string): void {
    // Registered no-op slot retained for workspace migration checkpoint compatibility.
  },

  down(_workspaceDir: string): void {},
};
