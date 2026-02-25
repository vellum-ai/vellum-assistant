import { getLogger } from '../util/logger.js';
import { rawRun } from './raw-query.js';
import { bumpMemoryVersion } from './recall-cache.js';

const log = getLogger('task-memory-cleanup');

/**
 * Invalidate `assistant_inferred` memory items sourced *exclusively* from
 * messages in the given conversation. Called when a background task or
 * schedule fails — the assistant's optimistic claims (e.g., "I booked an
 * appointment") are not trustworthy if the task didn't complete.
 *
 * Items that also have sources from other conversations are left alone
 * because those other conversations still corroborate the claim.
 */
export function invalidateAssistantInferredItemsForConversation(conversationId: string): number {
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
