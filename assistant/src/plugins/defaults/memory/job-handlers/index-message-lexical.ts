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
import { getLogger } from "../../../../util/logger.js";

const log = getLogger("messages-lexical-enqueue");

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

export async function deleteMessageLexicalJob(
  job: MemoryJob,
  config: AssistantConfig,
): Promise<void> {
  const messageId = asString(job.payload.messageId);
  if (!messageId) return;

  const index = resolveLexicalIndex(config);
  await withQdrantBreaker(() => index.deleteByMessageId(messageId));
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
 *
 * Best-effort: the enqueue itself is a memory side effect off the message write
 * path, so a failure (e.g. the memory database is unavailable) is swallowed and
 * logged rather than propagated — a memory hiccup must not escalate a
 * successful message persist into a throw, mirroring the `indexMessageNow` call
 * sites this runs beside.
 */
export function enqueueLexicalIndexForMessage(messageId: string): void {
  if (!messageId) return;
  if (!isMemoryEnabled()) return;
  try {
    enqueueMemoryJob("index_message_lexical", { messageId });
  } catch (err) {
    log.warn(
      { err, messageId },
      "Failed to enqueue lexical index job for message (non-fatal)",
    );
  }
}

/**
 * Enqueue a `purge_conversation_lexical` job so a deleted/wiped conversation's
 * points are removed from the lexical index. Intentionally NOT gated on
 * {@link isMemoryEnabled}: it is a cleanup path that must run even while the
 * memory plugin is disabled, so points written while it was enabled are not
 * orphaned. The purge targets Qdrant by `conversationId`, so it is correct even
 * after the conversation's message rows have been deleted.
 *
 * Callers on the wipe path must enqueue AFTER
 * `cancelPendingJobsForConversation`, which fails every pending
 * `conversationId`-keyed job — otherwise the purge this enqueues is swept by
 * that same cancellation.
 *
 * Best-effort: a failed enqueue (e.g. the memory database is unavailable) is
 * swallowed and logged rather than propagated, so conversation deletion never
 * fails on a memory hiccup.
 */
export function enqueuePurgeConversationLexical(conversationId: string): void {
  if (!conversationId) return;
  try {
    enqueueMemoryJob("purge_conversation_lexical", { conversationId });
  } catch (err) {
    log.warn(
      { err, conversationId },
      "Failed to enqueue lexical purge job for conversation (non-fatal)",
    );
  }
}

/**
 * Enqueue a `delete_message_lexical` job so a deleted message's point is removed
 * from the lexical index. Used by single-message delete paths (assistant-message
 * consolidation, undo) that remove a row without wiping the whole conversation.
 * Like the purge, NOT gated on {@link isMemoryEnabled} (cleanup path) and
 * best-effort so message deletion never fails on a memory hiccup.
 */
export function enqueueDeleteMessageLexical(messageId: string): void {
  if (!messageId) return;
  try {
    enqueueMemoryJob("delete_message_lexical", { messageId });
  } catch (err) {
    log.warn(
      { err, messageId },
      "Failed to enqueue lexical delete job for message (non-fatal)",
    );
  }
}

/**
 * Drop every point from the messages lexical index. Called inline (not via a
 * job) by "clear all conversations": that path deletes all rows and the
 * `memory_jobs` table itself, so there is nothing left to key a per-conversation
 * purge job on. Best-effort — a Qdrant failure is swallowed, matching the other
 * `clearAll` cleanup steps that tolerate failures.
 */
export async function clearMessagesLexicalIndex(
  config: AssistantConfig,
): Promise<void> {
  try {
    const index = resolveLexicalIndex(config);
    await withQdrantBreaker(() => index.clear());
  } catch (err) {
    log.warn({ err }, "Failed to clear messages lexical index (non-fatal)");
  }
}
