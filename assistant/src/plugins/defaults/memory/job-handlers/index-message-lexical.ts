import { eq } from "drizzle-orm";

import type { AssistantConfig } from "../../../../config/types.js";
import { getDb } from "../../../../persistence/db-connection.js";
import { generateSparseEmbedding } from "../../../../persistence/embeddings/embedding-backend.js";
import {
  getMessagesLexicalIndex,
  initMessagesLexicalIndex,
  MESSAGES_LEXICAL_COLLECTION,
  type MessagesLexicalIndex,
} from "../../../../persistence/embeddings/messages-lexical-index.js";
import { withQdrantBreaker } from "../../../../persistence/embeddings/qdrant-circuit-breaker.js";
import { resolveQdrantUrl } from "../../../../persistence/embeddings/qdrant-client.js";
import { asString } from "../../../../persistence/job-utils.js";
import {
  enqueueMemoryJob,
  isMemoryEnabled,
  type MemoryJob,
} from "../../../../persistence/jobs-store.js";
import { messages } from "../../../../persistence/schema/index.js";

/**
 * Resolve the messages lexical index singleton, lazily initializing it from
 * `config` when it has not been set up in this process. The eager init in
 * `runMemoryStartup` (startup.ts) only runs in the daemon process; the memory
 * job worker can run as a separate OS process (`jobs/worker.ts`) that never
 * calls `runMemoryStartup`, so without this fallback every lexical job claimed
 * there would throw. `initMessagesLexicalIndex` is idempotent — it just
 * (re)points the singleton at an equivalent client — so re-initializing from
 * the same config is safe.
 */
function resolveLexicalIndex(config: AssistantConfig): MessagesLexicalIndex {
  try {
    return getMessagesLexicalIndex();
  } catch {
    return initMessagesLexicalIndex({
      url: resolveQdrantUrl(config),
      collection: MESSAGES_LEXICAL_COLLECTION,
      onDisk: config.memory.qdrant.onDisk,
    });
  }
}

/**
 * Encode `message.content` with the local sparse encoder and upsert it into the
 * messages lexical (Qdrant) index. The single shared indexing primitive — the
 * `index_message_lexical` job and the backfill path both route through here so
 * the encode + upsert sequence lives in one place.
 *
 * The upsert is wrapped in the Qdrant circuit breaker so a transient Qdrant
 * outage trips the breaker and surfaces as a deferrable error rather than an
 * unhandled throw; the job worker's retry/defer logic then drains the backlog
 * once Qdrant recovers.
 */
export async function indexMessageToLexical(
  message: {
    id: string;
    conversationId: string;
    content: string;
    createdAt: number;
  },
  config: AssistantConfig,
): Promise<void> {
  const index = resolveLexicalIndex(config);
  const sparse = generateSparseEmbedding(message.content);
  await withQdrantBreaker(() =>
    index.upsertMessage(message.id, sparse, {
      conversationId: message.conversationId,
      createdAt: message.createdAt,
    }),
  );
}

export async function indexMessageLexicalJob(
  job: MemoryJob,
  config: AssistantConfig,
): Promise<void> {
  const messageId = asString(job.payload.messageId);
  if (!messageId) return;

  const db = getDb();
  const row = db
    .select({
      id: messages.id,
      conversationId: messages.conversationId,
      content: messages.content,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(eq(messages.id, messageId))
    .get();

  // The message may have been deleted between enqueue and dispatch — no-op.
  if (!row) return;

  await indexMessageToLexical(row, config);
}

export async function purgeConversationLexicalJob(
  job: MemoryJob,
  config: AssistantConfig,
): Promise<void> {
  const conversationId = asString(job.payload.conversationId);
  if (!conversationId) return;

  const index = resolveLexicalIndex(config);
  await withQdrantBreaker(() => index.deleteByConversation(conversationId));
}

/**
 * Enqueue an `index_message_lexical` job for a single message so its content is
 * (re)indexed into the lexical (Qdrant) index off the SQLite write path. Called
 * wherever a message's content becomes durable — on persist and on the
 * streaming/import finalize seams that mirror the segment indexer
 * (`indexMessageNow`).
 *
 * One job per message (not a debounced per-conversation coalesce): the payload
 * carries a specific `messageId`, so coalescing bursts by conversation would
 * drop every message but the last from the index. The upsert into Qdrant is
 * idempotent, so re-enqueuing the same message id is harmless.
 *
 * Gated on {@link isMemoryEnabled} so nothing is enqueued when memory is
 * disabled — matching the gate the segment indexer uses for its `embed_segment`
 * enqueues.
 */
export function enqueueLexicalIndexForMessage(messageId: string): void {
  if (!messageId) return;
  if (!isMemoryEnabled()) return;
  enqueueMemoryJob("index_message_lexical", { messageId });
}

/**
 * Enqueue a `purge_conversation_lexical` job so a deleted/wiped conversation's
 * points are removed from the lexical index. Intentionally NOT gated on
 * {@link isMemoryEnabled}: it is a cleanup path that must run even while the
 * memory plugin is disabled, so points written while it was enabled are not
 * orphaned. The purge targets Qdrant by `conversationId`, so it is correct even
 * after the conversation's message rows have been deleted.
 */
export function enqueuePurgeConversationLexical(conversationId: string): void {
  if (!conversationId) return;
  enqueueMemoryJob("purge_conversation_lexical", { conversationId });
}
