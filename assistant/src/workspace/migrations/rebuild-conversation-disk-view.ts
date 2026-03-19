import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { asc, eq } from "drizzle-orm";

import {
  getResolvedConversationDirPath,
  initConversationDir,
  syncMessageToDisk,
  updateMetaFile,
} from "../../memory/conversation-disk-view.js";
import { getDb } from "../../memory/db.js";
import { conversations, messages } from "../../memory/schema.js";
import { getLogger } from "../../util/logger.js";

const log = getLogger("workspace-migrations");

/**
 * Rebuild the conversation disk view for all persisted conversations.
 *
 * Conversations are processed by ascending createdAt so replay ordering is
 * stable and deterministic across runs.
 */
export function rebuildConversationDiskViewFromDb(): void {
  const db = getDb();

  const allConversations = db
    .select()
    .from(conversations)
    .orderBy(asc(conversations.createdAt))
    .all();

  const total = allConversations.length;
  let processed = 0;

  for (const conv of allConversations) {
    const dirPath = getResolvedConversationDirPath(conv.id, conv.createdAt);
    const metaPath = join(dirPath, "meta.json");
    const messagesPath = join(dirPath, "messages.jsonl");
    const attachDir = join(dirPath, "attachments");

    // Check if already migrated (idempotent)
    if (existsSync(metaPath)) {
      try {
        const existing = JSON.parse(readFileSync(metaPath, "utf-8"));
        const expectedUpdatedAt = new Date(conv.updatedAt).toISOString();
        const hasRequiredArtifacts =
          existsSync(messagesPath) && existsSync(attachDir);
        if (existing.updatedAt === expectedUpdatedAt && hasRequiredArtifacts) {
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

    // Clear stale data from any previous interrupted run so append-only
    // syncMessageToDisk calls below don't produce duplicates.
    if (existsSync(messagesPath)) {
      rmSync(messagesPath, { force: true });
    }
    if (existsSync(attachDir)) {
      rmSync(attachDir, { recursive: true, force: true });
    }
    writeFileSync(messagesPath, "");
    mkdirSync(attachDir, { recursive: true });

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
}
