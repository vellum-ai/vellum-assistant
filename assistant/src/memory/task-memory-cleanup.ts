import { getLogger } from "../util/logger.js";
import { rawGet, rawRun } from "./raw-query.js";

const log = getLogger("task-memory-cleanup");

/**
 * Check whether a conversation belongs to a failed task run or failed
 * schedule run. Derived from durable storage (task_runs / cron_runs)
 * so the check survives daemon restarts.
 */
export function isConversationFailed(conversationId: string): boolean {
  const row = rawGet<{ found: number }>(
    `SELECT 1 AS found
       FROM (
         SELECT 1 FROM task_runs WHERE conversation_id = ? AND status = 'failed'
         UNION ALL
         SELECT 1 FROM cron_runs WHERE conversation_id = ? AND status = 'error'
       )
      LIMIT 1`,
    conversationId,
    conversationId,
  );
  return row != null;
}

/**
 * Invalidate assistant-inferred memory graph nodes sourced *exclusively* from
 * the given conversation. Called when a background task or schedule fails —
 * the assistant's optimistic claims are not trustworthy if the task didn't
 * complete.
 *
 * Nodes that also have sources from other non-failed conversations are left
 * alone (corroboration). Uses the `source_conversations` JSON array to
 * determine provenance.
 */
export function invalidateAssistantInferredItemsForConversation(
  conversationId: string,
): number {
  cancelPendingExtractionJobsForConversation(conversationId);

  const affected = rawRun(
    `UPDATE memory_graph_nodes
        SET fidelity = 'gone',
            last_accessed = ?
      WHERE source_type = 'inferred'
        AND fidelity != 'gone'
        AND EXISTS (
          SELECT 1 FROM json_each(source_conversations) jc
           WHERE jc.value = ?
        )
        AND NOT EXISTS (
          SELECT 1 FROM json_each(source_conversations) jc2
           WHERE jc2.value != ?
             AND NOT EXISTS (
               SELECT 1 FROM task_runs tr
                WHERE tr.conversation_id = jc2.value
                  AND tr.status = 'failed'
             )
             AND NOT EXISTS (
               SELECT 1 FROM cron_runs cr
                WHERE cr.conversation_id = jc2.value
                  AND cr.status = 'error'
             )
        )`,
    Date.now(),
    conversationId,
    conversationId,
  );

  if (affected > 0) {
    log.info(
      { conversationId, affected },
      "Invalidated assistant-inferred memory graph nodes after task failure",
    );
  }

  return affected;
}

/**
 * Cancel all pending/running memory jobs referencing the given conversation.
 * Covers every job type: `extract_items`, `embed_attachment` (keyed by messageId),
 * `embed_segment` (keyed by segmentId via memory_segments),
 * `build_conversation_summary` (keyed by conversationId),
 * and `embed_graph_node` (keyed by nodeId sourced from the conversation).
 */
export function cancelPendingJobsForConversation(
  conversationId: string,
  reason: string = "conversation_wiped",
): number {
  const now = Date.now();
  let total = 0;

  // Jobs keyed by messageId: extract_items, embed_attachment
  total += rawRun(
    `UPDATE memory_jobs
        SET status = 'failed',
            last_error = ?,
            updated_at = ?
      WHERE status IN ('pending', 'running')
        AND json_extract(payload, '$.messageId') IN (
          SELECT id FROM messages WHERE conversation_id = ?
        )`,
    reason,
    now,
    conversationId,
  );

  // Jobs keyed by conversationId: build_conversation_summary
  total += rawRun(
    `UPDATE memory_jobs
        SET status = 'failed',
            last_error = ?,
            updated_at = ?
      WHERE status IN ('pending', 'running')
        AND json_extract(payload, '$.conversationId') = ?`,
    reason,
    now,
    conversationId,
  );

  // Jobs keyed by segmentId: embed_segment (segments belong to the conversation)
  total += rawRun(
    `UPDATE memory_jobs
        SET status = 'failed',
            last_error = ?,
            updated_at = ?
      WHERE status IN ('pending', 'running')
        AND json_extract(payload, '$.segmentId') IN (
          SELECT id FROM memory_segments WHERE conversation_id = ?
        )`,
    reason,
    now,
    conversationId,
  );

  // Jobs keyed by nodeId: embed_graph_node (nodes sourced from this conversation)
  total += rawRun(
    `UPDATE memory_jobs
        SET status = 'failed',
            last_error = ?,
            updated_at = ?
      WHERE status IN ('pending', 'running')
        AND json_extract(payload, '$.nodeId') IN (
          SELECT mgn.id
            FROM memory_graph_nodes mgn, json_each(mgn.source_conversations) jc
           WHERE jc.value = ?
        )`,
    reason,
    now,
    conversationId,
  );

  if (total > 0) {
    log.info(
      { conversationId, cancelled: total },
      "Cancelled pending memory jobs for conversation",
    );
  }

  return total;
}

/**
 * Cancel only pending/running `extract_items` jobs for messages in the
 * given conversation. Used by the task-failure path where we want to
 * stop new extractions but must NOT cancel `embed_graph_node` jobs —
 * those nodes may be multi-sourced and still valid.
 */
function cancelPendingExtractionJobsForConversation(
  conversationId: string,
): number {
  const now = Date.now();
  const cancelled = rawRun(
    `UPDATE memory_jobs
        SET status = 'failed',
            last_error = 'conversation_failed',
            updated_at = ?
      WHERE status IN ('pending', 'running')
        AND type = 'extract_items'
        AND json_extract(payload, '$.messageId') IN (
          SELECT id FROM messages WHERE conversation_id = ?
        )`,
    now,
    conversationId,
  );

  if (cancelled > 0) {
    log.info(
      { conversationId, cancelled },
      "Cancelled pending extraction jobs for failed conversation",
    );
  }

  return cancelled;
}
