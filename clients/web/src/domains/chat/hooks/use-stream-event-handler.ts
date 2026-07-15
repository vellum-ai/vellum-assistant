import { type Dispatch, type SetStateAction, useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useConversationStore } from "@/stores/conversation-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { tailIsAssistant } from "@/domains/chat/utils/stream-updaters/shared";
import { useTurnStore } from "@/domains/chat/turn-store";
import { endTurn } from "@/domains/chat/turn-coordinator";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { useStreamStore } from "@/domains/chat/stream-store";

import { recordDiagnostic, summarizeAssistantEvent } from "@/lib/diagnostics";
import { isConversationScopedStreamEvent } from "@/domains/chat/utils/chat";
import {
  handleOpenUrl,
  handleNavigateSettings,
  handleOpenPanel,
  handleOpenConversation,
} from "@/domains/chat/utils/stream-handlers/navigation-handlers";
import {
  handleAssistantTextDelta,
  handleAssistantThinkingDelta,
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
  handleConversationNoticeEvent,
} from "@/domains/chat/utils/stream-handlers/error-handlers";
import {
  handleSecretRequest,
  handleConfirmationRequest,
  handleContactRequest,
  handleInteractionResolved,
  handleQuestionRequest,
} from "@/domains/chat/utils/stream-handlers/interaction-handlers";
import {
  handleUISurfaceShow,
  handleUISurfaceUpdate,
  handleUISurfaceDismiss,
  handleUISurfaceComplete,
} from "@/domains/chat/utils/stream-handlers/surface-handlers";
import {
  handleToolUsePreviewStart,
  handleToolUseStart,
  handleToolResult,
} from "@/domains/chat/utils/stream-handlers/tool-call-handlers";
import {
  handleUsageUpdate,
  handleCompactionCircuitOpen,
  handleCompactionCircuitClosed,
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
import {
  handleAcpSessionSpawned,
  handleAcpSessionUpdate,
  handleAcpSessionUsage,
  handleAcpSessionCompleted,
  handleAcpSessionError,
} from "@/domains/chat/utils/stream-handlers/acp-handlers";
import {
  handleBackgroundToolStarted,
  handleBackgroundToolCompleted,
} from "@/domains/chat/utils/stream-handlers/background-task-handlers";
import {
  handleWorkflowStarted,
  handleWorkflowProgress,
  handleWorkflowLeafStarted,
  handleWorkflowLeafFinished,
  handleWorkflowCompleted,
} from "@/domains/chat/utils/stream-handlers/workflow-handlers";
import type { StreamHandlerContext } from "@/domains/chat/utils/stream-handlers/types";

export type {
  ChatError,
  PendingConfirmationState,
  PendingContactRequestState,
  PendingSecretState,
} from "@/domains/chat/types";

import type { AssistantEvent } from "@/types/event-types";

// ---------------------------------------------------------------------------
// Params & return types
// ---------------------------------------------------------------------------

export interface UseStreamEventHandlerParams {
  // --- Navigation ---
  /** Forward-navigate to a URL. Callers wire this to their framework router. */
  push: (url: string) => void;
  isNative: boolean;

  // --- Reconciliation ---
  cancelReconciliation: () => void;
  startReconciliationLoop: (epoch: number) => void;

  // --- UI surfaces ---
  setAssetsRefreshKey: Dispatch<SetStateAction<number>>;
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
 * Builds a `StreamHandlerContext` on each call from infrastructure refs
 * (stream lifecycle) and `useChatSessionStore.getState()` (per-conversation
 * mutable state). Delegates to the appropriate handler based on event type
 * via an exhaustive switch.
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
    cancelReconciliation,
    startReconciliationLoop,
    setAssetsRefreshKey,
  } = params;

  // --- Refs owned by this hook (only used inside handleStreamEvent) ---
  const lastActivityVersionRef = useRef<Map<string, number>>(new Map());
  const currentAssistantMessageIdRef = useRef<string | undefined>(undefined);

  // --- Main event handler ---

  const handleStreamEvent = useCallback(
    (event: AssistantEvent, epoch: number) => {
      // Discard events from stale/previous streams
      const eventSummary = summarizeAssistantEvent(event);
      const streamState = useStreamStore.getState();
      if (epoch !== streamState.streamEpoch) {
        recordDiagnostic("sse_event_stale", {
          epoch,
          currentEpoch: streamState.streamEpoch,
          activeConversationId:
            useConversationStore.getState().activeConversationId,
          ...eventSummary,
        });
        return;
      }
      const streamConversationId = streamState.streamContext?.conversationId;
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
            streamContext: streamState.streamContext,
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
            streamContext: streamState.streamContext,
            reason: "mismatch",
            ...eventSummary,
          });
          return;
        }
      }

      // Snapshot store state once per event for the context object.
      const store = useChatSessionStore.getState();

      // Suppress per-chunk delta noise for the high-frequency streaming events
      // (text and thinking) — only log the first delta of a new assistant
      // message. Reasoning-heavy turns emit hundreds of thinking deltas, which
      // would otherwise evict useful lifecycle/turn context from the ring.
      const isStreamingDelta =
        event.type === "assistant_text_delta" ||
        event.type === "assistant_thinking_delta";
      if (
        !isStreamingDelta ||
        !tailIsAssistant(store.snapshot?.messages ?? [])
      ) {
        recordDiagnostic(
          event.type === "assistant_text_delta"
            ? "sse_assistant_text_delta_start"
            : event.type === "assistant_thinking_delta"
              ? "sse_assistant_thinking_delta_start"
              : "sse_event",
          {
            epoch,
            activeConversationId:
              useConversationStore.getState().activeConversationId,
            streamContext: streamState.streamContext,
            ...eventSummary,
          },
        );
      }

      // Build context object for domain handlers
      const ctx: StreamHandlerContext = {
        router: { push },
        isNative,
        streamContext: streamState.streamContext,
        assistantId: useResolvedAssistantsStore.getState().activeAssistantId,
        setOptimisticSends: store.setOptimisticSends,
        turnActions: useTurnStore.getState(),
        getTurnState: () => useTurnStore.getState(),
        endTurn,
        setError: store.setError,
        setNotice: store.setNotice,
        cancelAndClearStream: useStreamStore.getState().cancelAndClearStream,
        cancelReconciliation,
        startReconciliationLoop,
        setConfirmationToolCall: store.setConfirmationToolCall,
        setAssetsRefreshKey,
        addDismissedSurfaceId: store.addDismissedSurfaceId,
        setContextWindowUsageForConversation:
          store.setContextWindowUsageForConversation,
        setContextWindowUsage: store.setContextWindowUsage,
        queryClient,
        setCompactionCircuitOpenUntil: store.setCompactionCircuitOpenUntil,
        shiftPendingQueuedMessageId: store.shiftPendingQueuedMessageId,
        setRequestIdMapping: store.setRequestIdMapping,
        popRequestIdMapping: store.popRequestIdMapping,
        consumePendingLocalDeletion: store.consumePendingLocalDeletion,
        lastActivityVersionRef,
        currentAssistantMessageIdRef,
      };

      switch (event.type) {
        case "open_url":
          handleOpenUrl(event, ctx);
          break;
        case "navigate_settings":
          handleNavigateSettings(event, ctx);
          break;
        case "open_panel":
          handleOpenPanel(event, ctx);
          break;
        case "open_conversation":
          handleOpenConversation(event, ctx);
          break;
        case "assistant_turn_start":
          handleAssistantTurnStart(event, ctx);
          break;
        case "assistant_text_delta":
          handleAssistantTextDelta(event, ctx);
          break;
        case "assistant_thinking_delta":
          handleAssistantThinkingDelta(event, ctx);
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
        case "conversation_notice":
          handleConversationNoticeEvent(event, ctx);
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
        // Optimistic pre-input affordance: seed a running tool card the moment
        // the call is recognized, so the user-perceived elapsed timer starts at
        // first byte rather than after the input-streaming gap.
        case "tool_use_preview_start":
          handleToolUsePreviewStart(event, ctx);
          break;
        // Incremental tool output (e.g. foreground bash stdout/stderr) folds
        // onto the matching tool call's live `streamedOutput` tail directly in
        // the rolling-snapshot reducer (`use-event-stream`); no handler work.
        case "tool_output_chunk":
          break;
        case "usage_update":
          handleUsageUpdate(event, ctx);
          break;
        // Per-call usage deltas. The top-level chat surface reads running
        // totals from `usage_update`; per-call deltas are only consumed by
        // subagent surfaces via the `subagent_event` envelope.
        case "usage_progress":
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

        case "acp_session_spawned":
          handleAcpSessionSpawned(event);
          break;
        case "acp_session_update":
          handleAcpSessionUpdate(event);
          break;
        case "acp_session_usage":
          handleAcpSessionUsage(event);
          break;
        case "acp_session_completed":
          handleAcpSessionCompleted(event);
          break;
        case "acp_session_error":
          handleAcpSessionError(event);
          break;

        case "background_tool_started":
          handleBackgroundToolStarted(event);
          break;
        case "background_tool_completed":
          handleBackgroundToolCompleted(event);
          break;

        case "workflow_started":
          handleWorkflowStarted(event, ctx);
          break;
        case "workflow_progress":
          handleWorkflowProgress(event, ctx);
          break;
        case "workflow_leaf_started":
          handleWorkflowLeafStarted(event, ctx);
          break;
        case "workflow_leaf_finished":
          handleWorkflowLeafFinished(event, ctx);
          break;
        case "workflow_completed":
          handleWorkflowCompleted(event, ctx);
          break;
        // Cross-domain events handled by bus subscribers mounted in
        // RootLayout (useAssistantResourceSync, useConversationSync,
        // useNotificationIntentSync, useDocumentEditorSync) or
        // ChatPage-scoped hooks (useDiskPressureMonitor). The chat
        // handler is intentionally a no-op for these.
        case "sync_changed":
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
          break;
        // The daemon resolved a pending interaction for the active
        // conversation. Attention tracking handles non-active conversations
        // and defers the active one here, so retire any matching confirmation
        // card before the user can tap a prompt the server has discarded.
        case "interaction_resolved":
          handleInteractionResolved(event);
          break;
        // Transient, best-effort progress signals from lifecycle hooks
        // (e.g. user-prompt-submit). No web UI renders them yet.
        case "hook_event":
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
      queryClient,
      setAssetsRefreshKey,
    ],
  );

  return { handleStreamEvent };
}
