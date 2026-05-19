import type {
  SubagentSpawnedEvent,
  SubagentStatusChangedEvent,
  SubagentEventWrapperEvent,
} from "@/domains/chat/lib/api.js";
import type { StreamHandlerContext } from "@/domains/chat/utils/stream-handlers/types.js";

export function handleSubagentSpawned(
  event: SubagentSpawnedEvent,
  ctx: StreamHandlerContext,
): void {
  ctx.dispatchSubagent({
    type: "SUBAGENT_SPAWNED",
    subagentId: event.subagentId,
    label: event.label,
    objective: event.objective,
    isFork: event.isFork,
    timestamp: Date.now(),
    parentMessageStableId: ctx.currentAssistantStableIdRef.current,
  });
}

export function handleSubagentStatusChanged(
  event: SubagentStatusChangedEvent,
  ctx: StreamHandlerContext,
): void {
  ctx.dispatchSubagent({
    type: "SUBAGENT_STATUS_CHANGED",
    subagentId: event.subagentId,
    status: event.status,
    error: event.error,
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    totalCost: event.totalCost,
  });
}

export function handleSubagentEvent(
  event: SubagentEventWrapperEvent,
  ctx: StreamHandlerContext,
): void {
  if (event.conversationId) {
    ctx.dispatchSubagent({
      type: "SUBAGENT_CONVERSATION_ID_SET",
      subagentId: event.subagentId,
      conversationId: event.conversationId,
    });
  }
  ctx.dispatchSubagent({
    type: "SUBAGENT_EVENT_RECEIVED",
    subagentId: event.subagentId,
    event: event.event,
    timestamp: Date.now(),
  });
}
