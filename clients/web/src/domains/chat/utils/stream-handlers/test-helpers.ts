import { mock } from "bun:test";

import { QueryClient } from "@tanstack/react-query";

import type { StreamHandlerContext } from "@/domains/chat/utils/stream-handlers/types";
import type { TurnActions, TurnState } from "@/domains/chat/turn-store";
import { INITIAL_TURN_STATE } from "@/domains/chat/turn-store";

interface MakeCtxOptions {
  pendingQueuedMessageIds?: string[];
  requestIdToMessageId?: Map<string, string>;
  pendingLocalDeletions?: Set<string>;
  dismissedSurfaceIds?: Set<string>;
}

/** Build a minimal mock StreamHandlerContext with spies on every callback. */
export function makeCtx(
  overrides: Partial<StreamHandlerContext> & MakeCtxOptions = {},
): StreamHandlerContext {
  // Backing state for queue management actions — allows tests to seed
  // initial state and verify outcomes without direct mutation.
  const queueState = {
    pendingQueuedMessageIds: overrides.pendingQueuedMessageIds ?? [],
    requestIdToMessageId:
      overrides.requestIdToMessageId ?? new Map<string, string>(),
    pendingLocalDeletions: overrides.pendingLocalDeletions ?? new Set<string>(),
    dismissedSurfaceIds: overrides.dismissedSurfaceIds ?? new Set<string>(),
  };

  const {
    pendingQueuedMessageIds: _pq,
    requestIdToMessageId: _rm,
    pendingLocalDeletions: _pd,
    dismissedSurfaceIds: _ds,
    ...restOverrides
  } = overrides;

  return {
    router: { push: mock(() => {}) },
    isNative: false,
    streamContext: { assistantId: "ast-1", conversationId: "conv-1" },
    assistantId: "ast-1",
    setOptimisticSends: mock(() => {}),
    turnActions: {
      requestSend: mock(() => {}),
      acceptSend: mock(() => {}),
      onTextDelta: mock(() => {}),
      onToolUseStart: mock(() => {}),
      onToolResult: mock(() => {}),
      onToolActivityMetadata: mock(() => {}),
      onActivityThinking: mock(() => {}),
      showSurface: mock(() => {}),
      updateSurface: mock(() => {}),
      dismissSurface: mock(() => {}),
      completeSurface: mock(() => {}),
      onSecretRequest: mock(() => {}),
      onConfirmationRequest: mock(() => {}),
      onQuestionRequest: mock(() => {}),
      onContactRequest: mock(() => {}),
      completeTurn: mock(() => {}),
      handoffGeneration: mock(() => {}),
      cancelGeneration: mock(() => {}),
      onStreamError: mock(() => {}),
      onSessionError: mock(() => {}),
      onPollReconciled: mock(() => {}),
      onTurnTimeout: mock(() => {}),
      resetTurn: mock(() => {}),
      enqueueMessage: mock(() => {}),
      dequeueMessage: mock(() => {}),
      deleteQueuedMessage: mock(() => {}),
    } satisfies TurnActions,
    getTurnState: () => ({ ...INITIAL_TURN_STATE }) as TurnState,
    endTurn: mock(() => {}),
    setError: mock(() => {}),
    setNotice: mock(() => {}),
    cancelAndClearStream: mock(() => {}),
    cancelReconciliation: mock(() => {}),
    startReconciliationLoop: mock(() => {}),
    setConfirmationToolCall: mock(() => {}),
    setAssetsRefreshKey: mock(() => {}),
    addDismissedSurfaceId: mock((surfaceId: string) => {
      queueState.dismissedSurfaceIds.add(surfaceId);
    }),
    setContextWindowUsageForConversation: mock(() => {}),
    setContextWindowUsage: mock(() => {}),
    queryClient: new QueryClient(),
    setCompactionCircuitOpenUntil: mock(() => {}),
    shiftPendingQueuedMessageId: mock(() => {
      return queueState.pendingQueuedMessageIds.shift();
    }),
    setRequestIdMapping: mock((requestId: string, messageId: string) => {
      queueState.requestIdToMessageId.set(requestId, messageId);
    }),
    popRequestIdMapping: mock((requestId: string) => {
      const value = queueState.requestIdToMessageId.get(requestId);
      if (value !== undefined) {
        queueState.requestIdToMessageId.delete(requestId);
      }
      return value;
    }),
    consumePendingLocalDeletion: mock((messageId: string) => {
      if (!queueState.pendingLocalDeletions.has(messageId)) return false;
      queueState.pendingLocalDeletions.delete(messageId);
      return true;
    }),
    lastActivityVersionRef: { current: new Map() },
    currentAssistantMessageIdRef: { current: undefined },
    ...restOverrides,
  };
}
