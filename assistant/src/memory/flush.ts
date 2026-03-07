import { getLogger } from "../util/logger.js";
import type { DrizzleDb } from "./db.js";
import { extractAndUpsertMemoryItemsForMessage } from "./items-extractor.js";
import { rawGet } from "./raw-query.js";

const log = getLogger("memory-flush");

export interface FlushMessage {
  id: string;
  role: string;
}

export interface FlushMemoryOptions {
  messages: FlushMessage[];
  conversationId: string;
  scopeId: string;
  db: DrizzleDb;
  abortSignal?: AbortSignal;
}

/**
 * Synchronously extract memory items from messages that haven't been processed
 * yet. Intended for use before compaction discards the raw messages, ensuring
 * no memory-worthy content is lost.
 */
export async function flushMemoryForMessages(
  opts: FlushMemoryOptions,
): Promise<{ flushed: number; skipped: number }> {
  const { messages, conversationId, scopeId, abortSignal } = opts;

  // Only user messages are extracted per current policy
  const userMessages = messages.filter((m) => m.role === "user");

  let flushed = 0;
  let skipped = 0;

  for (const message of userMessages) {
    if (abortSignal?.aborted) {
      log.info(
        { conversationId, flushed, skipped },
        "Memory flush aborted by signal",
      );
      break;
    }

    if (isAlreadyExtracted(message.id)) {
      skipped += 1;
      continue;
    }

    await extractAndUpsertMemoryItemsForMessage(
      message.id,
      scopeId,
      conversationId,
    );
    flushed += 1;
  }

  log.info(
    { conversationId, total: userMessages.length, flushed, skipped },
    "Pre-compaction memory flush complete",
  );

  return { flushed, skipped };
}

/**
 * Check whether a completed `extract_items` job already exists for this
 * message, meaning its memory items have already been extracted.
 */
function isAlreadyExtracted(messageId: string): boolean {
  const row = rawGet<{ id: string }>(
    `SELECT id FROM memory_jobs
     WHERE type = 'extract_items'
       AND status = 'completed'
       AND json_extract(payload, '$.messageId') = ?
     LIMIT 1`,
    messageId,
  );
  return row != null;
}
