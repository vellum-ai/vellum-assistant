import { mock } from "bun:test";

import { QueryClient } from "@tanstack/react-query";

import type { StreamHandlerContext } from "@/domains/chat/utils/stream-handlers/types";
import type { TurnActions, TurnState } from "@/domains/chat/turn-store";
import { INITIAL_TURN_STATE } from "@/domains/chat/turn-store";
import { useComposerStore } from "@/domains/chat/composer-store";

interface MakeCtxOptions {
  requestIdToMessageId?: Map<string, string>;
  dismissedSurfaceIds?: Set<string>;
}

/** Build a minimal mock StreamHandlerContext with spies on every callback. */
export function makeCtx(
  overrides: Partial<StreamHandlerContext> & MakeCtxOptions = {},
): StreamHandlerContext {
  // Backing state for the map/set actions — allows tests to seed initial
  // state and verify outcomes without direct mutation.
  const backingState = {
    requestIdToMessageId:
      overrides.requestIdToMessageId ?? new Map<string, string>(),
    dismissedSurfaceIds: overrides.dismissedSurfaceIds ?? new Set<string>(),
  };

  const {
    requestIdToMessageId: _rm,
    dismissedSurfaceIds: _ds,
    ...restOverrides
  } = overrides;

  return {
    eventConversationId: "conv-1",
    router: { push: mock(() => {}) },
    isNative: false,
    streamContext: { assistantId: "ast-1", conversationId: "conv-1" },
    assistantId: "ast-1",
    composerSessionGeneration: useComposerStore.getState().sessionGeneration,
    setOptimisticSends: mock(() => {}),
    turnActions: {
      requestSend: mock(() => {}),
      acceptSend: mock(() => {}),
      clearInterruptHandoff: mock(() => {}),
      onTextDelta: mock(() => {}),
      onToolUseStart: mock(() => {}),
      onToolResult: mock(() => {}),
      onToolActivityMetadata: mock(() => {}),
      onActivityThinking: mock(() => {}),
      recoverFromAwaitingUserInput: mock(() => {}),
      showSurface: mock(() => {}),
      updateSurface: mock(() => {}),
      dismissSurface: mock(() => {}),
      completeSurface: mock(() => {}),
      onSecretRequest: mock(() => {}),
      onConfirmationRequest: mock(() => {}),
      onQuestionRequest: mock(() => {}),
      onContactRequest: mock(() => {}),
      completeTurn: mock(() => {}),
      cancelGeneration: mock(() => {}),
      onStreamError: mock(() => {}),
      onSessionError: mock(() => {}),
      onPollReconciled: mock(() => {}),
      onTurnTimeout: mock(() => {}),
      resetTurn: mock(() => {}),
      clearStaleTurn: mock(() => {}),
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
      backingState.dismissedSurfaceIds.add(surfaceId);
    }),
    setContextWindowUsageForConversation: mock(() => {}),
    setContextWindowUsage: mock(() => {}),
    queryClient: new QueryClient(),
    setCompactionCircuitOpenUntil: mock(() => {}),
    popRequestIdMapping: mock((requestId: string) => {
      const value = backingState.requestIdToMessageId.get(requestId);
      if (value !== undefined) {
        backingState.requestIdToMessageId.delete(requestId);
      }
      return value;
    }),
    lastActivityVersionRef: { current: new Map() },
    lastCompletedToolNameRef: { current: undefined },
    currentAssistantMessageIdRef: { current: undefined },
    ...restOverrides,
  };
}
