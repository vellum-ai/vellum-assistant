import { and, asc, eq, gt, or } from "drizzle-orm";

import type { AssistantConfig } from "../../../../config/types.js";
import {
  readMessageCursorCheckpoint,
  resetMessageCursorCheckpoint,
  writeMessageCursorCheckpoint,
} from "../../../../persistence/checkpoints.js";
import { getDb } from "../../../../persistence/db-connection.js";
import { generateSparseEmbedding } from "../../../../persistence/embeddings/embedding-backend.js";
import { withQdrantBreaker } from "../../../../persistence/embeddings/qdrant-circuit-breaker.js";
import {
  enqueueMemoryJob,
  type MemoryJob,
} from "../../../../persistence/jobs-store.js";
import { messages } from "../../../../persistence/schema/index.js";
import { resolveLexicalIndex } from "./index-message-lexical.js";

/**
 * Cursor checkpoint keys for the lexical-index backfill. Kept distinct from the
 * dense embedding backfill's keys (`memory:backfill:*`) so the two backfills
 * advance independently — enabling lexical without re-running the dense one, and
 * vice versa.
 */
const LEXICAL_BACKFILL_CHECKPOINT_KEY = "lexical:messages:last_created_at";
const LEXICAL_BACKFILL_CHECKPOINT_ID_KEY = "lexical:messages:last_id";

/** Messages indexed per job invocation before the job re-enqueues itself. */
const BATCH_SIZE = 200;

/**
 * Resumable, cursor-checkpointed backfill of existing messages into the Qdrant
 * lexical index. Selects the next {@link BATCH_SIZE} messages ordered by
 * `(createdAt asc, id asc)` after the persisted cursor, encodes each with the
 * local sparse encoder, batch-upserts them, advances the cursor, and
 * re-enqueues itself when the batch is full — draining the whole `messages`
 * table across many short invocations without blocking the event loop.
 *
 * Idempotent: the upsert keys on a deterministic point id derived from the
 * message id, so re-indexing the same message overwrites the same point. Pass
 * `payload.force` to reset the cursor and re-index from the beginning.
 */
export async function backfillLexicalIndexJob(
  job: MemoryJob,
  config: AssistantConfig,
): Promise<void> {
  const db = getDb();
  const force = job.payload.force === true;
  if (force) {
    resetMessageCursorCheckpoint(
      LEXICAL_BACKFILL_CHECKPOINT_KEY,
      LEXICAL_BACKFILL_CHECKPOINT_ID_KEY,
    );
  }

  const cursor = readMessageCursorCheckpoint(
    LEXICAL_BACKFILL_CHECKPOINT_KEY,
    LEXICAL_BACKFILL_CHECKPOINT_ID_KEY,
  );
  const batch = db
    .select({
      id: messages.id,
      conversationId: messages.conversationId,
      content: messages.content,
      createdAt: messages.createdAt,
    })
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
    .limit(BATCH_SIZE)
    .all();

  if (batch.length > 0) {
    const index = resolveLexicalIndex(config);
    const points = batch.map((message) => ({
      messageId: message.id,
      sparse: generateSparseEmbedding(message.content),
      conversationId: message.conversationId,
      createdAt: message.createdAt,
    }));
    await withQdrantBreaker(() => index.upsertMessagesBatch(points));

    const lastMessage = batch[batch.length - 1];
    writeMessageCursorCheckpoint(
      LEXICAL_BACKFILL_CHECKPOINT_KEY,
      LEXICAL_BACKFILL_CHECKPOINT_ID_KEY,
      {
        createdAt: lastMessage.createdAt,
        messageId: lastMessage.id,
      },
    );
  }

  // A full batch means there may be more rows past the new cursor — re-enqueue
  // to continue draining. Never carry `force` forward: the reset already
  // happened this invocation, and re-resetting would loop over the same head.
  if (batch.length === BATCH_SIZE) {
    enqueueMemoryJob("backfill_lexical_index", {});
  }
}
