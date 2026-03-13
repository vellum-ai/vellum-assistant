import { eq } from "drizzle-orm";

import { getLogger } from "../../util/logger.js";
import { getDb } from "../db.js";
import { extractAndUpsertMemoryItemsForMessage } from "../items-extractor.js";
import { asString } from "../job-utils.js";
import type { MemoryJob } from "../jobs-store.js";
import { messages } from "../schema.js";
import { isConversationFailed } from "../task-memory-cleanup.js";

const log = getLogger("memory-jobs-worker");

export async function extractItemsJob(job: MemoryJob): Promise<void> {
  const messageId = asString(job.payload.messageId);
  const scopeId = asString(job.payload.scopeId);
  if (!messageId || !scopeId) return;

  // If the conversation that owns this message has been marked as failed,
  // skip extraction entirely. This prevents async extraction jobs from
  // re-creating assistant_inferred items after the one-shot invalidation.
  const db = getDb();
  const msg = db
    .select({ conversationId: messages.conversationId })
    .from(messages)
    .where(eq(messages.id, messageId))
    .get();
  if (msg && isConversationFailed(msg.conversationId)) {
    log.info(
      { messageId, conversationId: msg.conversationId },
      "Skipping extraction for failed conversation",
    );
    return;
  }

  await extractAndUpsertMemoryItemsForMessage(
    messageId,
    scopeId,
    msg?.conversationId,
  );
}
