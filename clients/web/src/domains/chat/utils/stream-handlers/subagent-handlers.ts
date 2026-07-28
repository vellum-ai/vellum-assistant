import {
  type SubagentEventEvent,
  type SubagentSpawnedEvent,
  type SubagentStatusChangedEvent,
  UsageProgressEventSchema,
} from "@vellumai/assistant-api";

import { useSubagentStore } from "@/domains/chat/subagent-store";
import { supportsSubagentRecovery } from "@/lib/backwards-compat/subagent-recovery";
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
  const store = useSubagentStore.getState();
  // Evidence of a subagent the store has never seen: its `subagent_spawned`
  // was missed (SSE gap, page reload) or the store was reset after it
  // arrived. Materialize a stub so the status lands instead of silently
  // vanishing — a dropped terminal status is how the inline card dies (the
  // avatar row expands to nothing and the detail panel can't open).
  if (!store.byId[event.subagentId]) {
    store.ensureEntry({
      subagentId: event.subagentId,
      timestamp: Date.now(),
      status: event.status,
    });
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
  // Same recovery as `handleSubagentStatusChanged`: an unknown id means the
  // spawn event was missed, so materialize a stub. `event.conversationId` is
  // the PARENT conversation id — only pass it (arming the detail backfill)
  // when the daemon resolves the subagent's own conversation itself; an
  // older daemon would parse the parent's messages as the subagent's.
  const wasKnown = Boolean(store.byId[event.subagentId]);
  // Runs even for known entries: `ensureEntry` also arms an existing bare
  // stub (created by a conversationId-less `subagent_status_changed`) for
  // detail backfill the moment an event supplies the conversation id.
  store.ensureEntry({
    subagentId: event.subagentId,
    timestamp: Date.now(),
    conversationId: supportsSubagentRecovery()
      ? event.conversationId
      : undefined,
  });
  // Don't stamp the parent conversation id onto a stub on a pre-0.10.13
  // daemon: it would arm the detail auto-fetch with an id the old daemon
  // trusts verbatim, backfilling the PARENT conversation's messages as the
  // subagent's. Known entries keep the historical behavior.
  if (event.conversationId && (wasKnown || supportsSubagentRecovery())) {
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
