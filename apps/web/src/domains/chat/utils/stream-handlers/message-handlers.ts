import { recordChatDiagnostic } from "@/domains/chat/utils/diagnostics.js";
import { newStableId } from "@/domains/chat/utils/stable-id.js";
import {
  appendTextDelta,
  createStreamingBubble,
  finalizeMessageComplete,
  finalizeOnIdle,
  stopStreaming,
} from "@/domains/chat/hooks/stream-message-updaters.js";
import type { StreamHandlerContext } from "@/domains/chat/utils/stream-handlers/types.js";
import { toDisplayAttachments } from "@/domains/chat/api/event-parser.js";
import type { AssistantActivityStateEvent, AssistantTextDeltaEvent, GenerationCancelledEvent, GenerationHandoffEvent, MessageCompleteEvent } from "@/domains/chat/api/event-types.js";

export function handleAssistantTextDelta(
  event: AssistantTextDeltaEvent,
  ctx: StreamHandlerContext,
): void {
  ctx.cancelReconciliation();
  ctx.turnActions.onTextDelta();
  if (ctx.needsNewBubbleRef.current) {
    ctx.needsNewBubbleRef.current = false;
    const stableId = newStableId("assistant-stream");
    ctx.currentAssistantStableIdRef.current = stableId;
    ctx.setMessages((prev) =>
      createStreamingBubble(prev, event.text, event.messageId, stableId),
    );
  } else {
    ctx.setMessages((prev) =>
      appendTextDelta(prev, event.text, event.messageId),
    );
  }
}

export function handleAssistantActivityState(
  event: AssistantActivityStateEvent,
  epoch: number,
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
  ctx.needsNewBubbleRef.current = true;
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
  ctx.startReconciliationLoop(epoch);
}

export function handleMessageComplete(
  event: MessageCompleteEvent,
  epoch: number,
  ctx: StreamHandlerContext,
): void {
  const completedAttachments = toDisplayAttachments(event.attachments);
  const rowMessageId = event.messageId;
  const displayMessageId = event.displayMessageId ?? event.messageId;
  ctx.setMessages((prev) =>
    finalizeMessageComplete(prev, {
      content: event.content,
      rowMessageId,
      displayMessageId,
      attachments: completedAttachments,
    }),
  );
  ctx.needsNewBubbleRef.current = true;
  const turnPhaseBefore = ctx.getTurnState().phase;
  ctx.turnActions.completeTurn();
  const convId = ctx.streamContextRef.current?.conversationId;
  if (convId) {
    ctx.clearProcessingKey(convId);
  }
  recordChatDiagnostic("sse_message_complete_handled", {
    convId,
    turnPhaseBefore,
    displayMessageId,
    hasContent: !!event.content,
    hasAttachments: !!completedAttachments,
  });
  ctx.startReconciliationLoop(epoch);
}

export function handleGenerationHandoff(
  event: GenerationHandoffEvent,
  ctx: StreamHandlerContext,
): void {
  ctx.cancelReconciliation();
  ctx.turnActions.handoffGeneration();
  const displayMessageId = event.displayMessageId ?? event.messageId;
  ctx.setMessages((prev) =>
    stopStreaming(prev, {
      displayMessageId,
      rowMessageId: event.messageId,
    }),
  );
  ctx.needsNewBubbleRef.current = true;
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
  ctx.needsNewBubbleRef.current = true;
}
