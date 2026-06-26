import type {
  AcpSessionSpawnedEvent,
  AcpSessionUpdateEvent,
  AcpSessionUsageEvent,
  AcpSessionCompletedEvent,
  AcpSessionErrorEvent,
} from "@vellumai/assistant-api";

import { useAcpRunStore } from "@/domains/chat/acp-run-store";

export function handleAcpSessionSpawned(event: AcpSessionSpawnedEvent): void {
  useAcpRunStore.getState().spawnRun({
    acpSessionId: event.acpSessionId,
    agent: event.agent,
    parentConversationId: event.parentConversationId,
    parentToolUseId: event.parentToolUseId,
    task: event.task,
    startedAt: Date.now(),
  });
}

export function handleAcpSessionUpdate(event: AcpSessionUpdateEvent): void {
  const store = useAcpRunStore.getState();
  // Drop replayed events on reconnection: anything at or below the mark.
  const hwm = store.highWaterMark.get(event.acpSessionId);
  const seq = event.seq ?? Date.now();
  if (seq <= (hwm ?? -1)) return;

  store.receiveEvent({
    acpSessionId: event.acpSessionId,
    event: {
      seq,
      updateType: event.updateType,
      content: event.content,
      toolCallId: event.toolCallId,
      toolTitle: event.toolTitle,
      toolKind: event.toolKind,
      toolStatus: event.toolStatus,
      // Tool-call locations[]; absent on older daemons.
      locations: event.locations,
      messageId: event.messageId,
    },
  });
}

export function handleAcpSessionUsage(event: AcpSessionUsageEvent): void {
  useAcpRunStore.getState().updateUsage({
    acpSessionId: event.acpSessionId,
    usedTokens: event.usedTokens,
    contextSize: event.contextSize,
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    costAmount: event.costAmount,
    costCurrency: event.costCurrency,
  });
}

export function handleAcpSessionCompleted(
  event: AcpSessionCompletedEvent,
): void {
  useAcpRunStore.getState().setTerminal({
    acpSessionId: event.acpSessionId,
    status: "completed",
    stopReason: event.stopReason,
    completedAt: Date.now(),
  });
}

export function handleAcpSessionError(event: AcpSessionErrorEvent): void {
  const store = useAcpRunStore.getState();
  // The daemon's cancel path rejects the in-flight prompt and emits
  // acp_session_error even though it persists the run as `cancelled`. Mirror
  // the daemon: a run already marked cancelled (by the Stop action) is not
  // regressed to `failed`.
  if (store.byId[event.acpSessionId]?.status === "cancelled") return;
  store.setTerminal({
    acpSessionId: event.acpSessionId,
    status: "failed",
    error: event.error,
    completedAt: Date.now(),
  });
}
