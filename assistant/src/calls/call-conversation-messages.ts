/**
 * Persistence + formatting helpers for messages that belong in the
 * dedicated voice conversation.
 */

import { addMessage } from "../memory/conversation-crud.js";
import { getCallEvents, getCallSession } from "./call-store.js";

export function buildCallCompletionMessage(callSessionId: string): string {
  const callSession = getCallSession(callSessionId);
  const events = getCallEvents(callSessionId);
  const duration =
    callSession?.endedAt && callSession?.startedAt
      ? Math.round((callSession.endedAt - callSession.startedAt) / 1000)
      : null;
  const durationStr = duration != null ? ` (${duration}s)` : "";
  const statusLabel =
    callSession?.status === "failed"
      ? "Call failed"
      : callSession?.status === "cancelled"
        ? "Call cancelled"
        : "Call completed";
  return `**${statusLabel}**${durationStr}. ${events.length} event(s) recorded.`;
}

export async function persistCallCompletionMessage(
  conversationId: string,
  callSessionId: string,
): Promise<string> {
  const summaryText = buildCallCompletionMessage(callSessionId);
  await addMessage(
    conversationId,
    "assistant",
    JSON.stringify([{ type: "text", text: summaryText }]),
    {
      userMessageChannel: "phone",
      assistantMessageChannel: "phone",
      userMessageInterface: "phone",
      assistantMessageInterface: "phone",
    },
  );
  return summaryText;
}
