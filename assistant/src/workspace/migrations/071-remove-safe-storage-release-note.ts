import type { WorkspaceMigration } from "./types.js";

const MIGRATION_ID = "071-remove-safe-storage-release-note";

export const removeSafeStorageReleaseNoteMigration: WorkspaceMigration = {
  id: MIGRATION_ID,
  description: "Reserved migration slot for removed safe-storage release-note cleanup",

  run(_workspaceDir: string): void {
    // Registered no-op slot retained for workspace migration checkpoint compatibility.
    // Original migration read/wrote UPDATES.md to strip a stale release-note block;
    // that plumbing was removed alongside the rest of the UPDATES.md teardown.
    // User UPDATES.md files are left untouched per directive.
  },

  down(_workspaceDir: string): void {},
};
