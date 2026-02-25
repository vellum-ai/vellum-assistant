import { getLogger } from '../util/logger.js';
import { rawRun } from './raw-query.js';
import { bumpMemoryVersion } from './recall-cache.js';

const log = getLogger('task-memory-cleanup');

// Conversations whose task/schedule execution failed. Memory extraction
// jobs that arrive after the one-shot invalidation must not create new
// `assistant_inferred` items for these conversations. The set is checked
// at extraction time in the extraction job handler.
const failedConversationIds = new Set<string>();

/** Mark a conversation as failed so future extraction jobs skip it. */
export function markConversationFailed(conversationId: string): void {
  failedConversationIds.add(conversationId);
}

/** Check whether a conversation has been marked as failed. */
export function isConversationFailed(conversationId: string): boolean {
  return failedConversationIds.has(conversationId);
}

/** Remove a conversation from the failed set (used in tests). */
export function clearFailedConversation(conversationId: string): void {
  failedConversationIds.delete(conversationId);
}

/** Clear all failed conversation markers (used in tests). */
export function clearAllFailedConversations(): void {
  failedConversationIds.clear();
}

/**
 * Invalidate `assistant_inferred` memory items sourced *exclusively* from
 * messages in the given conversation. Called when a background task or
 * schedule fails — the assistant's optimistic claims (e.g., "I booked an
 * appointment") are not trustworthy if the task didn't complete.
 *
 * Also marks the conversation as failed so that any pending or future
 * extraction jobs for this conversation are blocked from creating new
 * `assistant_inferred` items.
 *
 * Items that also have sources from other conversations are left alone
 * only when those conversations come from non-failed task/schedule runs
 * (or are ordinary user conversations). This prevents cascading failures
 * from mutually protecting each other — if two conversations both source
 * a memory item and both fail, the item is correctly invalidated.
 */
export function invalidateAssistantInferredItemsForConversation(conversationId: string): number {
  // Mark failed *before* the UPDATE so concurrent extraction jobs
  // that are already running see the flag immediately.
  markConversationFailed(conversationId);

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
    bumpMemoryVersion();
    log.info({ conversationId, affected }, 'Invalidated assistant-inferred memory items after task failure');
  }

  return affected;
}

/**
 * Cancel pending `extract_items` and `extract_entities` jobs whose messageId
 * belongs to the given conversation. This drains the queue so the worker never
 * processes them, complementing the runtime check in the extraction handler.
 */
function cancelPendingExtractionJobsForConversation(conversationId: string): number {
  const now = Date.now();
  const cancelled = rawRun(
    `UPDATE memory_jobs
        SET status = 'failed',
            last_error = 'conversation_failed',
            updated_at = ?
      WHERE type IN ('extract_items', 'extract_entities')
        AND status IN ('pending', 'running')
        AND json_extract(payload, '$.messageId') IN (
          SELECT id FROM messages WHERE conversation_id = ?
        )`,
    now,
    conversationId,
  );

  if (cancelled > 0) {
    log.info({ conversationId, cancelled }, 'Cancelled pending extraction jobs for failed conversation');
  }

  return cancelled;
}
