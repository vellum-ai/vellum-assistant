import { rebuildConversationDiskViewFromDb } from "./rebuild-conversation-disk-view.js";
import type { WorkspaceMigration } from "./types.js";

export const repairConversationDiskViewMigration: WorkspaceMigration = {
  id: "013-repair-conversation-disk-view",
  description:
    "Repair missing conversation disk-view folders skipped by the conversationKey creation path",
  run(_workspaceDir: string): void {
    rebuildConversationDiskViewFromDb();
  },
};
