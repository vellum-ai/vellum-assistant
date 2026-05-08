/**
 * Resolve the conversation ID by precedence:
 *   1. Explicit value provided in `opts.explicit`
 *   2. `__SKILL_CONTEXT_JSON` env var (set by skill sandbox runner)
 *   3. `__CONVERSATION_ID` env var (set by bash tool subprocess)
 *   4. Throw with the provided `failureHelp` message
 */
export function resolveConversationId(opts: {
  explicit?: string;
  failureHelp: string;
}): string {
  if (opts.explicit) return opts.explicit;

  const contextJson = process.env.__SKILL_CONTEXT_JSON;
  if (contextJson) {
    try {
      const parsed = JSON.parse(contextJson) as Record<string, unknown>;
      if (typeof parsed.conversationId === "string" && parsed.conversationId) {
        return parsed.conversationId;
      }
    } catch {
      // ignore malformed JSON
    }
  }

  const envConvId = process.env.__CONVERSATION_ID;
  if (envConvId && typeof envConvId === "string") return envConvId;

  throw new Error(opts.failureHelp);
}
