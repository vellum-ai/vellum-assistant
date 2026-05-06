import type { WorkspaceMigration } from "./types.js";

const MIGRATION_ID = "067-release-notes-safe-storage-limits";

export const releaseNotesSafeStorageLimitsMigration: WorkspaceMigration = {
  id: MIGRATION_ID,
  description: "Reserved migration slot for safe storage limits release notes",

  run(_workspaceDir: string): void {
    // Tombstoned: this migration id must remain registered for checkpoint
    // compatibility, but it no longer writes a release bulletin.
  },

  down(_workspaceDir: string): void {
    // No-op.
  },
};
