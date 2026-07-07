/**
 * Type-only contract for the pluggable LLM request log read source.
 *
 * Extracted into a leaf module so the implementations
 * (`llm-request-log-source-local.ts`, `llm-request-log-source-clickhouse.ts`)
 * can implement the interface without importing back from
 * `llm-request-log-source.ts`, whose factory dynamically imports them — that
 * mutual import formed a circular dependency. `llm-request-log-source.ts`
 * re-exports this interface so its public surface is unchanged.
 */
import type {
  CompactionAgentLogRow,
  LogMetaRow,
  LogRow,
} from "./llm-request-log-store.js";

export interface LlmRequestLogSource {
  /** Fetch a single log row by its primary key. Returns null if not found. */
  getRequestLogById(logId: string): Promise<LogRow | null>;

  /**
   * Fetch a single log row's metadata (no payloads) by its primary key.
   * Prefer this when the caller only needs to locate or validate the row
   * — request payloads can be entire context windows, so loading them for
   * a conversation-scope check or a `createdAt` anchor is wasteful.
   */
  getRequestLogMetaById(logId: string): Promise<LogMetaRow | null>;

  /**
   * Fetch every LLM request log associated with the given message,
   * including all assistant messages in the same agent turn. Implementations
   * MAY additionally apply orphan/unlinked/fork-source recovery — the
   * local implementation does, the ClickHouse mirror does not (it is
   * INSERT-only against the source-of-truth).
   */
  getRequestLogsByMessageId(messageId: string): Promise<LogRow[]>;

  /**
   * Fetch every LLM request log associated with the given conversation.
   * This is the conversation-wide inspector read path: linked, unlinked,
   * and orphaned logs are all included because they share conversation_id.
   */
  getRequestLogsByConversationId(conversationId: string): Promise<LogRow[]>;

  /**
   * Return the `createdAt` of the most recent **non-`compactionAgent`**
   * LLM call in the conversation that ran strictly before
   * `beforeCreatedAt`, or `null` when the selected call is the first real
   * call in the conversation.
   *
   * Drives the call-scoped floor for the Inspector's Compaction tab: a
   * compaction is attributed to the next real call that ran after it, so
   * the compactions for a given call are those that landed strictly
   * between the previous real call and the selected call.
   */
  getPreviousNonCompactionCallCreatedAt(
    conversationId: string,
    beforeCreatedAt: number,
  ): Promise<number | null>;

  /**
   * Fetch every `callSite = "compactionAgent"` log row in the conversation
   * whose `createdAt` falls in the **open window**
   * `(afterCreatedAt, beforeCreatedAt)`, ordered chronologically.
   *
   * The legacy fallback for the Inspector's Compaction tab, used when the
   * ClickHouse compaction log is unavailable. The route handler resolves
   * the floor from `getPreviousNonCompactionCallCreatedAt` and the ceiling
   * from the selected call's `createdAt`; this source method is
   * bound-agnostic. See `getCompactionLogsBetween` in
   * `llm-request-log-store.ts` for the SQL.
   */
  getCompactionLogsBetween(
    conversationId: string,
    afterCreatedAt: number | null,
    beforeCreatedAt: number,
  ): Promise<CompactionAgentLogRow[]>;
}
