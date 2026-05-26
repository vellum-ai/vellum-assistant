/**
 * Pluggable read source for LLM request logs.
 *
 * The Inspector views at `GET /v1/messages/:id/llm-context` and
 * `GET /v1/conversations/llm-context` (plus the single-log payload route) historically read directly from the local
 * SQLite `llm_request_logs` table via `llm-request-log-store.ts`. The
 * source-of-truth remains local, but the *read path* is now configurable
 * via `llmRequestLogs.readSource` in workspace config.
 *
 * - `local` (default): wraps the existing store functions verbatim.
 * - `clickhouse`: queries the ClickHouse mirror (longer retention, but
 *   only sees rows the mirror cron has flushed). See
 *   `llm-request-log-source-clickhouse.ts`.
 *
 * Implementations are cheap to instantiate, so there's no module-level
 * cache — each call resolves config fresh and constructs a new instance.
 * Config edits take effect on the next request without an invalidation hook.
 */
import { getConfig } from "../config/loader.js";
import type { LogRow } from "./llm-request-log-store.js";

export interface LlmRequestLogSource {
  /** Fetch a single log row by its primary key. Returns null if not found. */
  getRequestLogById(logId: string): Promise<LogRow | null>;

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
   * Fetch every `callSite = "compactionAgent"` log row in the conversation
   * that ran **before** the given cutoff timestamp, ordered chronologically.
   *
   * Drives the Inspector's Compaction tab: the route handler looks up the
   * selected LLM call's `createdAt`, passes it as `beforeCreatedAt`, and
   * gets back the compaction events that contributed to the context that
   * call ran against.
   */
  getCompactionLogsBeforeCall(
    conversationId: string,
    beforeCreatedAt: number,
  ): Promise<LogRow[]>;
}

/**
 * Return the configured LLM request log source.
 *
 * The factory is async because both implementations are loaded via
 * dynamic `import()` on first use. This is deliberate: it keeps the
 * static module graph for `llm-request-log-source.ts` (and for
 * everything that transitively imports it) free of
 * `llm-request-log-store → conversation-crud → indexer → embedding-backend`,
 * which would otherwise force test files that stub `embedding-backend.js`
 * to also stub every export `indexer.ts` reaches for.
 *
 * Callers must `await` both the factory and the source methods.
 */
export async function getLlmRequestLogSource(): Promise<LlmRequestLogSource> {
  const config = getConfig();
  const cfg = config.llmRequestLogs ?? { readSource: "local" as const };

  if (cfg.readSource === "clickhouse") {
    const { ClickHouseLlmRequestLogSource } = await import(
      "./llm-request-log-source-clickhouse.js"
    );
    return new ClickHouseLlmRequestLogSource(cfg.clickhouse);
  }

  const { LocalLlmRequestLogSource } = await import(
    "./llm-request-log-source-local.js"
  );
  return new LocalLlmRequestLogSource();
}
