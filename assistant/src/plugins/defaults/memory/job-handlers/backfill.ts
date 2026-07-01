import { and, asc, eq, gt, or } from "drizzle-orm";

import type { AssistantConfig } from "../../../../config/types.js";
import {
  readMessageCursorCheckpoint,
  resetMessageCursorCheckpoint,
  writeMessageCursorCheckpoint,
} from "../../../../persistence/checkpoints.js";
import { parseMessageMetadata } from "../../../../persistence/conversation-crud.js";
import { getDb } from "../../../../persistence/db-connection.js";
import {
  enqueueMemoryJob,
  type MemoryJob,
} from "../../../../persistence/jobs-store.js";
import { messages } from "../../../../persistence/schema/index.js";
import { indexMessageNow } from "../indexer.js";

const BACKFILL_CHECKPOINT_KEY = "memory:backfill:last_created_at";
const BACKFILL_CHECKPOINT_ID_KEY = "memory:backfill:last_message_id";

export async function backfillJob(
  job: MemoryJob,
  config: AssistantConfig,
): Promise<void> {
  const db = getDb();
  const force = job.payload.force === true;
  if (force) {
    resetMessageCursorCheckpoint(
      BACKFILL_CHECKPOINT_KEY,
      BACKFILL_CHECKPOINT_ID_KEY,
    );
  }

  const cursor = readMessageCursorCheckpoint(
    BACKFILL_CHECKPOINT_KEY,
    BACKFILL_CHECKPOINT_ID_KEY,
  );
  const batch = db
    .select()
    .from(messages)
    .where(
      or(
        gt(messages.createdAt, cursor.createdAt),
        and(
          eq(messages.createdAt, cursor.createdAt),
          gt(messages.id, cursor.messageId),
        ),
      ),
    )
    .orderBy(asc(messages.createdAt), asc(messages.id))
    .limit(200)
    .all();

  if (batch.length > 0) {
    for (const message of batch) {
      const meta = parseMessageMetadata(message.metadata ?? null);
      await indexMessageNow(
        {
          messageId: message.id,
          conversationId: message.conversationId,
          role: message.role,
          content: message.content,
          createdAt: message.createdAt,
          scopeId: "default",
          provenanceTrustClass: meta?.provenanceTrustClass,
          automated: meta?.automated,
        },
        config.memory,
      );
    }
    const lastMessage = batch[batch.length - 1];
    writeMessageCursorCheckpoint(
      BACKFILL_CHECKPOINT_KEY,
      BACKFILL_CHECKPOINT_ID_KEY,
      {
        createdAt: lastMessage.createdAt,
        messageId: lastMessage.id,
      },
    );
  }

  if (batch.length === 200) {
    enqueueMemoryJob("backfill", {});
  }
}
