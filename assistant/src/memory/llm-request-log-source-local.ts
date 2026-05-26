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
import type { LlmRequestLogSource } from "./llm-request-log-source.js";
import {
  getCompactionLogsBeforeCall,
  getRequestLogById,
  getRequestLogsByConversationId,
  getRequestLogsByMessageId,
  type LogRow,
} from "./llm-request-log-store.js";

export class LocalLlmRequestLogSource implements LlmRequestLogSource {
  async getRequestLogById(logId: string): Promise<LogRow | null> {
    return getRequestLogById(logId);
  }

  async getRequestLogsByMessageId(messageId: string): Promise<LogRow[]> {
    return getRequestLogsByMessageId(messageId);
  }

  async getRequestLogsByConversationId(
    conversationId: string,
  ): Promise<LogRow[]> {
    return getRequestLogsByConversationId(conversationId);
  }

  async getCompactionLogsBeforeCall(
    conversationId: string,
    beforeCreatedAt: number,
  ): Promise<LogRow[]> {
    return getCompactionLogsBeforeCall(conversationId, beforeCreatedAt);
  }
}
