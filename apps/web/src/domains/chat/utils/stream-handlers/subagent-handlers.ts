import {
  type SubagentEventEvent,
  type SubagentSpawnedEvent,
  type SubagentStatusChangedEvent,
  UsageProgressEventSchema,
} from "@vellumai/assistant-api";

import { useSubagentStore } from "@/domains/chat/subagent-store";
import type { StreamHandlerContext } from "@/domains/chat/utils/stream-handlers/types";

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
    parentToolUseId: event.parentToolUseId,
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
    inputTokens: event.usage?.inputTokens,
    outputTokens: event.usage?.outputTokens,
    totalCost: event.usage?.estimatedCost,
  });
}

export function handleSubagentEvent(
  event: SubagentEventEvent,
  _ctx: StreamHandlerContext,
): void {
  const store = useSubagentStore.getState();
  if (event.conversationId) {
    store.setConversationId(event.subagentId, event.conversationId);
  }

  const inner = event.event;
  if (inner.type === "usage_progress") {
    const parsed = UsageProgressEventSchema.safeParse(inner);
    store.updateUsage({
      subagentId: event.subagentId,
      inputTokens: parsed.success ? parsed.data.inputTokens : 0,
      outputTokens: parsed.success ? parsed.data.outputTokens : 0,
      estimatedCost: parsed.success ? parsed.data.estimatedCost : 0,
    });
    return;
  }

  store.receiveEvent({
    subagentId: event.subagentId,
    event: inner,
    timestamp: Date.now(),
  });
}
