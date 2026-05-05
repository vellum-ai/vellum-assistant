import type { AssistantConfig } from "../../config/types.js";
import { getLogger } from "../../util/logger.js";
import { getDb } from "../db-connection.js";
import { enqueueMemoryJob, type MemoryJob } from "../jobs-store.js";
import { rawAll, rawChanges, rawRun } from "../raw-query.js";

const log = getLogger("memory-jobs-worker");

const PRUNE_BATCH_LIMIT = 100;
const PRUNE_LOG_BATCH_LIMIT = 1000;

/**
 * Delete LLM request/response logs older than the configured retention period.
 * Processes in batches to avoid long DB locks and excessive WAL growth.
 * Re-enqueues itself if more rows remain.
 */
export function pruneOldLlmRequestLogsJob(
  job: MemoryJob,
  config: AssistantConfig,
): void {
  const rawRetention = job.payload.retentionMs;
  const retentionMs =
    rawRetention === null
      ? null
      : typeof rawRetention === "number" &&
          Number.isFinite(rawRetention) &&
          rawRetention >= 0
        ? rawRetention
        : config.memory.cleanup.llmRequestLogRetentionMs;

  // null means "keep forever" — skip pruning entirely
  if (retentionMs === null || retentionMs === undefined) return;

  const cutoffMs = Date.now() - retentionMs;

  rawRun(
    `DELETE FROM llm_request_logs WHERE rowid IN (SELECT rowid FROM llm_request_logs WHERE created_at < ? LIMIT ?)`,
    cutoffMs,
    PRUNE_LOG_BATCH_LIMIT,
  );
  const deleted = rawChanges();

  if (deleted >= PRUNE_LOG_BATCH_LIMIT) {
    enqueueMemoryJob("prune_old_llm_request_logs", { retentionMs });
  }

  log.info(
    {
      deleted,
      retentionMs,
      cutoffMs,
    },
    "Pruned old LLM request logs",
  );
}

/**
 * Delete trace events older than the configured retention period.
 * Processes in batches to avoid long DB locks and excessive WAL growth.
 * Re-enqueues itself if more rows remain.
 */
export function pruneOldTraceEventsJob(
  job: MemoryJob,
  config: AssistantConfig,
): void {
  const rawRetention = job.payload.retentionDays;
  const retentionDays =
    typeof rawRetention === "number" &&
    Number.isFinite(rawRetention) &&
    rawRetention >= 0
      ? rawRetention
      : config.memory.cleanup.traceEventRetentionDays;

  // 0 means disabled
  if (retentionDays === 0) return;

  const cutoffMs = Date.now() - retentionDays * 86_400_000;

  rawRun(
    `DELETE FROM trace_events WHERE rowid IN (SELECT rowid FROM trace_events WHERE created_at < ? LIMIT ?)`,
    cutoffMs,
    PRUNE_LOG_BATCH_LIMIT,
  );
  const deleted = rawChanges();

  if (deleted >= PRUNE_LOG_BATCH_LIMIT) {
    enqueueMemoryJob("prune_old_trace_events", { retentionDays });
  }

  log.info(
    {
      deleted,
      retentionDays,
      cutoffMs,
    },
    "Pruned old trace events",
  );
}

/**
 * Delete conversations that have had no activity (updatedAt) for longer than
 * the configured retention period. Processes in batches so a single job doesn't
 * hold the DB lock for too long.
 *
 * Tables with onDelete cascade on conversation FK (memory_segments,
 * conversation_keys, channel_inbound_events, message_runs, call_sessions,
 * external_conversation_bindings, assistant_inbox_conversation_state) are handled
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
