import {
  rawAll,
  rawGet,
  rawMemoryRun,
  rawRun,
} from "../../../persistence/raw-query.js";
import { getLogger } from "../../../util/logger.js";

const log = getLogger("task-memory-cleanup");

/**
 * Max id placeholders per `IN (...)` chunk when cancelling jobs by an id set
 * resolved on the main connection. SQLite's default bound-variable limit is
 * well above this, but chunking keeps a pathological conversation (tens of
 * thousands of messages/segments) from building one giant statement.
 */
const ID_CHUNK_SIZE = 500;

/**
 * Fail every pending/running `memory_jobs` row whose `json_extract(payload,
 * jsonPath)` matches one of `ids`. `memory_jobs` lives in the dedicated memory
 * connection while the id sets are resolved on the main connection, so the
 * cancellation can't be a single cross-DB subquery — bind the ids directly
 * (chunked) instead. Returns the total rows affected.
 */
function cancelJobsByPayloadIds(
  jsonPath: string,
  ids: string[],
  reason: string,
  now: number,
): number {
  if (ids.length === 0) return 0;
  let affected = 0;
  for (let i = 0; i < ids.length; i += ID_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + ID_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(", ");
    affected += rawMemoryRun(
      "taskMemory:cancelJobsByPayloadIds",
      `UPDATE memory_jobs
          SET status = 'failed',
              last_error = ?,
              updated_at = ?
        WHERE status IN ('pending', 'running')
          AND json_extract(payload, '${jsonPath}') IN (${placeholders})`,
      reason,
      now,
      ...chunk,
    );
  }
  return affected;
}

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
 * Cancel all pending/running memory jobs referencing the given conversation.
 * Covers every job type: `embed_attachment` (keyed by messageId),
 * `embed_segment` (keyed by segmentId via memory_segments),
 * `graph_extract`, `build_conversation_summary` (keyed by conversationId),
 * and `embed_graph_node` (keyed by nodeId sourced from the conversation).
 */
export function cancelPendingJobsForConversation(
  conversationId: string,
  reason: string = "conversation_wiped",
): number {
  const now = Date.now();
  let total = 0;

  // The id sets live on the main connection; `memory_jobs` lives on the memory
  // connection. Resolve each set on main first, then cancel by bound ids on the
  // memory connection (the conversationId-keyed update needs no main lookup).

  // Jobs keyed by messageId: embed_attachment
  const messageIds = rawAll<{ id: string }>(
    "taskMemory:cancelJobs:messageIds",
    `SELECT id FROM messages WHERE conversation_id = ?`,
    conversationId,
  ).map((r) => r.id);
  total += cancelJobsByPayloadIds("$.messageId", messageIds, reason, now);

  // Jobs keyed by conversationId: graph_extract, build_conversation_summary
  total += rawMemoryRun(
    "taskMemory:cancelJobs:byConversation",
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
  const segmentIds = rawAll<{ id: string }>(
    "taskMemory:cancelJobs:segmentIds",
    `SELECT id FROM memory_segments WHERE conversation_id = ?`,
    conversationId,
  ).map((r) => r.id);
  total += cancelJobsByPayloadIds("$.segmentId", segmentIds, reason, now);

  // Jobs keyed by nodeId: embed_graph_node (nodes sourced from this conversation)
  const nodeIds = rawAll<{ id: string }>(
    "taskMemory:cancelJobs:nodeIds",
    `SELECT mgn.id
       FROM memory_graph_nodes mgn, json_each(mgn.source_conversations) jc
      WHERE jc.value = ?`,
    conversationId,
  ).map((r) => r.id);
  total += cancelJobsByPayloadIds("$.nodeId", nodeIds, reason, now);

  if (total > 0) {
    log.info(
      { conversationId, cancelled: total },
      "Cancelled pending memory jobs for conversation",
    );
  }

  return total;
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
