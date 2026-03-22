import { rebuildConversationDiskViewFromDb } from "./rebuild-conversation-disk-view.js";
import type { WorkspaceMigration } from "./types.js";

export const repairConversationDiskViewMigration: WorkspaceMigration = {
  id: "013-repair-conversation-disk-view",
  description:
    "Repair missing conversation disk-view folders skipped by the conversationKey creation path",
  run(_workspaceDir: string): void {
    rebuildConversationDiskViewFromDb();
  },
  // No-op: this is a repair migration that rebuilds derived disk-view data
  // from the database. There is no meaningful reverse operation — the data
  // is a cache that can be regenerated, and removing it would just cause
  // unnecessary churn on the next forward run.
  down(_workspaceDir: string): void {},
};
