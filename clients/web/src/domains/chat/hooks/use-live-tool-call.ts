import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";

/**
 * Live tool call looked up by id from the chat-session store, so an OPEN
 * tool-detail drawer reflects streamed `tool_output_chunk` output (and the
 * eventual final `result`) as events land — instead of freezing the snapshot
 * captured when the drawer was opened. The streaming sibling of
 * {@link useLiveThinkingText}.
 *
 * Returns the stored tool-call object, whose reference is stable until that
 * specific call changes (the stream updaters clone only the touched call), so
 * Zustand's `Object.is` comparison re-renders the caller only on a real update
 * to this call — not on unrelated transcript churn. Returns `null` when the
 * call can't be found (e.g. its message paged out of the transcript) so callers
 * fall back to the open-time snapshot.
 */
export function useLiveToolCall(
  toolCallId: string | undefined,
): ChatMessageToolCall | null {
  return useChatSessionStore((s) => {
    if (!toolCallId) return null;
    for (const m of s.messages) {
      const tc = m.toolCalls?.find((t) => t.id === toolCallId);
      if (tc) return tc;
    }
    return null;
  });
}
