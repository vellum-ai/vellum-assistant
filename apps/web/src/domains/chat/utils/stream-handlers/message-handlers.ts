import { toDisplayAttachments } from "@/domains/chat/lib/api.js";
import type {
  AssistantActivityStateEvent,
  AssistantTextDeltaEvent,
  GenerationCancelledEvent,
  GenerationHandoffEvent,
  MessageCompleteEvent,
} from "@/domains/chat/lib/api.js";
import { recordChatDiagnostic } from "@/domains/chat/lib/diagnostics.js";
import { newStableId } from "@/domains/chat/lib/stable-id.js";
import {
  appendTextDelta,
  createStreamingBubble,
  finalizeMessageComplete,
  finalizeOnIdle,
  stopStreaming,
} from "@/domains/chat/hooks/stream-message-updaters.js";
import type { StreamHandlerContext } from "@/domains/chat/utils/stream-handlers/types.js";

export function handleAssistantTextDelta(
  event: AssistantTextDeltaEvent,
  ctx: StreamHandlerContext,
): void {
  ctx.cancelReconciliation();
  ctx.dispatchTurn({ type: "ASSISTANT_TEXT_DELTA" });
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
  const convKey =
    event.conversationKey ?? ctx.streamContextRef.current?.conversationKey;

  if (convKey) {
    const lastSeen =
      ctx.lastActivityVersionRef.current.get(convKey) ?? 0;
    if (event.activityVersion <= lastSeen) {
      recordChatDiagnostic("sse_activity_state_version_skipped", {
        convKey,
        phase: event.phase,
        eventVersion: event.activityVersion,
        lastSeenVersion: lastSeen,
      });
      return;
    }
    ctx.lastActivityVersionRef.current.set(convKey, event.activityVersion);
  }

  if (event.phase === "thinking") {
    ctx.dispatchTurn({
      type: "ACTIVITY_STATE_THINKING",
      statusText: event.statusText,
    });
    recordChatDiagnostic("sse_activity_state_thinking_handled", {
      convKey,
      reason: event.reason,
      activityVersion: event.activityVersion,
    });
    return;
  }

  if (event.phase !== "idle") {
    recordChatDiagnostic("sse_activity_state_non_idle", {
      convKey,
      phase: event.phase,
      reason: event.reason,
      activityVersion: event.activityVersion,
    });
    return;
  }

  ctx.setMessages(finalizeOnIdle);
  ctx.needsNewBubbleRef.current = true;
  const turnPhaseBefore = ctx.turnStateRef.current.phase;
  ctx.dispatchTurn({ type: "MESSAGE_COMPLETE" });
  if (convKey) {
    ctx.clearProcessingKey(convKey);
  }
  recordChatDiagnostic("sse_activity_state_idle_handled", {
    convKey,
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
  const turnPhaseBefore = ctx.turnStateRef.current.phase;
  ctx.dispatchTurn({ type: "MESSAGE_COMPLETE" });
  const convKey = ctx.streamContextRef.current?.conversationKey;
  if (convKey) {
    ctx.clearProcessingKey(convKey);
  }
  recordChatDiagnostic("sse_message_complete_handled", {
    convKey,
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
  ctx.dispatchTurn({ type: "GENERATION_HANDOFF" });
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
  ctx.dispatchTurn({ type: "GENERATION_CANCELLED" });
  const convKey = ctx.streamContextRef.current?.conversationKey;
  if (convKey) {
    ctx.clearProcessingKey(convKey);
  }
  ctx.setMessages((prev) => stopStreaming(prev));
  ctx.needsNewBubbleRef.current = true;
}
