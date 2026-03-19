import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { asc, eq } from "drizzle-orm";

import {
  getConversationDirPath,
  initConversationDir,
  syncMessageToDisk,
  updateMetaFile,
} from "../../memory/conversation-disk-view.js";
import { getDb } from "../../memory/db.js";
import { conversations, messages } from "../../memory/schema.js";
import { getLogger } from "../../util/logger.js";
import type { WorkspaceMigration } from "./types.js";

const log = getLogger("workspace-migrations");

export const backfillConversationDiskViewMigration: WorkspaceMigration = {
  id: "009-backfill-conversation-disk-view",
  description: "Rebuild conversation disk view for existing conversations",
  run(_workspaceDir: string): void {
    const db = getDb();

    const allConversations = db
      .select()
      .from(conversations)
      .orderBy(asc(conversations.createdAt))
      .all();

    const total = allConversations.length;
    let processed = 0;

    for (const conv of allConversations) {
      // Check if already migrated (idempotent)
      const dirPath = getConversationDirPath(conv.id, conv.createdAt);
      const metaPath = join(dirPath, "meta.json");

      if (existsSync(metaPath)) {
        try {
          const existing = JSON.parse(readFileSync(metaPath, "utf-8"));
          const expectedUpdatedAt = new Date(conv.updatedAt).toISOString();
          if (existing.updatedAt === expectedUpdatedAt) {
            processed++;
            if (processed % 50 === 0) {
              log.info(`Backfilled ${processed}/${total} conversations to disk`);
            }
            continue;
          }
        } catch {
          // meta.json exists but is unreadable/malformed — re-create it
        }
      }

      // Create dir + meta.json (initConversationDir sets updatedAt = createdAt)
      initConversationDir(conv);

      // Query all messages for this conversation and sync each to disk
      const convMessages = db
        .select()
        .from(messages)
        .where(eq(messages.conversationId, conv.id))
        .orderBy(asc(messages.createdAt))
        .all();

      for (const msg of convMessages) {
        syncMessageToDisk(conv.id, msg.id, conv.createdAt);
      }

      // Write the real updatedAt only AFTER all messages are synced so the
      // idempotency check won't skip a conversation with incomplete messages
      // if the migration is interrupted mid-loop.
      updateMetaFile(conv);

      processed++;
      if (processed % 50 === 0) {
        log.info(`Backfilled ${processed}/${total} conversations to disk`);
      }
    }

    if (total > 0) {
      log.info(`Backfilled ${processed}/${total} conversations to disk`);
    }
  },
};
