import { and, asc, eq, inArray, lt } from "drizzle-orm";

import type { AssistantConfig } from "../../config/types.js";
import { getLogger } from "../../util/logger.js";
import { getDb, rawAll, rawRun } from "../db.js";
import { asPositiveMs } from "../job-utils.js";
import { enqueueMemoryJob, type MemoryJob } from "../jobs-store.js";
import {
  memoryEmbeddings,
  memoryItemEntities,
  memoryItems,
} from "../schema.js";

const log = getLogger("memory-jobs-worker");

const CLEANUP_BATCH_LIMIT = 250;

export function cleanupStaleSupersededItemsJob(
  job: MemoryJob,
  config: AssistantConfig,
): void {
  const db = getDb();
  const retentionMs =
    asPositiveMs(job.payload.retentionMs) ??
    config.memory.cleanup.supersededItemRetentionMs;
  const cutoff = Date.now() - retentionMs;
  const stale = db
    .select({ id: memoryItems.id })
    .from(memoryItems)
    .where(
      and(
        eq(memoryItems.status, "superseded"),
        lt(memoryItems.invalidAt, cutoff),
      ),
    )
    .orderBy(asc(memoryItems.invalidAt), asc(memoryItems.id))
    .limit(CLEANUP_BATCH_LIMIT)
    .all();
  if (stale.length === 0) return;

  const ids = stale.map((row) => row.id);
  db.delete(memoryItemEntities)
    .where(inArray(memoryItemEntities.memoryItemId, ids))
    .run();
  db.delete(memoryEmbeddings)
    .where(
      and(
        eq(memoryEmbeddings.targetType, "item"),
        inArray(memoryEmbeddings.targetId, ids),
      ),
    )
    .run();
  db.delete(memoryItems).where(inArray(memoryItems.id, ids)).run();
  if (stale.length === CLEANUP_BATCH_LIMIT) {
    enqueueMemoryJob("cleanup_stale_superseded_items", { retentionMs });
  }

  log.debug(
    {
      removedItems: stale.length,
      retentionMs,
      cutoff,
    },
    "Cleaned up stale superseded memory items",
  );
}

const PRUNE_BATCH_LIMIT = 100;

/**
 * Delete conversations that have had no activity (updatedAt) for longer than
 * the configured retention period. Processes in batches so a single job doesn't
 * hold the DB lock for too long.
 *
 * Tables with onDelete cascade on conversation FK (memory_segments,
 * conversation_keys, channel_inbound_events, message_runs, call_sessions,
 * external_conversation_bindings, assistant_inbox_thread_state) are handled
 * automatically. Tables without cascade (messages, tool_invocations,
 * llm_request_logs) are deleted explicitly before removing the conversation row.
 */
export function pruneOldConversationsJob(
  job: MemoryJob,
  config: AssistantConfig,
): void {
  const retentionDays =
    typeof job.payload.retentionDays === "number" &&
    Number.isFinite(job.payload.retentionDays) &&
    job.payload.retentionDays >= 0
      ? job.payload.retentionDays
      : config.memory.cleanup.conversationRetentionDays;

  // 0 means disabled
  if (retentionDays === 0) return;

  const cutoffMs = Date.now() - retentionDays * 86_400_000;

  const stale = rawAll<{ id: string }>(
    `SELECT id FROM conversations WHERE updated_at < ? ORDER BY updated_at ASC LIMIT ?`,
    cutoffMs,
    PRUNE_BATCH_LIMIT,
  );
  if (stale.length === 0) return;

  const db = getDb();
  let pruned = 0;
  for (const { id } of stale) {
    db.transaction(() => {
      // Re-check staleness inside the transaction to avoid racing with a conversation
      // that became active again between the initial SELECT and this DELETE.
      const still = rawAll<{ id: string }>(
        `SELECT id FROM conversations WHERE id = ? AND updated_at < ?`,
        id,
        cutoffMs,
      );
      if (still.length === 0) return;

      // Non-cascading tables
      rawRun(`DELETE FROM llm_request_logs WHERE conversation_id = ?`, id);
      rawRun(`DELETE FROM tool_invocations WHERE conversation_id = ?`, id);
      rawRun(`DELETE FROM messages WHERE conversation_id = ?`, id);
      // Conversation row deletion cascades to remaining dependent tables
      rawRun(`DELETE FROM conversations WHERE id = ?`, id);
      pruned++;
    });
  }

  if (stale.length === PRUNE_BATCH_LIMIT) {
    enqueueMemoryJob("prune_old_conversations", { retentionDays });
  }

  log.info(
    {
      pruned,
      skipped: stale.length - pruned,
      retentionDays,
      cutoffMs,
    },
    "Pruned old conversations",
  );
}
