import type { WorkspaceMigration } from "./types.js";

const MIGRATION_ID = "063-release-notes-dynamic-model-context";

export const releaseNotesDynamicModelContextMigration: WorkspaceMigration = {
  id: MIGRATION_ID,
  description: "Reserved migration slot for dynamic model context release notes",

  run(_workspaceDir: string): void {
    // Registered no-op slot retained for workspace migration checkpoint compatibility.
  },

  down(_workspaceDir: string): void {},
};
