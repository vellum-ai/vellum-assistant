/**
 * Pluggable read source for LLM request logs.
 *
 * The Inspector view at `GET /v1/messages/:id/llm-context` (and the
 * single-log payload route) historically read directly from the local
 * SQLite `llm_request_logs` table via `llm-request-log-store.ts`. The
 * source-of-truth remains local, but the *read path* is now configurable
 * via `llmRequestLogs.readSource` in workspace config.
 *
 * - `local` (default): wraps the existing store functions verbatim.
 * - `clickhouse`: queries the ClickHouse mirror (longer retention, but
 *   only sees rows the mirror cron has flushed). See
 *   `llm-request-log-source-clickhouse.ts`.
 *
 * The active source is cached at module level and invalidated on config
 * change (see `daemon/config-watcher.ts`) so a config edit takes effect
 * without restarting the daemon.
 */
import { getConfig } from "../config/loader.js";
import { getLogger } from "../util/logger.js";
import { ClickHouseLlmRequestLogSource } from "./llm-request-log-source-clickhouse.js";
import { LocalLlmRequestLogSource } from "./llm-request-log-source-local.js";
import type { LogRow } from "./llm-request-log-store.js";

const log = getLogger("llm-request-log-source");

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
}

let cached: LlmRequestLogSource | null = null;
let cachedKind: "local" | "clickhouse" | null = null;

/**
 * Return the currently configured LLM request log source.
 *
 * The result is cached for the lifetime of the process. Callers should
 * never hang on to the instance across config reloads — always re-resolve
 * through this function. Callers MUST `await` both methods even though the
 * local implementation is synchronous, because the active source may swap
 * to one with real I/O at any time.
 */
export function getLlmRequestLogSource(): LlmRequestLogSource {
  if (cached) return cached;

  const config = getConfig();
  const kind = config.llmRequestLogs?.readSource ?? "local";

  if (kind === "clickhouse") {
    cached = new ClickHouseLlmRequestLogSource(config.llmRequestLogs.clickhouse);
    cachedKind = "clickhouse";
    log.info(
      { table: config.llmRequestLogs.clickhouse.table },
      "Using ClickHouse for LLM request log reads",
    );
  } else {
    cached = new LocalLlmRequestLogSource();
    cachedKind = "local";
  }

  return cached;
}

/**
 * Drop the cached source so the next `getLlmRequestLogSource()` call
 * resolves fresh from config. Called on workspace config reload.
 */
export function invalidateLlmRequestLogSourceCache(): void {
  if (cached !== null) {
    log.debug(
      { previousKind: cachedKind },
      "Invalidating LLM request log source cache",
    );
  }
  cached = null;
  cachedKind = null;
}
