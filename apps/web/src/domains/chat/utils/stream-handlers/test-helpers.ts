import { mock } from "bun:test";

import { QueryClient } from "@tanstack/react-query";

import type { StreamHandlerContext } from "@/domains/chat/utils/stream-handlers/types";
import type { TurnActions, TurnState } from "@/domains/chat/turn-store";
import { INITIAL_TURN_STATE } from "@/domains/chat/turn-store";

/** Build a minimal mock StreamHandlerContext with spies on every callback. */
export function makeCtx(
  overrides: Partial<StreamHandlerContext> = {},
): StreamHandlerContext {
  return {
    router: { push: mock(() => {}) },
    isNative: false,
    streamContext: { assistantId: "ast-1", conversationId: "conv-1" },
    assistantId: "ast-1",
    setMessages: mock(() => {}),
    messages: [],
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
      onProfileAutoRouted: mock(() => {}),
      enqueueMessage: mock(() => {}),
      dequeueMessage: mock(() => {}),
      deleteQueuedMessage: mock(() => {}),
    } satisfies TurnActions,
    getTurnState: () => ({ ...INITIAL_TURN_STATE }) as TurnState,
    endTurn: mock(() => {}),
    setError: mock(() => {}),
    cancelAndClearStream: mock(() => {}),
    cancelReconciliation: mock(() => {}),
    startReconciliationLoop: mock(() => {}),
    setAssetsRefreshKey: mock(() => {}),
    dismissedSurfaceIds: new Set(),
    contextWindowUsageByConversation: new Map(),
    setContextWindowUsage: mock(() => {}),
    scheduleConversationListRefetch: mock(() => {}),
    queryClient: new QueryClient(),
    setCompactionCircuitOpenUntil: mock(() => {}),
    pendingQueuedMessageIds: [],
    requestIdToMessageId: new Map(),
    pendingLocalDeletions: new Set(),
    lastActivityVersionRef: { current: new Map() },
    toolCallIdCounterRef: { current: 0 },
    currentAssistantMessageIdRef: { current: undefined },
    ...overrides,
  };
}
