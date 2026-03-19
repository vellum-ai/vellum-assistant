import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { asc, eq } from "drizzle-orm";

import { resolveConversationDirectoryPaths } from "../../memory/conversation-directories.js";
import {
  initConversationDir,
  syncMessageToDisk,
  updateMetaFile,
} from "../../memory/conversation-disk-view.js";
import { getDb } from "../../memory/db.js";
import { conversations, messages } from "../../memory/schema.js";
import { getLogger } from "../../util/logger.js";

const log = getLogger("workspace-migrations");

function hasExpectedDiskViewArtifacts(
  conv: { updatedAt: number },
  dirPath: string,
): boolean {
  const metaPath = join(dirPath, "meta.json");
  const messagesPath = join(dirPath, "messages.jsonl");
  const attachDir = join(dirPath, "attachments");
  if (
    !existsSync(metaPath) ||
    !existsSync(messagesPath) ||
    !existsSync(attachDir)
  )
    return false;

  try {
    const existing = JSON.parse(readFileSync(metaPath, "utf-8"));
    const expectedUpdatedAt = new Date(conv.updatedAt).toISOString();
    return existing.updatedAt === expectedUpdatedAt;
  } catch {
    return false;
  }
}

function convergeDualConversationDirsToCanonical(
  conv: { updatedAt: number },
  canonicalDirPath: string,
  legacyDirPath: string,
): void {
  if (!existsSync(canonicalDirPath) || !existsSync(legacyDirPath)) return;
  if (!hasExpectedDiskViewArtifacts(conv, canonicalDirPath)) return;
  rmSync(legacyDirPath, { recursive: true, force: true });
}

function getProjectedAttachmentFilenames(messagesPath: string): Set<string> {
  const filenames = new Set<string>();
  if (!existsSync(messagesPath)) return filenames;

  const raw = readFileSync(messagesPath, "utf-8");
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as { attachments?: unknown };
      if (!Array.isArray(parsed.attachments)) continue;
      for (const attachment of parsed.attachments) {
        if (typeof attachment === "string") {
          filenames.add(attachment);
        }
      }
    } catch {
      // Ignore malformed lines. A later replay will rewrite them.
    }
  }

  return filenames;
}

function pruneUnreferencedProjectedAttachments(
  attachDir: string,
  messagesPath: string,
): void {
  if (!existsSync(attachDir)) return;

  const referenced = getProjectedAttachmentFilenames(messagesPath);
  for (const entry of readdirSync(attachDir)) {
    if (referenced.has(entry)) continue;
    rmSync(join(attachDir, entry), { recursive: true, force: true });
  }
}

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
    const {
      canonicalDirPath,
      legacyDirPath,
      resolvedDirPath: dirPath,
    } = resolveConversationDirectoryPaths(conv.id, conv.createdAt);
    const metaPath = join(dirPath, "meta.json");
    const messagesPath = join(dirPath, "messages.jsonl");
    const attachDir = join(dirPath, "attachments");

    // Check if already migrated (idempotent)
    if (existsSync(metaPath) && hasExpectedDiskViewArtifacts(conv, dirPath)) {
      // Prefer the timestamp-first canonical directory whenever both sibling
      // directories exist and the canonical projection is complete.
      convergeDualConversationDirsToCanonical(
        conv,
        canonicalDirPath,
        legacyDirPath,
      );
      processed++;
      if (processed % 50 === 0) {
        log.info(`Backfilled ${processed}/${total} conversations to disk`);
      }
      continue;
    }

    // Create dir + meta.json (initConversationDir sets updatedAt = createdAt)
    initConversationDir(conv);

    // Clear stale data from any previous interrupted run so append-only
    // syncMessageToDisk calls below don't produce duplicates.
    if (existsSync(messagesPath)) {
      rmSync(messagesPath, { force: true });
    }
    writeFileSync(messagesPath, "");

    // Preserve already materialized attachment files across repair replay.
    // Some rows have data_base64 compacted away and only retain their
    // conversation-scoped file_path, so removing attachments/ here would
    // make the content unrecoverable.
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
    pruneUnreferencedProjectedAttachments(attachDir, messagesPath);
    convergeDualConversationDirsToCanonical(
      conv,
      canonicalDirPath,
      legacyDirPath,
    );

    processed++;
    if (processed % 50 === 0) {
      log.info(`Backfilled ${processed}/${total} conversations to disk`);
    }
  }

  if (total > 0) {
    log.info(`Backfilled ${processed}/${total} conversations to disk`);
  }
}
