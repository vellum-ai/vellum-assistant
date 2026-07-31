/**
 * Type-only contract for the pluggable LLM request log WRITE backend — the
 * write-side counterpart to `llm-request-log-source-types.ts` (reads).
 *
 * One implementation per backend:
 *  - `LocalLlmRequestLogWriter` (in `llm-request-log-store.ts`) — the SQLite
 *    `llm_request_logs` table, with full post-hoc mutation support.
 *  - `ClickHouseLlmRequestLogSink` (`llm-request-log-sink-clickhouse.ts`) —
 *    INSERT-only; the post-hoc mutators are documented no-ops.
 *
 * The store's exported write functions resolve the active backend per call
 * (`readSource` config) and dispatch through this interface, so EVERY writer
 * of the table goes through the same resolution — a future third-party
 * backend implements this interface and slots into the resolver without the
 * store growing per-backend branching.
 *
 * Methods are synchronous from the caller's point of view: the local backend
 * writes synchronously on the per-LLM-call critical path (deliberate — see
 * the store's slow-sync-log instrumentation), and remote backends are
 * fire-and-forget (errors logged, never thrown into the turn).
 */

/** A fully-formed `llm_request_logs` row to insert. */
export interface LlmRequestLogWriteRow {
  id: string;
  conversationId: string;
  messageId: string | null;
  provider: string | null;
  requestPayload: string;
  responsePayload: string;
  createdAt: number;
  agentLoopExitReason: string | null;
  callSite: string | null;
  /**
   * JSON first-token latency waterfall. Persisted by the local backend only —
   * remote INSERT-only backends drop it (their table schema doesn't carry it,
   * matching the read source, which treats remote rows as having no latency).
   */
  latencyBreakdown?: string | null;
}

export interface LlmRequestLogWriter {
  /**
   * Insert one request-log row. Local: synchronous SQLite insert. Remote:
   * fire-and-forget — a backend outage must never abort the turn.
   */
  insertRequestLog(row: LlmRequestLogWriteRow): void;

  /**
   * Stamp an `agent_loop_exit_reason` onto the backend's most-recent
   * unstamped row for the conversation. INSERT-only backends no-op: their
   * rows can't be updated after the fact, and mutating the OTHER backend's
   * rows would corrupt history (e.g. stamping this turn's reason onto a
   * stale local row from an earlier local-mode turn).
   */
  setAgentLoopExitReasonOnLatestLog(
    conversationId: string,
    reason: string,
  ): void;

  /**
   * Backfill `message_id` onto the conversation's rows that don't have one
   * yet. INSERT-only backends no-op (same reasoning as the exit-reason
   * stamp — the NULL-scoped predicate is a heuristic over this backend's
   * own rows).
   */
  backfillMessageIdOnLogs(conversationId: string, messageId: string): void;

  /**
   * Re-link rows from a set of source message IDs to a target message
   * (message consolidation). INSERT-only backends no-op.
   */
  relinkLlmRequestLogs(fromMessageIds: string[], toMessageId: string): void;

  /**
   * Backfill `message_id` onto specific recovered rows (by row id) found
   * unlinked on the read path. INSERT-only backends no-op.
   */
  backfillMessageIdOnRecoveredLogs(logIds: string[], messageId: string): void;
}
