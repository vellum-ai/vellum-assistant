import {
  type MutableRefObject,
  type Dispatch,
  type SetStateAction,
  useCallback,
  useRef,
} from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useConversationStore } from "@/stores/conversation-store";
import type { ContextWindowUsage } from "@/domains/chat/components/context-window-indicator";
import type { DisplayMessage } from "@/domains/chat/utils/reconcile";
import { tailIsStreamingAssistant } from "@/domains/chat/hooks/stream-message-updaters";
import { useTurnStore } from "@/domains/chat/turn-store";
import { endTurn } from "@/domains/chat/turn-coordinator";

import { recordDiagnostic, summarizeAssistantEvent } from "@/lib/diagnostics";
import { isConversationScopedStreamEvent } from "@/domains/chat/utils/chat";
import {
  handleOpenUrl,
  handleNavigateSettings,
} from "@/domains/chat/utils/stream-handlers/navigation-handlers";
import {
  handleAssistantTextDelta,
  handleAssistantTurnStart,
  handleAssistantActivityState,
  handleMessageComplete,
  handleUserMessageEcho,
  handleGenerationHandoff,
  handleGenerationCancelled,
} from "@/domains/chat/utils/stream-handlers/message-handlers";
import {
  handleStreamError,
  handleConversationErrorEvent,
} from "@/domains/chat/utils/stream-handlers/error-handlers";
import {
  handleSecretRequest,
  handleConfirmationRequest,
  handleContactRequest,
  handleQuestionRequest,
} from "@/domains/chat/utils/stream-handlers/interaction-handlers";
import {
  handleUISurfaceShow,
  handleUISurfaceUpdate,
  handleUISurfaceDismiss,
  handleUISurfaceComplete,
} from "@/domains/chat/utils/stream-handlers/surface-handlers";
import {
  handleToolUseStart,
  handleToolResult,
} from "@/domains/chat/utils/stream-handlers/tool-call-handlers";
import {
  handleUsageUpdate,
  handleCompactionCircuitOpen,
  handleCompactionCircuitClosed,
  handleTurnProfileAutoRouted,
} from "@/domains/chat/utils/stream-handlers/metadata-handlers";
import {
  handleMessageQueued,
  handleMessageDequeued,
  handleMessageQueuedDeleted,
  handleMessageRequestComplete,
} from "@/domains/chat/utils/stream-handlers/queue-handlers";
import {
  handleSubagentSpawned,
  handleSubagentStatusChanged,
  handleSubagentEvent,
} from "@/domains/chat/utils/stream-handlers/subagent-handlers";
import type {
  StreamHandlerContext,
  StreamContext,
} from "@/domains/chat/utils/stream-handlers/types";

export type {
  ChatError,
  PendingConfirmationState,
  PendingContactRequestState,
  PendingSecretState,
} from "@/domains/chat/types";

import type { ChatError } from "@/domains/chat/types";
import type { AssistantEvent } from "@/types/event-types";
import type { SyncChangedEvent } from "@/lib/sync/types";
import type { ChatEventStream } from "@/lib/streaming/stream-transport";

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
  streamContextRef: MutableRefObject<StreamContext | null>;
  assistantIdRef: MutableRefObject<string | null>;

  // --- Messages ---
  setMessages: Dispatch<SetStateAction<DisplayMessage[]>>;
  messagesRef: MutableRefObject<DisplayMessage[]>;

  // --- Error & stream lifecycle ---
  setError: Dispatch<SetStateAction<ChatError | null>>;
  streamRef: MutableRefObject<ChatEventStream | null>;

  // --- Reconciliation ---
  cancelReconciliation: () => void;
  startReconciliationLoop: (epoch: number) => void;

  // --- Interaction state (secret, confirmation, contact request) ---
  confirmationToolCallMapRef: MutableRefObject<Map<string, string>>;

  // --- UI surfaces ---
  setAssetsRefreshKey: Dispatch<SetStateAction<number>>;
  dismissedSurfaceIdsRef: MutableRefObject<Set<string>>;

  // --- Context window ---
  contextWindowUsageByConversationRef: MutableRefObject<
    Map<string, ContextWindowUsage>
  >;
  setContextWindowUsage: Dispatch<SetStateAction<ContextWindowUsage | null>>;

  // --- Conversations ---
  scheduleConversationListRefetch: () => void;

  // --- Compaction ---
  setCompactionCircuitOpenUntil: Dispatch<SetStateAction<Date | null>>;

  // --- Sync router ---
  dispatchSyncChanged: (event: SyncChangedEvent) => void;

  // --- Queue management ---
  pendingQueuedMessageIdsRef: MutableRefObject<string[]>;
  requestIdToMessageIdRef: MutableRefObject<Map<string, string>>;
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
    streamContextRef,
    assistantIdRef,
    setMessages,
    messagesRef,
    setError,
    streamRef,
    cancelReconciliation,
    startReconciliationLoop,
    confirmationToolCallMapRef,
    setAssetsRefreshKey,
    dismissedSurfaceIdsRef,
    contextWindowUsageByConversationRef,
    setContextWindowUsage,
    scheduleConversationListRefetch,
    setCompactionCircuitOpenUntil,
    dispatchSyncChanged,
    pendingQueuedMessageIdsRef,
    requestIdToMessageIdRef,
    pendingLocalDeletionsRef,
  } = params;

  // --- Refs owned by this hook (only used inside handleStreamEvent) ---
  const lastActivityVersionRef = useRef<Map<string, number>>(new Map());
  const toolCallIdCounterRef = useRef(0);
  const currentAssistantMessageIdRef = useRef<string | undefined>(undefined);

  // --- Main event handler ---

  const handleStreamEvent = useCallback(
    (event: AssistantEvent, epoch: number) => {
      // Discard events from stale/previous streams
      const eventSummary = summarizeAssistantEvent(event);
      if (epoch !== streamEpochRef.current) {
        recordDiagnostic("sse_event_stale", {
          epoch,
          currentEpoch: streamEpochRef.current,
          activeConversationId:
            useConversationStore.getState().activeConversationId,
          ...eventSummary,
        });
        return;
      }
      const streamConversationId = streamContextRef.current?.conversationId;
      // Defense-in-depth: even though useEventStream's filter already
      // rejects conversation-scoped events without an explicit matching
      // conversationId, gate here too so any future caller of
      // handleStreamEvent cannot route a conversation-scoped event with
      // a missing or mismatched id into the active conversation.
      // Global events (`sync_changed`, `home_feed_updated`, etc.) pass
      // through unconditionally.
      if (isConversationScopedStreamEvent(event)) {
        if (!event.conversationId || !streamConversationId) {
          recordDiagnostic("sse_event_wrong_conversation", {
            epoch,
            activeConversationId:
              useConversationStore.getState().activeConversationId,
            streamContext: streamContextRef.current,
            reason: !event.conversationId ? "missing" : "no_stream_context",
            ...eventSummary,
          });
          return;
        }
        if (event.conversationId !== streamConversationId) {
          recordDiagnostic("sse_event_wrong_conversation", {
            epoch,
            activeConversationId:
              useConversationStore.getState().activeConversationId,
            streamContext: streamContextRef.current,
            reason: "mismatch",
            ...eventSummary,
          });
          return;
        }
      }
      // Suppress per-chunk text_delta noise — only log the first delta of a
      // new assistant message. Derived from `messagesRef` instead of a latch
      // so any write site that updates the messages array is naturally
      // reflected here.
      if (
        event.type !== "assistant_text_delta" ||
        !tailIsStreamingAssistant(messagesRef.current)
      ) {
        recordDiagnostic(
          event.type === "assistant_text_delta"
            ? "sse_assistant_text_delta_start"
            : "sse_event",
          {
            epoch,
            activeConversationId:
              useConversationStore.getState().activeConversationId,
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
        assistantIdRef,
        setMessages,
        messagesRef,
        turnActions: useTurnStore.getState(),
        getTurnState: () => useTurnStore.getState(),
        endTurn,
        setError,
        streamRef,
        cancelReconciliation,
        startReconciliationLoop,
        confirmationToolCallMapRef,
        setAssetsRefreshKey,
        dismissedSurfaceIdsRef,
        contextWindowUsageByConversationRef,
        setContextWindowUsage,
        scheduleConversationListRefetch,
        queryClient,
        setCompactionCircuitOpenUntil,
        pendingQueuedMessageIdsRef,
        requestIdToMessageIdRef,
        pendingLocalDeletionsRef,
        lastActivityVersionRef,
        toolCallIdCounterRef,
        currentAssistantMessageIdRef,
      };

      switch (event.type) {
        case "open_url":
          handleOpenUrl(event, ctx);
          break;
        case "navigate_settings":
          handleNavigateSettings(event, ctx);
          break;
        case "assistant_turn_start":
          handleAssistantTurnStart(event, ctx);
          break;
        case "assistant_text_delta":
          handleAssistantTextDelta(event, ctx);
          break;
        case "assistant_activity_state":
          handleAssistantActivityState(event, ctx);
          break;
        case "message_complete":
          handleMessageComplete(event, ctx);
          break;
        case "user_message_echo":
          handleUserMessageEcho(event, ctx);
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
          // Legacy macOS-only broadcast. Web receives the paired
          // `sync_changed` (`conversationsList` umbrella for shape
          // changes, `conversation:<id>:metadata` for content) directly
          // and patches the cached list there. The hub scopes this
          // event to `targetInterfaceId: "macos"`, so it should not
          // reach web in practice — handling no-op'd as defense in
          // depth in case a deployment runs an older assistant.
          //
          // TODO(electron-cutover): drop the case once macOS migrates
          // to the Electron client and `conversation_list_invalidated`
          // is retired from the event types entirely.
          break;

        case "compaction_circuit_open":
          handleCompactionCircuitOpen(event, ctx);
          break;
        case "compaction_circuit_closed":
          handleCompactionCircuitClosed(event, ctx);
          break;

        case "turn_profile_auto_routed":
          handleTurnProfileAutoRouted(event, ctx);
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

        // Cross-domain events handled by bus subscribers mounted in
        // RootLayout (useAssistantResourceSync, useConversationSync,
        // useNotificationIntentSync, useDocumentEditorSync) or
        // ChatPage-scoped hooks (useDiskPressureMonitor). The chat
        // handler is intentionally a no-op for these.
        case "home_feed_updated":
        case "relationship_state_updated":
        case "identity_changed":
        case "avatar_updated":
        case "disk_pressure_status_changed":
        case "notification_intent":
        case "document_editor_update":
        case "conversation_title_updated":
        case "document_comment_created":
        case "document_comment_resolved":
        case "document_comment_reopened":
        case "document_comment_deleted":
        case "interaction_resolved":
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
      cancelReconciliation,
      startReconciliationLoop,
      scheduleConversationListRefetch,
      // Stable deps listed for correctness — React guarantees identity
      // stability for state setters and refs, so these never trigger
      // re-creation of the callback.
      dispatchSyncChanged,
      queryClient,
      streamEpochRef,
      streamContextRef,
      assistantIdRef,
      setMessages,
      messagesRef,
      setError,
      streamRef,
      confirmationToolCallMapRef,
      setAssetsRefreshKey,
      dismissedSurfaceIdsRef,
      contextWindowUsageByConversationRef,
      setContextWindowUsage,
      setCompactionCircuitOpenUntil,
      pendingQueuedMessageIdsRef,
      requestIdToMessageIdRef,
      pendingLocalDeletionsRef,
    ],
  );

  return { handleStreamEvent };
}
