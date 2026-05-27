import { useSubagentStore } from "@/domains/subagents/subagent-store";
import type { StreamHandlerContext } from "@/domains/chat/utils/stream-handlers/types";
import type { SubagentSpawnedEvent, SubagentStatusChangedEvent, SubagentEventWrapperEvent } from "@/domains/chat/api/event-types";

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

  const inner = event.event;
  if (inner.type === "usage_progress") {
    const data = inner as unknown as Record<string, unknown>;
    const inputTokens =
      typeof data.inputTokens === "number" ? data.inputTokens : 0;
    const outputTokens =
      typeof data.outputTokens === "number" ? data.outputTokens : 0;
    const estimatedCost =
      typeof data.estimatedCost === "number" ? data.estimatedCost : 0;
    store.updateUsage({
      subagentId: event.subagentId,
      inputTokens,
      outputTokens,
      estimatedCost,
    });
    return;
  }

  store.receiveEvent({
    subagentId: event.subagentId,
    event: inner,
    timestamp: Date.now(),
  });
}
