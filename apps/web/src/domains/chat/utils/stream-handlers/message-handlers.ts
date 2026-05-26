import { recordChatDiagnostic } from "@/domains/chat/utils/diagnostics.js";
import {
  appendTextDelta,
  finalizeMessageComplete,
  finalizeOnIdle,
  stopStreaming,
} from "@/domains/chat/hooks/stream-message-updaters.js";
import type { StreamHandlerContext } from "@/domains/chat/utils/stream-handlers/types.js";
import type { AssistantActivityStateEvent, AssistantTextDeltaEvent, GenerationCancelledEvent, GenerationHandoffEvent, MessageCompleteEvent } from "@/domains/chat/api/event-types.js";

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
      recordChatDiagnostic("sse_activity_state_version_skipped", {
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
    recordChatDiagnostic("sse_activity_state_thinking_handled", {
      convId,
      reason: event.reason,
      activityVersion: event.activityVersion,
    });
    return;
  }

  if (event.phase !== "idle") {
    recordChatDiagnostic("sse_activity_state_non_idle", {
      convId,
      phase: event.phase,
      reason: event.reason,
      activityVersion: event.activityVersion,
    });
    return;
  }

  ctx.setMessages(finalizeOnIdle);
  const turnPhaseBefore = ctx.getTurnState().phase;
  ctx.turnActions.completeTurn();
  if (convId) {
    ctx.clearProcessingKey(convId);
  }
  recordChatDiagnostic("sse_activity_state_idle_handled", {
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
  const turnPhaseBefore = ctx.getTurnState().phase;
  ctx.turnActions.completeTurn();
  const convId = ctx.streamContextRef.current?.conversationId;
  if (convId) {
    ctx.clearProcessingKey(convId);
  }
  recordChatDiagnostic("sse_message_complete_handled", {
    convId,
    turnPhaseBefore,
    messageId: event.messageId,
    hasContent: !!event.content,
    hasAttachments: !!event.attachments?.length,
  });
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
  _event: GenerationCancelledEvent,
  ctx: StreamHandlerContext,
): void {
  ctx.turnActions.cancelGeneration();
  const convId = ctx.streamContextRef.current?.conversationId;
  if (convId) {
    ctx.clearProcessingKey(convId);
  }
  ctx.setMessages((prev) => stopStreaming(prev));
}
