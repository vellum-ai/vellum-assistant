/**
 * Default LLM request log read source: thin async wrapper around the
 * existing synchronous `llm-request-log-store.ts` functions.
 *
 * Keeps the local read path identical to its pre-pluggable behavior —
 * including turn resolution, orphan/unlinked recovery, opportunistic
 * backfill, and fork-source fallback. The wrapper exists only to satisfy
 * the `LlmRequestLogSource` interface (which is `Promise`-returning so
 * implementations with real I/O can fit).
 */
import type { LlmRequestLogSource } from "./llm-request-log-source-types.js";
import {
  type CompactionAgentLogRow,
  getCompactionLogsBetween,
  getPreviousNonCompactionCallCreatedAt,
  getRequestLogById,
  getRequestLogMetaById,
  getRequestLogsByConversationId,
  getRequestLogsByMessageId,
  type LogMetaRow,
  type LogRow,
} from "./llm-request-log-store.js";

export class LocalLlmRequestLogSource implements LlmRequestLogSource {
  async getRequestLogById(logId: string): Promise<LogRow | null> {
    return getRequestLogById(logId);
  }

  async getRequestLogMetaById(logId: string): Promise<LogMetaRow | null> {
    return getRequestLogMetaById(logId);
  }

  async getRequestLogsByMessageId(messageId: string): Promise<LogRow[]> {
    return getRequestLogsByMessageId(messageId);
  }

  async getRequestLogsByConversationId(
    conversationId: string,
  ): Promise<LogRow[]> {
    return getRequestLogsByConversationId(conversationId);
  }

  async getPreviousNonCompactionCallCreatedAt(
    conversationId: string,
    beforeCreatedAt: number,
  ): Promise<number | null> {
    return getPreviousNonCompactionCallCreatedAt(
      conversationId,
      beforeCreatedAt,
    );
  }

  async getCompactionLogsBetween(
    conversationId: string,
    afterCreatedAt: number | null,
    beforeCreatedAt: number,
  ): Promise<CompactionAgentLogRow[]> {
    return getCompactionLogsBetween(
      conversationId,
      afterCreatedAt,
      beforeCreatedAt,
    );
  }
}
