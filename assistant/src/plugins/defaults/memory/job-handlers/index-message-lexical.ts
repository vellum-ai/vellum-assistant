import { eq } from "drizzle-orm";

import { getConfig } from "../../../../config/loader.js";
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
import { asString } from "../../../../persistence/job-utils.js";
import {
  enqueueMemoryJob,
  isMemoryEnabled,
  type MemoryJob,
} from "../../../../persistence/jobs-store.js";
import { messages } from "../../../../persistence/schema/index.js";
import { getLogger } from "../../../../util/logger.js";
import { isPluginDisabled } from "../../../disabled-state.js";
import { resolveQdrantUrl } from "../embeddings.js";
import memoryPkg from "../package.json" with { type: "json" };

const log = getLogger("messages-lexical-enqueue");

/**
 * True when the memory plugin's per-message index writes should be suppressed —
 * either the memory feature is off in config (`memory.enabled === false`) or the
 * `default-memory` plugin is disabled via its `.disabled` sentinel. This mirrors
 * the FULL disabled-state check the host applies in
 * `guardPersistenceHooksByDisabledState`, because the index-write call sites
 * (streaming finalize, import, edit, consolidation) call
 * {@link enqueueLexicalIndexForMessage} directly, outside that guard.
 *
 * On the write side this suppresses ONLY the index/write path — the cleanup
 * paths (purge/delete/clear) must still run while disabled so points written
 * when enabled are not orphaned. It doubles as the read-side population signal:
 * when suppression is active the lexical index is not being forward-filled, so
 * lexical-backed reads must fall back to FTS rather than query a stale/empty
 * `messages_lexical` collection.
 */
export function isMemoryIndexingSuppressed(): boolean {
  return !isMemoryEnabled() || isPluginDisabled(memoryPkg.name);
}

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
export function resolveLexicalIndex(
  config: AssistantConfig,
): MessagesLexicalIndex {
  try {
    return getMessagesLexicalIndex();
  } catch {
    return initMessagesLexicalIndex({
      url: resolveQdrantUrl(),
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

/**
 * Delete a conversation's points from the lexical index. Shared by the
 * `purge_conversation_lexical` job handler and the disabled-memory inline
 * cleanup path (see {@link enqueuePurgeConversationLexical}).
 */
async function purgeConversationLexical(
  conversationId: string,
  config: AssistantConfig,
): Promise<void> {
  const index = resolveLexicalIndex(config);
  await withQdrantBreaker(() => index.deleteByConversation(conversationId));
}

/**
 * Delete a single message's point from the lexical index. Shared by the
 * `delete_message_lexical` job handler and the disabled-memory inline cleanup
 * path (see {@link enqueueDeleteMessageLexical}).
 */
async function deleteMessageLexical(
  messageId: string,
  config: AssistantConfig,
): Promise<void> {
  const index = resolveLexicalIndex(config);
  await withQdrantBreaker(() => index.deleteByMessageId(messageId));
}

export async function purgeConversationLexicalJob(
  job: MemoryJob,
  config: AssistantConfig,
): Promise<void> {
  const conversationId = asString(job.payload.conversationId);
  if (!conversationId) return;
  await purgeConversationLexical(conversationId, config);
}

export async function deleteMessageLexicalJob(
  job: MemoryJob,
  config: AssistantConfig,
): Promise<void> {
  const messageId = asString(job.payload.messageId);
  if (!messageId) return;
  await deleteMessageLexical(messageId, config);
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
 * This is the INDEX/write path: it is gated on {@link isMemoryIndexingSuppressed}
 * — the same FULL disabled-state check the host applies in
 * `guardPersistenceHooksByDisabledState` (config `memory.enabled` AND the
 * `default-memory` `.disabled` sentinel) — so no index job is created while the
 * plugin is disabled. The direct callers (streaming finalize, import, edit,
 * consolidation) run outside that host guard, so the gate lives here.
 *
 * Best-effort: the enqueue itself is a memory side effect off the message write
 * path, so a failure (e.g. the memory database is unavailable) is swallowed and
 * logged rather than propagated — a memory hiccup must not escalate a
 * successful message persist into a throw, mirroring the `indexMessageNow` call
 * sites this runs beside.
 */
export function enqueueLexicalIndexForMessage(messageId: string): void {
  if (!messageId) return;
  if (isMemoryIndexingSuppressed()) return;
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
 * Purge a deleted/wiped conversation's points from the lexical index. This is a
 * cleanup path that must run even while the memory plugin is disabled, so points
 * written while it was enabled are not orphaned.
 *
 * When memory is enabled the work is enqueued as a `purge_conversation_lexical`
 * job (processed off the write path by the worker). When memory is DISABLED the
 * memory job worker skips every job (`runMemoryJobsOnce` returns early), so an
 * enqueued job would sit pending forever and the points would leak — but Qdrant
 * itself is still up (daemon startup boots it unconditionally, independent of
 * `memory.enabled`), so the purge is run INLINE instead, best-effort and
 * breaker-wrapped (a safe no-op if Qdrant is unreachable).
 *
 * The purge targets Qdrant by `conversationId`, so it is correct even after the
 * conversation's message rows have been deleted. Callers on the wipe path must
 * invoke this AFTER `cancelPendingJobsForConversation`, which fails every
 * pending `conversationId`-keyed job — otherwise an enqueued purge is swept by
 * that same cancellation.
 *
 * Best-effort: a failed enqueue or inline purge is swallowed and logged rather
 * than propagated, so conversation deletion never fails on a memory hiccup.
 */
export function enqueuePurgeConversationLexical(conversationId: string): void {
  if (!conversationId) return;
  try {
    if (isMemoryEnabled()) {
      enqueueMemoryJob("purge_conversation_lexical", { conversationId });
    } else {
      void purgeConversationLexical(conversationId, getConfig()).catch((err) =>
        log.warn(
          { err, conversationId },
          "Inline lexical purge failed (memory disabled, non-fatal)",
        ),
      );
    }
  } catch (err) {
    log.warn(
      { err, conversationId },
      "Failed to schedule lexical purge for conversation (non-fatal)",
    );
  }
}

/**
 * Remove a deleted message's point from the lexical index. Used by
 * single-message delete paths (consolidation, undo) that remove a row without
 * wiping the whole conversation. Like the purge, a cleanup path: enqueues a
 * `delete_message_lexical` job when memory is enabled, and runs INLINE
 * (best-effort, breaker-wrapped) when memory is disabled — where the worker
 * would never process the job but Qdrant is still reachable. Best-effort so
 * message deletion never fails on a memory hiccup.
 */
export function enqueueDeleteMessageLexical(messageId: string): void {
  if (!messageId) return;
  try {
    if (isMemoryEnabled()) {
      enqueueMemoryJob("delete_message_lexical", { messageId });
    } else {
      void deleteMessageLexical(messageId, getConfig()).catch((err) =>
        log.warn(
          { err, messageId },
          "Inline lexical delete failed (memory disabled, non-fatal)",
        ),
      );
    }
  } catch (err) {
    log.warn(
      { err, messageId },
      "Failed to schedule lexical delete for message (non-fatal)",
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
