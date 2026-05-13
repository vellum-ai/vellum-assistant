import type { WorkspaceMigration } from "./types.js";

const MIGRATION_ID = "078-release-notes-tavily-web-search";

export const releaseNotesTavilyWebSearchMigration: WorkspaceMigration = {
  id: MIGRATION_ID,
  description: "Reserved migration slot for Tavily web search release notes",

  run(_workspaceDir: string): void {
    // Registered no-op slot retained for workspace migration checkpoint compatibility.
  },

  down(_workspaceDir: string): void {},
};
