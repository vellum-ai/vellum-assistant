import { rebuildConversationDiskViewFromDb } from "./rebuild-conversation-disk-view.js";
import type { WorkspaceMigration } from "./types.js";

export const backfillConversationDiskViewMigration: WorkspaceMigration = {
  id: "009-backfill-conversation-disk-view",
  description: "Rebuild conversation disk view for existing conversations",
  run(_workspaceDir: string): void {
    rebuildConversationDiskViewFromDb();
  },
  // No-op: the disk view is a derived cache that can be regenerated from the
  // database at any time. Removing it would only cause unnecessary I/O churn
  // since the next forward migration (or startup rebuild) will recreate it.
  down(_workspaceDir: string): void {},
};
