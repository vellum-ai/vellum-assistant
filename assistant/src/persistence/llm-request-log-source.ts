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
import type { LlmRequestLogSource } from "./llm-request-log-source-types.js";

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
    const { ClickHouseLlmRequestLogSource } =
      await import("./llm-request-log-source-clickhouse.js");
    return new ClickHouseLlmRequestLogSource(cfg.clickhouse);
  }

  const { LocalLlmRequestLogSource } =
    await import("./llm-request-log-source-local.js");
  return new LocalLlmRequestLogSource();
}
