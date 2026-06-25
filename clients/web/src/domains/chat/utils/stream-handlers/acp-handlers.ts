import type {
  AcpSessionSpawnedEvent,
  AcpSessionUpdateEvent,
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
      messageId: event.messageId,
    },
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
  useAcpRunStore.getState().setTerminal({
    acpSessionId: event.acpSessionId,
    status: "failed",
    error: event.error,
    completedAt: Date.now(),
  });
}
