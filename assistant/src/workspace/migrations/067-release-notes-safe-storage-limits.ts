import type { WorkspaceMigration } from "./types.js";

const MIGRATION_ID = "067-release-notes-safe-storage-limits";

export const releaseNotesSafeStorageLimitsMigration: WorkspaceMigration = {
  id: MIGRATION_ID,
  description: "Reserved migration slot for safe storage limits release notes",

  run(_workspaceDir: string): void {
    // Registered no-op slot retained for workspace migration checkpoint compatibility.
  },

  down(_workspaceDir: string): void {},
};
