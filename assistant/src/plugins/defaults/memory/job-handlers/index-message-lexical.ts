import { eq } from "drizzle-orm";

import type { AssistantConfig } from "../../../../config/types.js";
import { getDb } from "../../../../persistence/db-connection.js";
import { generateSparseEmbedding } from "../../../../persistence/embeddings/embedding-backend.js";
import {
  getMessagesLexicalIndex,
  type MessagesLexicalIndex,
} from "../../../../persistence/embeddings/messages-lexical-index.js";
import { withQdrantBreaker } from "../../../../persistence/embeddings/qdrant-circuit-breaker.js";
import {
  asString,
  BackendUnavailableError,
} from "../../../../persistence/job-utils.js";
import type { MemoryJob } from "../../../../persistence/jobs-store.js";
import { messages } from "../../../../persistence/schema/index.js";

/**
 * Resolve the messages lexical index singleton, converting the not-yet-
 * initialized case into a deferrable {@link BackendUnavailableError} (the job
 * worker defers on it) instead of a raw throw that `classifyError` would treat
 * as fatal and drop. Mirrors the `getQdrantClient()` guard in
 * `index-maintenance.ts`.
 */
function resolveLexicalIndex(): MessagesLexicalIndex {
  try {
    return getMessagesLexicalIndex();
  } catch {
    throw new BackendUnavailableError("Messages lexical index not initialized");
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
export async function indexMessageToLexical(message: {
  id: string;
  conversationId: string;
  content: string;
  createdAt: number;
}): Promise<void> {
  const index = resolveLexicalIndex();
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
  _config: AssistantConfig,
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

  await indexMessageToLexical(row);
}

export async function purgeConversationLexicalJob(
  job: MemoryJob,
  _config: AssistantConfig,
): Promise<void> {
  const conversationId = asString(job.payload.conversationId);
  if (!conversationId) return;

  const index = resolveLexicalIndex();
  await withQdrantBreaker(() => index.deleteByConversation(conversationId));
}
