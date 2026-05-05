/**
 * Persistence + formatting helpers for messages that belong in the
 * dedicated voice conversation.
 */

import { addMessage } from "../memory/conversation-crud.js";
import { getCallEvents, getCallSession } from "./call-store.js";

function buildCallSummaryLabel(
  status: string | undefined,
  duration: number | null,
  eventCount: number,
): string {
  const statusLabel =
    status === "failed"
      ? "Call failed"
      : status === "cancelled"
        ? "Call cancelled"
        : "Call completed";
  const durationStr = duration != null ? ` (${duration}s)` : "";
  return `**${statusLabel}**${durationStr}. ${eventCount} event(s) recorded.`;
}

export function buildCallCompletionMessage(callSessionId: string): string {
  const callSession = getCallSession(callSessionId);
  const events = getCallEvents(callSessionId);
  const duration =
    callSession?.endedAt && callSession?.startedAt
      ? Math.round((callSession.endedAt - callSession.startedAt) / 1000)
      : null;
  return buildCallSummaryLabel(callSession?.status, duration, events.length);
}

export async function persistCallCompletionMessage(
  conversationId: string,
  callSessionId: string,
): Promise<string> {
  const callSession = getCallSession(callSessionId);
  const events = getCallEvents(callSessionId);
  const duration =
    callSession?.endedAt && callSession?.startedAt
      ? Math.round((callSession.endedAt - callSession.startedAt) / 1000)
      : null;
  const summaryText = buildCallSummaryLabel(
    callSession?.status,
    duration,
    events.length,
  );

  await addMessage(
    conversationId,
    "assistant",
    JSON.stringify([
      {
        type: "ui_surface",
        surfaceType: "call_summary",
        surfaceId: crypto.randomUUID(),
        completed: true,
        data: {
          summaryText,
          status: callSession?.status ?? "completed",
          duration,
          events: events.map((e) => ({
            eventType: e.eventType,
            payloadJson: e.payloadJson,
            createdAt: e.createdAt,
          })),
        },
      },
    ]),
    {
      userMessageChannel: "phone",
      assistantMessageChannel: "phone",
      userMessageInterface: "phone",
      assistantMessageInterface: "phone",
    },
  );
  return summaryText;
}
