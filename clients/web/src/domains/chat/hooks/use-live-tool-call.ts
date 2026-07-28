import { useMemo } from "react";

import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import { useTranscriptMessages } from "@/domains/chat/transcript/use-transcript-messages";

/**
 * Tool call looked up by id from the rendered transcript (server history ⊕ the
 * in-flight turn), so an OPEN tool-detail drawer reflects streamed
 * `tool_output_chunk` output (and the eventual final `result`) as events land
 * AND keeps the final result after the turn commits — instead of freezing the
 * snapshot captured when the drawer was opened. The sibling of
 * {@link useLiveThinkingText}.
 *
 * Resolving against the transcript union rather than the live turn alone is
 * load-bearing: the live-turn→history handoff drops the committed row from the
 * live turn the moment the turn finishes, so a live-turn-only lookup would lose
 * the call and the drawer would fall back to the stale open-time snapshot. The
 * committed call lives on the history row, which the union carries.
 *
 * Returns `null` when the call can't be found (e.g. its message paged out of the
 * loaded transcript) so callers fall back to the open-time snapshot.
 */
export function useLiveToolCall(
  toolCallId: string | undefined,
): ChatMessageToolCall | null {
  const messages = useTranscriptMessages();
  return useMemo(() => {
    if (!toolCallId) return null;
    for (const m of messages) {
      const tc = m.toolCalls?.find((t) => t.id === toolCallId);
      if (tc) return tc;
    }
    return null;
  }, [messages, toolCallId]);
}
