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
        // Surface undo result. The chat handler is a no-op — the undo is driven
        // through the `surfaces/:id/undo` HTTP route and its response; the web
        // does not render the broadcast result.
        case "ui_surface_undo_result":
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
        // useNotificationIntentSync, useDocumentEditorSync, useBookmarksSync)
        // or ChatPage-scoped hooks (useDiskPressureMonitor). The chat
        // handler is intentionally a no-op for these.
        case "bookmark.created":
        case "bookmark.deleted":
        case "sync_changed":
        case "home_feed_updated":
        case "relationship_state_updated":
        case "identity_changed":
        case "avatar_updated":
        case "disk_pressure_status_changed":
        case "notification_intent":
        case "document_editor_show":
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
        // Conversation-scoped signals the web chat view does not render:
        // streaming tool-input deltas, steer acks, authoritative confirmation
        // state transitions, and inference-profile override changes.
        case "tool_input_delta":
        case "message_steered":
        case "confirmation_state_changed":
        case "conversation_inference_profile_updated":
          break;
        // Daemon status / model-catalog / compaction / schedule- and
        // heartbeat-created signals. The web chat handler is a no-op — these are
        // surfaced elsewhere or not rendered by the web today.
        case "assistant_status":
        case "model_info":
        case "context_compacted":
        case "schedule_conversation_created":
        case "heartbeat_alert":
        case "heartbeat_conversation_created":
          break;
        // Host-proxy instructions targeting the desktop client / chrome
        // extension. The web chat handler is a no-op — host-proxy frames are
        // delivered to their capability holder by the hub, not through the
        // conversation stream.
        case "host_bash_request":
        case "host_bash_cancel":
        case "host_cu_request":
        case "host_cu_cancel":
        case "host_ui_snapshot_request":
        case "host_ui_snapshot_cancel":
        case "host_app_control_request":
        case "host_app_control_cancel":
        case "host_browser_request":
        case "host_browser_cancel":
        case "host_file_request":
        case "host_file_cancel":
        case "host_transfer_request":
        case "host_transfer_cancel":
          break;
        // Service-group upgrade lifecycle broadcasts announcing a daemon
        // restart. The chat handler is a no-op; no web UI renders them yet.
        case "service_group_update_starting":
        case "service_group_update_progress":
        case "service_group_update_complete":
          break;
        // Memory recall/status telemetry gauges. The chat handler is a no-op;
        // no web UI renders them yet.
        case "memory_recalled":
        case "memory_status":
          break;
        // Contacts-table invalidation broadcast. The chat handler is a no-op;
        // the contacts page refetches through its own query invalidation.
        case "contacts_changed":
          break;
        // Skill state-change broadcast. The chat handler is a no-op; the skills
        // surfaces refetch through their own query invalidation.
        case "skills_state_changed":
          break;
        // App source-file change broadcast. The chat handler is a no-op; app
        // surfaces re-read the app through their own refresh path.
        case "app_files_changed":
          break;
        // Settings/config broadcasts. The chat handler is a no-op — these target
        // the desktop client or are handled by config-sync consumers.
        case "client_settings_update":
        case "config_changed":
        case "sounds_config_updated":
          break;
        // Integration/platform lifecycle broadcasts. The web chat handler is a
        // no-op — OAuth-connect completion and platform login/disconnect signals
        // are consumed by the settings surfaces, not the conversation stream.
        case "oauth_connect_result":
        case "show_platform_login":
        case "platform_disconnected":
          break;
        // Notification-created broadcasts and recording lifecycle
        // instructions. The web chat handler is a no-op for these — they target
        // the CLI/desktop clients or are handled elsewhere.
        case "notification_conversation_created":
        case "recording_start":
        case "recording_stop":
        case "recording_pause":
        case "recording_resume":
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
