import { recordDiagnostic } from "@/lib/diagnostics";
import {
  appendTextDelta,
  applyUserMessageEcho,
  finalizeMessageComplete,
  finalizeOnIdle,
  stopStreaming,
} from "@/domains/chat/hooks/stream-message-updaters";
import type { StreamHandlerContext } from "@/domains/chat/utils/stream-handlers/types";
import type { AssistantActivityStateEvent } from "@/types/event-types";
import type {
  AssistantTextDeltaEvent,
  AssistantTurnStartEvent,
  GenerationCancelledEvent,
  GenerationHandoffEvent,
  MessageCompleteEvent,
  UserMessageEchoEvent,
} from "@vellumai/assistant-api";
import { useSubagentStore } from "@/domains/chat/subagent-store";


/**
 * Apply an `assistant_turn_start` event.
 *
 * The daemon emits this from event zero of each LLM call in a turn,
 * carrying the `messageId` of the row it `reserveMessage`'d in SQLite.
 * The handler does two things:
 *
 * 1. Stamps `currentAssistantMessageIdRef` with the anchor id. Downstream
 *    deltas in this LLM call carry the same `messageId` and
 *    `appendTextDelta` matches by id — but subagent attribution and any
 *    other consumer that reads the ref before a delta lands sees the
 *    correct anchor immediately.
 *
 * 2. If a row with this id already exists in `messages` — e.g. the
 *    reserved row was pulled in by an in-flight reconcile poll before the
 *    SSE wire delivered this event — flips it to `isStreaming: true`.
 *    That ensures `appendTextDelta` doesn't see a non-streaming assistant
 *    tail and open a duplicate bubble with the same id. No-op when the
 *    row doesn't exist yet (the common case: SSE strictly precedes
 *    reconcile).
 */
export function handleAssistantTurnStart(
  event: AssistantTurnStartEvent,
  ctx: StreamHandlerContext,
): void {
  ctx.currentAssistantMessageIdRef.current = event.messageId;
  ctx.setMessages((prev) => {
    let touched = false;
    const next = prev.map((m) => {
      if (m.role !== "assistant" || m.id !== event.messageId) return m;
      if (m.isStreaming) return m;
      touched = true;
      return { ...m, isStreaming: true };
    });
    return touched ? next : prev;
  });
}

export function handleAssistantTextDelta(
  event: AssistantTextDeltaEvent,
  ctx: StreamHandlerContext,
): void {
  ctx.cancelReconciliation();
  ctx.turnActions.onTextDelta();
  ctx.setMessages((prev) => {
    const next = appendTextDelta(prev, event.text, event.messageId);
    const tail = next[next.length - 1];
    // Stamp the current-assistant ref to the streaming tail. Subagent
    // handlers read this to attribute nested notifications to the right
    // parent bubble.
    if (tail?.role === "assistant" && tail.isStreaming) {
      ctx.currentAssistantMessageIdRef.current = tail.id;
    }
    return next;
  });
}

export function handleAssistantActivityState(
  event: AssistantActivityStateEvent,
  ctx: StreamHandlerContext,
): void {
  const convId =
    event.conversationId ?? ctx.streamContextRef.current?.conversationId;

  if (convId) {
    const lastSeen =
      ctx.lastActivityVersionRef.current.get(convId) ?? 0;
    if (event.activityVersion <= lastSeen) {
      recordDiagnostic("sse_activity_state_version_skipped", {
        convId,
        phase: event.phase,
        eventVersion: event.activityVersion,
        lastSeenVersion: lastSeen,
      });
      return;
    }
    ctx.lastActivityVersionRef.current.set(convId, event.activityVersion);
  }

  if (event.phase === "thinking") {
    ctx.turnActions.onActivityThinking(event.statusText);
    recordDiagnostic("sse_activity_state_thinking_handled", {
      convId,
      reason: event.reason,
      activityVersion: event.activityVersion,
    });
    return;
  }

  if (event.phase !== "idle") {
    recordDiagnostic("sse_activity_state_non_idle", {
      convId,
      phase: event.phase,
      reason: event.reason,
      activityVersion: event.activityVersion,
    });
    return;
  }

  ctx.setMessages(finalizeOnIdle);
  const turnPhaseBefore = ctx.getTurnState().phase;
  ctx.endTurn({ conversationId: convId, reason: "complete" });
  recordDiagnostic("sse_activity_state_idle_handled", {
    convId,
    reason: event.reason,
    activityVersion: event.activityVersion,
    turnPhaseBefore,
  });
}

export function handleMessageComplete(
  event: MessageCompleteEvent,
  ctx: StreamHandlerContext,
): void {
  ctx.setMessages((prev) => finalizeMessageComplete(prev, event));

  // Re-anchor subagents spawned in this turn from the optimistic streaming
  // bubble id (`currentAssistantMessageIdRef`, the same id used as
  // `parentMessageStableId` at spawn time) onto the durable server
  // `messageId`, which survives reconcile. Multi-LLM-call turns collapse onto
  // the first row's id daemon-side; the common single-call spawn turn is
  // unaffected because entries are indexed under both ids in `byParent`.
  const stableId = ctx.currentAssistantMessageIdRef.current;
  if (event.messageId && stableId) {
    useSubagentStore
      .getState()
      .reanchorToMessage({ stableId, messageId: event.messageId });
  }

  // Prefer the event's own `conversationId` over `streamContextRef`.
  // The event carries the canonical id; the ref is a mirror that may be
  // cleared by a stream teardown that races the terminal event. All
  // three terminal handlers (`handleAssistantActivityState(idle)`,
  // `handleMessageComplete`, `handleGenerationCancelled`) use this same
  // fallback chain so the processing-key clear stays reliable across
  // reconnects.
  const convId =
    event.conversationId ?? ctx.streamContextRef.current?.conversationId;
  const turnPhaseBefore = ctx.getTurnState().phase;
  ctx.endTurn({ conversationId: convId, reason: "complete" });
  recordDiagnostic("sse_message_complete_handled", {
    convId,
    turnPhaseBefore,
    messageId: event.messageId,
    hasAttachments: !!event.attachments?.length,
    reanchored: !!(event.messageId && stableId),
  });
}

/**
 * Apply a `user_message_echo` event.
 *
 * Renders the user turn on every client — including passive viewers and
 * synthetic surface-action prompts that never issued the originating POST
 * — and dedupes the originating client's optimistic row. The id/optimistic
 * reconciliation lives in the pure `applyUserMessageEcho` updater.
 */
export function handleUserMessageEcho(
  event: UserMessageEchoEvent,
  ctx: StreamHandlerContext,
): void {
  ctx.setMessages((prev) => applyUserMessageEcho(prev, event));
}

export function handleGenerationHandoff(
  _event: GenerationHandoffEvent,
  ctx: StreamHandlerContext,
): void {
  ctx.cancelReconciliation();
  ctx.turnActions.handoffGeneration();
  ctx.setMessages((prev) => stopStreaming(prev));
}

export function handleGenerationCancelled(
  event: GenerationCancelledEvent,
  ctx: StreamHandlerContext,
): void {
  // See `handleMessageComplete` for the rationale on the event-first
  // fallback chain.
  const convId =
    event.conversationId ?? ctx.streamContextRef.current?.conversationId;
  ctx.endTurn({ conversationId: convId, reason: "cancelled" });
  ctx.setMessages((prev) => stopStreaming(prev));
}
