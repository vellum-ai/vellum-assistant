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
 * Invalidate `assistant_inferred` memory items sourced *exclusively* from
 * messages in the given conversation. Called when a background task or
 * schedule fails — the assistant's optimistic claims (e.g., "I booked an
 * appointment") are not trustworthy if the task didn't complete.
 *
 * The failed state is derived from durable storage (task_runs / cron_runs),
 * so any pending or future extraction jobs for this conversation are blocked
 * from creating new `assistant_inferred` items — even after daemon restarts.
 *
 * Items that also have sources from other conversations are left alone
 * only when those conversations come from non-failed task/schedule runs
 * (or are ordinary user conversations). This prevents cascading failures
 * from mutually protecting each other — if two conversations both source
 * a memory item and both fail, the item is correctly invalidated.
 */
export function invalidateAssistantInferredItemsForConversation(
  conversationId: string,
): number {
  // Cancel pending extract_items jobs for this conversation's messages
  // so the worker never processes them. Jobs already running will be
  // caught by the isConversationFailed check in the extraction handler.
  cancelPendingExtractionJobsForConversation(conversationId);

  const affected = rawRun(
    `UPDATE memory_items
        SET status = 'invalidated',
            invalid_at = ?
      WHERE verification_state = 'assistant_inferred'
        AND status = 'active'
        AND id IN (
          SELECT mis.memory_item_id
            FROM memory_item_sources mis
            JOIN messages m ON m.id = mis.message_id
           WHERE m.conversation_id = ?
        )
        AND NOT EXISTS (
          SELECT 1
            FROM memory_item_sources mis2
            JOIN messages m2 ON m2.id = mis2.message_id
           WHERE mis2.memory_item_id = memory_items.id
             AND m2.conversation_id != ?
             -- Only count as corroboration if the other conversation is NOT
             -- from a failed task run or failed schedule run.
             AND NOT EXISTS (
               SELECT 1 FROM task_runs tr
                WHERE tr.conversation_id = m2.conversation_id
                  AND tr.status = 'failed'
             )
             AND NOT EXISTS (
               SELECT 1 FROM cron_runs cr
                WHERE cr.conversation_id = m2.conversation_id
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
      "Invalidated assistant-inferred memory items after task failure",
    );
  }

  return affected;
}

/**
 * Cancel pending `extract_items` jobs whose messageId belongs to the given
 * conversation. This drains the queue so the worker never processes them,
 * complementing the runtime check in the extraction handler.
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
      WHERE type IN ('extract_items')
        AND status IN ('pending', 'running')
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
