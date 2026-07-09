import {
  rawGet,
  rawMemoryRun,
  rawRun,
} from "../../../persistence/raw-query.js";
import { getLogger } from "../../../util/logger.js";

const log = getLogger("task-memory-cleanup");

/**
 * Check whether a conversation belongs to a failed task run or failed
 * schedule run. Derived from durable storage (task_runs / cron_runs)
 * so the check survives daemon restarts.
 */
export function isConversationFailed(conversationId: string): boolean {
  // For reused schedule conversations the same conversation_id appears in
  // multiple cron_runs. A single failed run should NOT mark the conversation
  // as permanently failed — only the *most recent* run for that conversation
  // matters. We therefore check whether the latest cron_run (by created_at,
  // which is a monotonically increasing epoch timestamp) has an error status.
  // Note: cron_runs.id is a UUID v4 (random), so we cannot use MAX(id).
  const row = rawGet<{ found: number }>(
    "taskMemory:isConversationFailed",
    `SELECT 1 AS found
       FROM (
         SELECT 1 FROM task_runs WHERE conversation_id = ? AND status = 'failed'
         UNION ALL
         SELECT 1 FROM cron_runs
          WHERE conversation_id = ?
            AND status = 'error'
            AND id = (
              SELECT id FROM cron_runs WHERE conversation_id = ?
              ORDER BY created_at DESC LIMIT 1
            )
       )
      LIMIT 1`,
    conversationId,
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
    "taskMemory:invalidateInferredNodes",
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
               -- Check only the most recent cron_run for each conversation
               -- so reused conversations with historical errors but recent
               -- successes are still treated as valid corroborators.
               SELECT 1 FROM cron_runs cr
                WHERE cr.conversation_id = jc2.value
                  AND cr.status = 'error'
                  AND cr.id = (
                    SELECT cr2.id FROM cron_runs cr2
                     WHERE cr2.conversation_id = jc2.value
                     ORDER BY cr2.created_at DESC LIMIT 1
                  )
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
 * Fail every pending/running job of one of `types` keyed to the given
 * conversation (`json_extract(payload, '$.conversationId')` — e.g.
 * `graph_extract`, `memory_retrospective`). Fired from the
 * `conversation-deleted` hook, so the worker does not burn cycles (and error
 * noise) on jobs whose conversation no longer exists.
 *
 * Two deliberate scope limits:
 * - conversationId-keyed only — it runs after the conversation's rows are
 *   deleted, and jobs for surviving multi-sourced graph nodes must stay
 *   runnable;
 * - restricted to the caller's own job types — the hook dispatch is
 *   fire-and-forget, so the sweep runs concurrently with the host cleanup
 *   jobs the delete primitive enqueues (the lexical purge is itself a
 *   `conversationId`-keyed pending job) and must not be able to fail them.
 */
export function cancelPendingJobsForConversation(
  conversationId: string,
  types: readonly string[],
  reason: string = "conversation_deleted",
): number {
  if (types.length === 0) return 0;
  const placeholders = types.map(() => "?").join(", ");
  const cancelled = rawMemoryRun(
    "taskMemory:cancelJobs:byConversation",
    `UPDATE memory_jobs
        SET status = 'failed',
            last_error = ?,
            updated_at = ?
      WHERE status IN ('pending', 'running')
        AND type IN (${placeholders})
        AND json_extract(payload, '$.conversationId') = ?`,
    reason,
    Date.now(),
    ...types,
    conversationId,
  );

  if (cancelled > 0) {
    log.info(
      { conversationId, cancelled },
      "Cancelled pending memory jobs for deleted conversation",
    );
  }

  return cancelled;
}

/**
 * Cancel only pending/running `graph_extract` jobs for the given
 * conversation. Used by the task-failure path where we want to
 * stop new extractions but must NOT cancel `embed_graph_node` jobs —
 * those nodes may be multi-sourced and still valid.
 */
function cancelPendingExtractionJobsForConversation(
  conversationId: string,
): number {
  const now = Date.now();
  const cancelled = rawMemoryRun(
    "taskMemory:cancelExtractionJobs",
    `UPDATE memory_jobs
        SET status = 'failed',
            last_error = 'conversation_failed',
            updated_at = ?
      WHERE status IN ('pending', 'running')
        AND type = 'graph_extract'
        AND json_extract(payload, '$.conversationId') = ?`,
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
