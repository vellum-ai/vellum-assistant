import { mock } from "bun:test";

import { QueryClient } from "@tanstack/react-query";

import type { StreamHandlerContext } from "@/domains/chat/utils/stream-handlers/types";
import type { TurnActions, TurnState } from "@/stores/turn-store";
import { INITIAL_TURN_STATE } from "@/stores/turn-store";

/** Build a minimal mock StreamHandlerContext with spies on every callback. */
export function makeCtx(
  overrides: Partial<StreamHandlerContext> = {},
): StreamHandlerContext {
  return {
    router: { push: mock(() => {}) },
    isNative: false,
    streamContextRef: {
      current: { assistantId: "ast-1", conversationId: "conv-1" },
    },
    assistantIdRef: { current: "ast-1" },
    setMessages: mock(() => {}),
    messagesRef: { current: [] },
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
    streamRef: { current: { cancel: mock(() => {}) } as never },
    cancelReconciliation: mock(() => {}),
    startReconciliationLoop: mock(() => {}),
    confirmationToolCallMapRef: { current: new Map() },
    setAssetsRefreshKey: mock(() => {}),
    dismissedSurfaceIdsRef: { current: new Set() },
    contextWindowUsageByConversationRef: { current: new Map() },
    setContextWindowUsage: mock(() => {}),
    scheduleConversationListRefetch: mock(() => {}),
    queryClient: new QueryClient(),
    setCompactionCircuitOpenUntil: mock(() => {}),
    applyDiskPressureStatusEvent: mock(() => {}),
    refreshAssistantIdentity: mock(() => Promise.resolve()),
    invalidateAvatar: mock(() => {}),
    pendingQueuedMessageIdsRef: { current: [] },
    requestIdToMessageIdRef: { current: new Map() },
    pendingLocalDeletionsRef: { current: new Set() },
    lastActivityVersionRef: { current: new Map() },
    toolCallIdCounterRef: { current: 0 },
    currentAssistantMessageIdRef: { current: undefined },
    ...overrides,
  };
}
