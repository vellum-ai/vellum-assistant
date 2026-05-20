/**
 * Resolve the conversation ID by precedence:
 *   1. Explicit value provided in `opts.explicit`
 *   2. `__SKILL_CONTEXT_JSON` env var (set by skill sandbox runner)
 *   3. `__CONVERSATION_ID` env var (set by bash tool subprocess)
 *   4. `undefined`
 */
export function tryResolveConversationId(
  opts: { explicit?: string } = {},
): string | undefined {
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

  return undefined;
}

/**
 * Same precedence as `tryResolveConversationId` but throws with the
 * provided `failureHelp` when no source produces a value.
 */
export function resolveConversationId(opts: {
  explicit?: string;
  failureHelp: string;
}): string {
  const resolved = tryResolveConversationId({ explicit: opts.explicit });
  if (resolved) return resolved;
  throw new Error(opts.failureHelp);
}
