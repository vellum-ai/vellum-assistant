import { mock } from "bun:test";

import type { StreamHandlerContext } from "@/domains/chat/utils/stream-handlers/types.js";
import type { TurnActions, TurnState } from "@/domains/messaging/turn-store.js";
import { INITIAL_TURN_STATE } from "@/domains/messaging/turn-store.js";

/** Build a minimal mock StreamHandlerContext with spies on every callback. */
export function makeCtx(
  overrides: Partial<StreamHandlerContext> = {},
): StreamHandlerContext {
  return {
    router: { push: mock(() => {}) },
    isNative: false,
    streamContextRef: {
      current: { assistantId: "ast-1", conversationKey: "conv-1" },
    },
    activeConversationKeyRef: { current: "conv-1" },
    assistantIdRef: { current: "ast-1" },
    setMessages: mock(() => {}),
    messagesRef: { current: [] },
    needsNewBubbleRef: { current: false },
    turnActions: {
      requestSend: mock(() => {}),
      acceptSend: mock(() => {}),
      onTextDelta: mock(() => {}),
      onToolUseStart: mock(() => {}),
      onToolResult: mock(() => {}),
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
    clearProcessingKey: mock(() => {}),
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
    dispatchConversationList: mock(() => {}),
    setCompactionCircuitOpenUntil: mock(() => {}),
    applyDiskPressureStatusEvent: mock(() => {}),
    refreshAssistantIdentity: mock(() => Promise.resolve()),
    invalidateAvatar: mock(() => {}),
    pendingQueuedStableIdsRef: { current: [] },
    requestIdToStableIdRef: { current: new Map() },
    pendingLocalDeletionsRef: { current: new Set() },
    lastActivityVersionRef: { current: new Map() },
    toolCallIdCounterRef: { current: 0 },
    currentAssistantStableIdRef: { current: undefined },
    ...overrides,
  };
}
