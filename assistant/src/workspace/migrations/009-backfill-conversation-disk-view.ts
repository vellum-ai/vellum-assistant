import { rebuildConversationDiskViewFromDb } from "./rebuild-conversation-disk-view.js";
import type { WorkspaceMigration } from "./types.js";

export const backfillConversationDiskViewMigration: WorkspaceMigration = {
  id: "009-backfill-conversation-disk-view",
  description: "Rebuild conversation disk view for existing conversations",
  run(_workspaceDir: string): void {
    rebuildConversationDiskViewFromDb();
  },
};
