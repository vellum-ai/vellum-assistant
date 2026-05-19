import { mock } from "bun:test";

import type { StreamHandlerContext } from "@/domains/chat/utils/stream-handlers/types.js";
import type { TurnState } from "@/domains/chat/lib/turn-state-machine.js";

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
    dispatchTurn: mock(() => {}),
    turnStateRef: { current: { phase: "idle" } as TurnState },
    clearProcessingKey: mock(() => {}),
    setError: mock(() => {}),
    streamRef: { current: { cancel: mock(() => {}) } as never },
    cancelReconciliation: mock(() => {}),
    startReconciliationLoop: mock(() => {}),
    dispatchInteraction: mock(() => {}),
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
    dispatchSubagent: mock(() => {}),
    lastActivityVersionRef: { current: new Map() },
    toolCallIdCounterRef: { current: 0 },
    currentAssistantStableIdRef: { current: undefined },
    ...overrides,
  };
}
