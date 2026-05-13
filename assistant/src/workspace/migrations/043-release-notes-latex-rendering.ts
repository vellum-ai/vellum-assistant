import type { WorkspaceMigration } from "./types.js";

const MIGRATION_ID = "043-release-notes-latex-rendering";

export const releaseNotesLatexRenderingMigration: WorkspaceMigration = {
  id: MIGRATION_ID,
  description: "Reserved migration slot for LaTeX rendering release notes",

  run(_workspaceDir: string): void {
    // Registered no-op slot retained for workspace migration checkpoint compatibility.
  },

  down(_workspaceDir: string): void {},
};
