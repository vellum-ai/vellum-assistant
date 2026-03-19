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

    // On a fresh install the conversations table may not exist yet (DB schema
    // migrations run after workspace migrations). Nothing to backfill in that
    // case, so bail out gracefully.
    let allConversations: (typeof conversations.$inferSelect)[];
    try {
      allConversations = db
        .select()
        .from(conversations)
        .orderBy(asc(conversations.createdAt))
        .all();
    } catch (e: unknown) {
      if (e instanceof Error && e.message.includes("no such table")) {
        return;
      }
      throw e;
    }

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
              log.info(
                `Backfilled ${processed}/${total} conversations to disk`,
              );
            }
            continue;
          }
        } catch {
          // meta.json exists but is unreadable/malformed — re-create it
        }
      }

      // Create dir + meta.json (initConversationDir sets updatedAt = createdAt)
      initConversationDir(conv);
      // Write the real updatedAt so the idempotency check works on re-run
      updateMetaFile(conv);

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
