import {
  type SubagentEventEvent,
  type SubagentSpawnedEvent,
  type SubagentStatusChangedEvent,
  UsageProgressEventSchema,
} from "@vellumai/assistant-api";

import {
  requestSubagentReconcile,
  useSubagentStore,
} from "@/domains/chat/subagent-store";
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
    parentConversationId: event.parentConversationId,
    parentMessageStableId: ctx.currentAssistantMessageIdRef.current,
    parentToolUseId: event.parentToolUseId,
  });
}

export function handleSubagentStatusChanged(
  event: SubagentStatusChangedEvent,
  _ctx: StreamHandlerContext,
): void {
  const store = useSubagentStore.getState();
  // Evidence of a subagent the store has never seen: its `subagent_spawned`
  // was missed (SSE gap, page reload) or the store was reset after it
  // arrived. Materialize a stub so the status lands instead of silently
  // vanishing — a dropped terminal status is how the inline card dies (the
  // avatar row expands to nothing and the detail panel can't open). The event
  // carries no conversation ids at all, so `ensureEntry` scopes the stub to
  // the conversation on screen. The reconcile kick then recovers the real
  // identity, and any sibling subagent that streamed nothing at all, a
  // round-trip later.
  if (!store.byId[event.subagentId]) {
    store.ensureEntry({
      subagentId: event.subagentId,
      timestamp: Date.now(),
      status: event.status,
    });
    requestSubagentReconcile();
  }
  store.changeStatus({
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
  const inner = event.event;

  // The envelope's `conversationId` is the PARENT conversation (stamped by
  // `wrappedSendToClient` in `assistant/src/subagent/manager.ts`); the
  // subagent's own id rides on the inner event, where
  // `SubagentInnerEventSchema`'s passthrough preserves it without declaring it
  // on the inferred type: hence the narrow cast.
  const parentConversationId = event.conversationId || undefined;
  const innerConversationId = (inner as { conversationId?: string })
    .conversationId;
  const childConversationId =
    typeof innerConversationId === "string" &&
    innerConversationId.length > 0 &&
    innerConversationId !== parentConversationId
      ? innerConversationId
      : undefined;

  // Same recovery as `handleSubagentStatusChanged`: an unknown id means the
  // spawn event was missed, so materialize a stub. `ensureEntry` decides from
  // the ids at hand whether the detail backfill can be armed.
  if (store.byId[event.subagentId]) {
    if (parentConversationId) {
      store.setParentConversationId(event.subagentId, parentConversationId);
    }
    if (childConversationId) {
      store.setConversationId(event.subagentId, childConversationId);
    }
  } else {
    store.ensureEntry({
      subagentId: event.subagentId,
      timestamp: Date.now(),
      conversationId: childConversationId,
      parentConversationId,
    });
    // Reconcile the envelope's OWN parent: this event may belong to a
    // background conversation, whose subagents the active chat's snapshot
    // would say nothing about.
    requestSubagentReconcile(parentConversationId);
  }

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
