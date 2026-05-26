import { useSubagentStore } from "@/domains/subagents/subagent-store.js";
import type { StreamHandlerContext } from "@/domains/chat/utils/stream-handlers/types.js";
import type { SubagentSpawnedEvent, SubagentStatusChangedEvent, SubagentEventWrapperEvent } from "@/domains/chat/api/event-types.js";

export function handleSubagentSpawned(
  event: SubagentSpawnedEvent,
  ctx: StreamHandlerContext,
): void {
  useSubagentStore.getState().spawnSubagent({
    subagentId: event.subagentId,
    label: event.label,
    objective: event.objective,
    isFork: event.isFork,
    timestamp: Date.now(),
    parentMessageStableId: ctx.currentAssistantMessageIdRef.current,
  });
}

export function handleSubagentStatusChanged(
  event: SubagentStatusChangedEvent,
  _ctx: StreamHandlerContext,
): void {
  useSubagentStore.getState().changeStatus({
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
  _ctx: StreamHandlerContext,
): void {
  const store = useSubagentStore.getState();
  if (event.conversationId) {
    store.setConversationId(event.subagentId, event.conversationId);
  }
  store.receiveEvent({
    subagentId: event.subagentId,
    event: event.event,
    timestamp: Date.now(),
  });
}
