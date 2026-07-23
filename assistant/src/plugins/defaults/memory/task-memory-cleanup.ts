import {
  rawAll,
  rawGet,
  rawMemoryAll,
  rawMemoryRun,
} from "../../../persistence/raw-query.js";
import { getLogger } from "./logging.js";

const log = getLogger("task-memory-cleanup");

/**
 * Check whether a conversation belongs to a failed schedule run. Derived from
 * durable storage (cron_runs) so the check survives daemon restarts.
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
       FROM cron_runs
      WHERE conversation_id = ?
        AND status = 'error'
        AND id = (
          SELECT id FROM cron_runs WHERE conversation_id = ?
          ORDER BY created_at DESC LIMIT 1
        )
      LIMIT 1`,
    conversationId,
    conversationId,
  );
  return row != null;
}

/**
 * Invalidate assistant-inferred memory graph nodes sourced *exclusively* from
 * the given conversation. Called when a background schedule fails — the
 * assistant's optimistic claims are not trustworthy if the run didn't
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

  // memory_graph_nodes lives on the memory connection and cron_runs on the main
  // connection, so the old single cross-DB UPDATE is now an app-level two-step:
  // read the candidate nodes on memory, resolve which corroborating
  // conversations are failed on main, then invalidate in JS.
  const candidates = rawMemoryAll<{
    id: string;
    source_conversations: string;
  }>(
    "taskMemory:invalidateInferredNodes:candidates",
    `SELECT id, source_conversations
       FROM memory_graph_nodes
      WHERE source_type = 'inferred'
        AND fidelity != 'gone'
        AND EXISTS (
          SELECT 1 FROM json_each(source_conversations) jc
           WHERE jc.value = ?
        )`,
    conversationId,
  );
  if (candidates.length === 0) return 0;

  // Gather every corroborating (non-failed-conversation) source id across the
  // candidates, then ask the main DB which of them are failed.
  const otherIds = new Set<string>();
  const parsed = candidates.map((c) => {
    let sources: string[] = [];
    try {
      const raw = JSON.parse(c.source_conversations) as unknown;
      if (Array.isArray(raw)) {
        sources = raw.filter((s): s is string => typeof s === "string");
      }
    } catch {
      sources = [];
    }
    const others = sources.filter((s) => s !== conversationId);
    for (const o of others) otherIds.add(o);
    return { id: c.id, others };
  });

  const failedIds = failedConversationIds(otherIds);

  // A node keeps its memory if at least one other source is a valid corroborator
  // (a conversation whose most recent run did not error, or any id with no run
  // at all). Invalidate the rest — the exact predicate of the old NOT EXISTS.
  const toInvalidate = parsed
    .filter((p) => !p.others.some((o) => !failedIds.has(o)))
    .map((p) => p.id);
  if (toInvalidate.length === 0) return 0;

  const placeholders = toInvalidate.map(() => "?").join(", ");
  const affected = rawMemoryRun(
    "taskMemory:invalidateInferredNodes:update",
    `UPDATE memory_graph_nodes
        SET fidelity = 'gone',
            last_accessed = ?
      WHERE fidelity != 'gone'
        AND id IN (${placeholders})`,
    Date.now(),
    ...toInvalidate,
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
 * The subset of `ids` whose most recent `cron_runs` row has status `'error'`.
 * A conversation with no runs is not failed. Read on the main connection (where
 * `cron_runs` lives), chunked to stay under SQLite's bound-parameter limit.
 */
function failedConversationIds(ids: Set<string>): Set<string> {
  const failed = new Set<string>();
  if (ids.size === 0) return failed;

  const all = [...ids];
  const CHUNK = 500;
  for (let i = 0; i < all.length; i += CHUNK) {
    const chunk = all.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = rawAll<{ conversation_id: string }>(
      "taskMemory:failedConversations",
      `SELECT cr.conversation_id
         FROM cron_runs cr
        WHERE cr.conversation_id IN (${placeholders})
          AND cr.status = 'error'
          AND cr.id = (
            SELECT cr2.id FROM cron_runs cr2
             WHERE cr2.conversation_id = cr.conversation_id
             ORDER BY cr2.created_at DESC LIMIT 1
          )`,
      ...chunk,
    );
    for (const r of rows) failed.add(r.conversation_id);
  }
  return failed;
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
