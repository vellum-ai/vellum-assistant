
import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useCallback,
  useRef,
} from "react";
import { useQueryClient } from "@tanstack/react-query";

import type { InteractionEvent } from "@/domains/chat/lib/interaction-state-machine.js";
import type { SubagentAction } from "@/domains/chat/lib/subagent-state.js";
import type { ConversationListAction } from "@/domains/chat/lib/conversation-list-state.js";
import type {
  AssistantEvent,
  AssistantSyncChangedEvent,
  ChatEventStream,
} from "@/domains/chat/lib/api.js";
import type { ContextWindowUsage } from "@/domains/chat/components/context-window-indicator.js";
import type { DisplayMessage } from "@/domains/chat/lib/reconcile.js";
import type { DomainEvent, TurnState } from "@/domains/chat/lib/turn-state-machine.js";
import type { DiskPressureStatusEventPayload } from "@/domains/assistant/use-disk-pressure-monitor.js";
import {
  recordChatDiagnostic,
  summarizeAssistantEvent,
} from "@/domains/chat/lib/diagnostics.js";
import { isConversationScopedStreamEvent } from "@/domains/chat/utils/chat-utils.js";
import {
  handleHomeFeedUpdated,
  handleRelationshipStateUpdated,
} from "@/domains/chat/utils/stream-handlers/home-handlers.js";
import {
  handleOpenUrl,
  handleNavigateSettings,
  handleAssistantTextDelta,
  handleAssistantActivityState,
  handleMessageComplete,
  handleGenerationHandoff,
  handleGenerationCancelled,
  handleStreamError,
  handleConversationErrorEvent,
  handleSecretRequest,
  handleConfirmationRequest,
  handleContactRequest,
  handleQuestionRequest,
  handleUISurfaceShow,
  handleUISurfaceUpdate,
  handleUISurfaceDismiss,
  handleUISurfaceComplete,
  handleToolUseStart,
  handleToolResult,
  handleUsageUpdate,
  handleConversationListInvalidated,
  handleConversationTitleUpdated,
  handleNotificationIntent,
  handleCompactionCircuitOpen,
  handleCompactionCircuitClosed,
  handleDiskPressureStatusChanged,
  handleIdentityChanged,
  handleAvatarUpdated,
  handleMessageQueued,
  handleMessageDequeued,
  handleMessageQueuedDeleted,
  handleMessageRequestComplete,
  handleSubagentSpawned,
  handleSubagentStatusChanged,
  handleSubagentEvent,
  type StreamHandlerContext,
  type StreamContext,
} from "@/domains/chat/utils/stream-handlers/index.js";

export type {
  ChatError,
  PendingConfirmationState,
  PendingContactRequestState,
  PendingSecretState,
} from "@/domains/chat/types.js";

import type { ChatError } from "@/domains/chat/types.js";

// ---------------------------------------------------------------------------
// Params & return types
// ---------------------------------------------------------------------------

export interface UseStreamEventHandlerParams {
  // --- Navigation ---
  /** Forward-navigate to a URL. Callers wire this to their framework router. */
  push: (url: string) => void;
  isNative: boolean;

  // --- Stream context ---
  streamEpochRef: MutableRefObject<number>;
  activeConversationKeyRef: MutableRefObject<string | null>;
  streamContextRef: MutableRefObject<StreamContext | null>;
  assistantIdRef: MutableRefObject<string | null>;

  // --- Messages ---
  setMessages: Dispatch<SetStateAction<DisplayMessage[]>>;
  messagesRef: MutableRefObject<DisplayMessage[]>;
  needsNewBubbleRef: MutableRefObject<boolean>;

  // --- Turn state ---
  dispatchTurn: Dispatch<DomainEvent>;
  turnStateRef: MutableRefObject<TurnState>;

  // --- Processing ---
  dispatchConversationList: Dispatch<ConversationListAction>;
  processingSnapshotsRef: MutableRefObject<
    Map<string, string | undefined>
  >;

  // --- Error & stream lifecycle ---
  setError: Dispatch<SetStateAction<ChatError | null>>;
  streamRef: MutableRefObject<ChatEventStream | null>;

  // --- Reconciliation ---
  cancelReconciliation: () => void;
  startReconciliationLoop: (epoch: number) => void;

  // --- Interaction state (secret, confirmation, contact request) ---
  dispatchInteraction: Dispatch<InteractionEvent>;
  confirmationToolCallMapRef: MutableRefObject<Map<string, string>>;

  // --- Subagent state ---
  dispatchSubagent: Dispatch<SubagentAction>;

  // --- UI surfaces ---
  setAssetsRefreshKey: Dispatch<SetStateAction<number>>;
  dismissedSurfaceIdsRef: MutableRefObject<Set<string>>;

  // --- Context window ---
  contextWindowUsageByConversationRef: MutableRefObject<
    Map<string, ContextWindowUsage>
  >;
  setContextWindowUsage: Dispatch<
    SetStateAction<ContextWindowUsage | null>
  >;

  // --- Conversations ---
  scheduleConversationListRefetch: () => void;

  // --- Compaction ---
  setCompactionCircuitOpenUntil: Dispatch<SetStateAction<Date | null>>;

  // --- External callbacks (stabilized via refs in the hook) ---
  applyDiskPressureStatusEvent: (
    payload: DiskPressureStatusEventPayload,
  ) => void;
  refreshAssistantIdentity: (force?: boolean) => Promise<void>;
  invalidateAvatar: () => void;
  dispatchSyncChanged: (event: AssistantSyncChangedEvent) => void;

  // --- Queue management ---
  pendingQueuedStableIdsRef: MutableRefObject<string[]>;
  requestIdToStableIdRef: MutableRefObject<Map<string, string>>;
  pendingLocalDeletionsRef: MutableRefObject<Set<string>>;
}

interface UseStreamEventHandlerReturn {
  handleStreamEvent: (event: AssistantEvent, epoch: number) => void;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Routes incoming SSE events from the assistant stream to domain handler
 * functions (message, error, tool-call, metadata, etc.).
 *
 * Builds a `StreamHandlerContext` on each call and delegates to the
 * appropriate handler based on event type via an exhaustive switch.
 *
 * @param params.dispatchConversationList - Dispatch function from the
 *   `conversationListReducer`. Passed through to handlers that update
 *   conversation state (e.g., title updates, processing key removal).
 * @returns `handleStreamEvent(event, epoch)` — call this for each SSE event.
 */
export function useStreamEventHandler(
  params: UseStreamEventHandlerParams,
): UseStreamEventHandlerReturn {
  const queryClient = useQueryClient();

  const {
    push,
    isNative,
    streamEpochRef,
    activeConversationKeyRef,
    streamContextRef,
    assistantIdRef,
    setMessages,
    messagesRef,
    needsNewBubbleRef,
    dispatchTurn,
    turnStateRef,
    dispatchConversationList,
    processingSnapshotsRef,
    setError,
    streamRef,
    cancelReconciliation,
    startReconciliationLoop,
    dispatchInteraction,
    confirmationToolCallMapRef,
    dispatchSubagent,

    setAssetsRefreshKey,
    dismissedSurfaceIdsRef,
    contextWindowUsageByConversationRef,
    setContextWindowUsage,
    scheduleConversationListRefetch,
    setCompactionCircuitOpenUntil,
    applyDiskPressureStatusEvent,
    refreshAssistantIdentity,
    invalidateAvatar,
    dispatchSyncChanged,
    pendingQueuedStableIdsRef,
    requestIdToStableIdRef,
    pendingLocalDeletionsRef,
  } = params;

  // --- Refs owned by this hook (only used inside handleStreamEvent) ---
  const lastActivityVersionRef = useRef<Map<string, number>>(new Map());
  const toolCallIdCounterRef = useRef(0);
  const currentAssistantStableIdRef = useRef<string | undefined>(undefined);

  // Stabilize external callbacks that may not be memoized upstream.
  // Storing them in refs keeps handleStreamEvent's identity stable across
  // renders while always calling the latest version of each callback.
  // Reference: https://react.dev/reference/react/useCallback#preventing-an-effect-from-firing-too-often
  const applyDiskPressureStatusEventRef = useRef(applyDiskPressureStatusEvent);
  applyDiskPressureStatusEventRef.current = applyDiskPressureStatusEvent;
  const refreshAssistantIdentityRef = useRef(refreshAssistantIdentity);
  refreshAssistantIdentityRef.current = refreshAssistantIdentity;
  const invalidateAvatarRef = useRef(invalidateAvatar);
  invalidateAvatarRef.current = invalidateAvatar;

  /** Remove a conversation key from the processing set and snapshots map. */
  const clearProcessingKey = useCallback(
    (convKey: string) => {
      dispatchConversationList({ type: "REMOVE_PROCESSING_KEY", key: convKey });
      processingSnapshotsRef.current.delete(convKey);
    },
    [dispatchConversationList, processingSnapshotsRef],
  );

  // --- Main event handler ---

  const handleStreamEvent = useCallback(
    (event: AssistantEvent, epoch: number) => {
      // Discard events from stale/previous streams
      const eventSummary = summarizeAssistantEvent(event);
      if (epoch !== streamEpochRef.current) {
        recordChatDiagnostic("sse_event_stale", {
          epoch,
          currentEpoch: streamEpochRef.current,
          activeConversationKey: activeConversationKeyRef.current,
          ...eventSummary,
        });
        return;
      }
      const streamConversationKey =
        streamContextRef.current?.conversationKey;
      if (
        event.conversationKey &&
        streamConversationKey &&
        isConversationScopedStreamEvent(event) &&
        event.conversationKey !== streamConversationKey
      ) {
        recordChatDiagnostic("sse_event_wrong_conversation", {
          epoch,
          activeConversationKey: activeConversationKeyRef.current,
          streamContext: streamContextRef.current,
          ...eventSummary,
        });
        return;
      }
      if (
        event.type !== "assistant_text_delta" ||
        needsNewBubbleRef.current
      ) {
        recordChatDiagnostic(
          event.type === "assistant_text_delta"
            ? "sse_assistant_text_delta_start"
            : "sse_event",
          {
            epoch,
            activeConversationKey: activeConversationKeyRef.current,
            streamContext: streamContextRef.current,
            ...eventSummary,
          },
        );
      }

      // Build context object for domain handlers
      const ctx: StreamHandlerContext = {
        router: { push },
        isNative,
        streamContextRef,
        activeConversationKeyRef,
        assistantIdRef,
        setMessages,
        messagesRef,
        needsNewBubbleRef,
        dispatchTurn,
        turnStateRef,
        clearProcessingKey,
        setError,
        streamRef,
        cancelReconciliation,
        startReconciliationLoop,
        dispatchInteraction,
        confirmationToolCallMapRef,
        dispatchSubagent,

        setAssetsRefreshKey,
        dismissedSurfaceIdsRef,
        contextWindowUsageByConversationRef,
        setContextWindowUsage,
        scheduleConversationListRefetch,
        dispatchConversationList,
        setCompactionCircuitOpenUntil,
        applyDiskPressureStatusEvent: (...args) =>
          applyDiskPressureStatusEventRef.current(...args),
        refreshAssistantIdentity: (...args) =>
          refreshAssistantIdentityRef.current(...args),
        invalidateAvatar: (...args) =>
          invalidateAvatarRef.current(...args),
        pendingQueuedStableIdsRef,
        requestIdToStableIdRef,
        pendingLocalDeletionsRef,
        lastActivityVersionRef,
        toolCallIdCounterRef,
        currentAssistantStableIdRef,
      };

      switch (event.type) {
        case "open_url":
          handleOpenUrl(event, ctx);
          break;
        case "navigate_settings":
          handleNavigateSettings(event, ctx);
          break;
        case "assistant_text_delta":
          handleAssistantTextDelta(event, ctx);
          break;
        case "assistant_activity_state":
          handleAssistantActivityState(event, epoch, ctx);
          break;
        case "message_complete":
          handleMessageComplete(event, epoch, ctx);
          break;
        case "generation_handoff":
          handleGenerationHandoff(event, ctx);
          break;
        case "error":
          handleStreamError(event, ctx);
          break;
        case "conversation_error":
          handleConversationErrorEvent(event, ctx);
          break;
        case "generation_cancelled":
          handleGenerationCancelled(event, ctx);
          break;
        case "secret_request":
          handleSecretRequest(event, ctx);
          break;
        case "confirmation_request":
          handleConfirmationRequest(event, ctx);
          break;
        case "contact_request":
          handleContactRequest(event, ctx);
          break;
        case "question_request":
          handleQuestionRequest(event, ctx);
          break;
        case "ui_surface_show":
          handleUISurfaceShow(event, ctx);
          break;
        case "ui_surface_update":
          handleUISurfaceUpdate(event, ctx);
          break;
        case "ui_surface_dismiss":
          handleUISurfaceDismiss(event, ctx);
          break;
        case "ui_surface_complete":
          handleUISurfaceComplete(event, ctx);
          break;
        case "tool_use_start":
          handleToolUseStart(event, ctx);
          break;
        case "tool_result":
          handleToolResult(event, ctx);
          break;
        case "usage_update":
          handleUsageUpdate(event, ctx);
          break;
        case "conversation_list_invalidated":
          handleConversationListInvalidated(event, ctx);
          break;
        case "conversation_title_updated":
          handleConversationTitleUpdated(event, ctx);
          break;
        case "notification_intent":
          handleNotificationIntent(event, ctx);
          break;
        case "compaction_circuit_open":
          handleCompactionCircuitOpen(event, ctx);
          break;
        case "compaction_circuit_closed":
          handleCompactionCircuitClosed(event, ctx);
          break;
        case "disk_pressure_status_changed":
          handleDiskPressureStatusChanged(event, ctx);
          break;
        case "identity_changed":
          handleIdentityChanged(event, ctx);
          break;
        case "avatar_updated":
          handleAvatarUpdated(event, ctx);
          break;
        case "message_queued":
          handleMessageQueued(event, ctx);
          break;
        case "message_dequeued":
          handleMessageDequeued(event, ctx);
          break;
        case "message_queued_deleted":
          handleMessageQueuedDeleted(event, ctx);
          break;
        case "message_request_complete":
          handleMessageRequestComplete(event, ctx);
          break;
        case "home_feed_updated":
          handleHomeFeedUpdated(queryClient, event);
          break;
        case "relationship_state_updated":
          handleRelationshipStateUpdated(queryClient, event);
          break;
        case "subagent_spawned":
          handleSubagentSpawned(event, ctx);
          break;
        case "subagent_status_changed":
          handleSubagentStatusChanged(event, ctx);
          break;
        case "subagent_event":
          handleSubagentEvent(event, ctx);
          break;
        case "sync_changed":
          dispatchSyncChanged(event);
          break;
        case "unknown":
          break;
        default: {
          const _exhaustive: never = event;
          void _exhaustive;
        }
      }
    },
    [
      push,
      isNative,
      clearProcessingKey,
      cancelReconciliation,
      startReconciliationLoop,
      scheduleConversationListRefetch,
      // Stable deps listed for correctness — React guarantees identity
      // stability for state setters and refs, so these never trigger
      // re-creation of the callback.
      // Note: applyDiskPressureStatusEvent, refreshAssistantIdentity, and
      // invalidateAvatar are accessed via refs (stable identity) and are
      // intentionally excluded from this dep array.
      dispatchSyncChanged,
      queryClient,
      streamEpochRef,
      activeConversationKeyRef,
      streamContextRef,
      assistantIdRef,
      setMessages,
      messagesRef,
      needsNewBubbleRef,
      dispatchTurn,
      turnStateRef,
      setError,
      streamRef,
      dispatchInteraction,
      confirmationToolCallMapRef,
      dispatchSubagent,
      setAssetsRefreshKey,
      dismissedSurfaceIdsRef,
      contextWindowUsageByConversationRef,
      setContextWindowUsage,
      dispatchConversationList,
      setCompactionCircuitOpenUntil,
      pendingQueuedStableIdsRef,
      requestIdToStableIdRef,
      pendingLocalDeletionsRef,
    ],
  );

  return { handleStreamEvent };
}
