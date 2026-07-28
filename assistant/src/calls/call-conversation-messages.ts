/**
 * Persistence + formatting helpers for messages that belong in the
 * dedicated voice conversation.
 */

import { addMessage } from "../persistence/conversation-crud.js";
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

/** The `data` payload rendered by the `call_summary` surface. */
interface CallSummaryEvent {
  eventType: string;
  payloadJson: string;
  createdAt: number;
}

/**
 * Build the `[ui_surface, text]` block pair persisted for a finished call.
 *
 * This is the approval-card pattern (see
 * `notifications/approval-card-builder.ts`). Every provider drops `ui_surface`
 * when serializing history, so the card alone left the model unable to tell
 * that a call happened — the turn reached the wire as a "blocks omitted"
 * sentinel (LUM-2869). The `_surfaceFallback` text sibling carries the same
 * copy for the model, search indexing, CLI display, and channel replies, and
 * its flag keeps surface-capable clients from rendering both the card and a
 * duplicate text line.
 */
function buildCallSummaryBlocks(
  summaryText: string,
  status: string | undefined,
  duration: number | null,
  events: CallSummaryEvent[],
): unknown[] {
  return [
    {
      type: "ui_surface",
      surfaceType: "call_summary",
      surfaceId: crypto.randomUUID(),
      completed: true,
      data: {
        summaryText,
        status: status ?? "completed",
        duration,
        events: events.map((e) => ({
          eventType: e.eventType,
          payloadJson: e.payloadJson,
          createdAt: e.createdAt,
        })),
      },
    },
    {
      type: "text",
      text: summaryText,
      _surfaceFallback: true,
    },
  ];
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
    JSON.stringify(
      buildCallSummaryBlocks(
        summaryText,
        callSession?.status,
        duration,
        events,
      ),
    ),
    {
      metadata: {
        userMessageChannel: "phone",
        assistantMessageChannel: "phone",
        userMessageInterface: "phone",
        assistantMessageInterface: "phone",
      },
    },
  );
  return summaryText;
}
