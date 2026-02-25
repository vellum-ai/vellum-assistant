/**
 * Projects escalation state from channel_guardian_approval_requests onto
 * assistant_inbox_thread_state.
 *
 * Keeps the inbox UI's escalation badges (pending_escalation_count,
 * has_pending_escalation) in sync with the current set of pending
 * guardian approval requests.
 */

import { countPendingByConversation } from './channel-guardian-store.js';
import { getDb } from './db.js';
import { getSqliteFrom } from './db-connection.js';
import { updateEscalationState } from './inbox-thread-store.js';

/**
 * Recompute pending escalation counts for all inbox threads and update
 * the thread state rows. Called periodically or after approval decisions
 * to keep the inbox UI's escalation badges accurate.
 *
 * Uses a single SQL UPDATE to set counts for all threads in one shot,
 * handling both new escalations and cleared ones atomically.
 */
export function refreshEscalationProjection(assistantId: string = 'self'): void {
  const db = getDb();
  const sqlite = getSqliteFrom(db);
  const now = Date.now();

  sqlite
    .query(
      `UPDATE assistant_inbox_thread_state
       SET pending_escalation_count = (
         SELECT COUNT(*) FROM channel_guardian_approval_requests
         WHERE channel_guardian_approval_requests.conversation_id = assistant_inbox_thread_state.conversation_id
           AND channel_guardian_approval_requests.status = 'pending'
           AND channel_guardian_approval_requests.assistant_id = ?1
       ),
       has_pending_escalation = CASE WHEN (
         SELECT COUNT(*) FROM channel_guardian_approval_requests
         WHERE channel_guardian_approval_requests.conversation_id = assistant_inbox_thread_state.conversation_id
           AND channel_guardian_approval_requests.status = 'pending'
           AND channel_guardian_approval_requests.assistant_id = ?1
       ) > 0 THEN 1 ELSE 0 END,
       updated_at = ?2
       WHERE assistant_id = ?1`,
    )
    .run(assistantId, now);
}

/**
 * Refresh escalation state for a single thread. More efficient than
 * refreshing all threads when only one conversation changed.
 */
export function refreshThreadEscalation(
  conversationId: string,
  assistantId: string = 'self',
): void {
  const pendingCount = countPendingByConversation(conversationId, assistantId);
  updateEscalationState(conversationId, pendingCount);
}
