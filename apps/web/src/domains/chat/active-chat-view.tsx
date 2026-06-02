/**
 * ActiveChatView — chat orchestration, mounted only when the assistant is usable.
 *
 * ChatPage handles lifecycle guards (loading, error, setup, cleanup, retired)
 * and mounts this component only when `shouldRenderChat` is true. All
 * orchestration hooks (SSE, TanStack Query, Zustand subscriptions, keyboard
 * listeners) live here so they don't execute during non-active states.
 */

import {
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";

import { useAuthStore } from "@/stores/auth-store";

import { useAssistantLifecycleStore } from "@/assistant/lifecycle-store";
import { useAutoGreetGate } from "@/domains/chat/hooks/use-auto-greet-gate";
import { useAssistantSelectionStore } from "@/assistant/selection-store";
import { useConversationStore } from "@/stores/conversation-store";
import { requestComposerFocus } from "./composer-focus";
import { useActiveConversation } from "@/domains/chat/hooks/use-active-conversation";
import { useViewerStore } from "@/stores/viewer-store";
import { useDeployStore } from "@/stores/deploy-store";
import { useSubagentStore } from "@/domains/chat/subagent-store";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { useIsNativePlatform } from "@/runtime/native-auth";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

import type { DisplayMessage } from "@/domains/chat/utils/reconcile";
import type { TranscriptHandle } from "@/domains/chat/transcript/transcript";
import type { TranscriptItem } from "@/domains/chat/transcript/types";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { shouldSuppressGenericChatErrorNotice } from "@/domains/chat/utils/error-classification";
import { peekPendingPreChatContext } from "@/domains/onboarding/prechat";

import { LazyBoundary } from "@/components/lazy-boundary";
import { useChatAttachments } from "@/domains/chat/components/chat-attachments/use-chat-attachments";
import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";
import { useAssistantReachability } from "@/assistant/use-assistant-reachability";
import { useDiskPressureMonitor } from "@/assistant/use-disk-pressure-monitor";
import { getDiskPressureChatBlockReason } from "@/assistant/disk-pressure";

import { useConversationLoader } from "@/domains/chat/hooks/use-conversation-loader";
import { useOnboardingOrchestrator } from "@/domains/chat/hooks/use-onboarding-orchestrator";

import { useConversationSecondaryActions } from "@/domains/chat/hooks/use-conversation-secondary-actions";
import { canUseLlmInspector } from "@/domains/chat/inspector/access";
import { useMessageReconciliation } from "@/domains/chat/hooks/use-message-reconciliation";
import { useStreamEventHandler } from "@/domains/chat/hooks/use-stream-event-handler";
import { useSendMessage } from "@/domains/chat/hooks/use-send-message";
import { useEventStream } from "@/domains/chat/hooks/use-event-stream";
import { hydrateLastSeenSeqFromStorage } from "@/lib/streaming/last-seen-seq";
import { isSeqGapDetectionEnabled } from "@/lib/feature-flags/seq-gap-detection-flag";
import { useActiveAppPinSync } from "@/domains/chat/hooks/use-active-app-pin-sync";
import { useDraftInput } from "@/domains/chat/components/chat-composer/use-draft-input";
import { useDeepLinkConsumer } from "@/domains/chat/hooks/use-deep-link-consumer";
import { useRefreshLatestMessages } from "@/domains/chat/hooks/use-refresh-latest-messages";
import { useChatDebugRegistration } from "@/domains/chat/hooks/use-chat-debug-registration";
import { useDeepLinkApp } from "@/domains/chat/hooks/use-deep-link-app";

import { ConnectingToAssistant } from "@/domains/chat/components/connecting-to-assistant";

const AddCreditsModal = lazy(() =>
  import("@/components/add-credits-modal").then((m) => ({
    default: m.AddCreditsModal,
  })),
);
const DeployDialogs = lazy(() =>
  import("@/components/deploy-dialogs").then((m) => ({
    default: m.DeployDialogs,
  })),
);

import { MobileChatOverlays } from "@/domains/chat/components/mobile-chat-overlays";
import { useSyncRouter } from "@/domains/chat/hooks/use-sync-router";
import { useChatHeaderRegistration } from "@/domains/chat/hooks/use-chat-header-registration";
import { useConversationChangeEffects } from "@/domains/chat/hooks/use-conversation-change-effects";
import { useComposerKeyboard } from "@/domains/chat/hooks/use-composer-keyboard";
import { useAutoSendEffects } from "@/domains/chat/hooks/use-auto-send-effects";

import { routes } from "@/utils/routes";

import {
  ChatRouteContent,
  type ChatRouteContentProps,
} from "@/domains/chat/components/chat-route-content";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ActiveChatView() {
  const authUser = useAuthStore.use.user();
  const showLlmInspector = canUseLlmInspector(authUser);
  const isNative = useIsNativePlatform();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { conversationId: urlConversationId } = useParams<{ conversationId?: string }>();
  const assistantId = useAssistantSelectionStore.use.activeAssistantId();
  const assistantState = useAssistantLifecycleStore.use.assistantState();
  const conversationGroupsUI = useAssistantFeatureFlagStore.use.conversationGroupsUI();

  // -------------------------------------------------------------------------
  // Chat session store — reactive selectors for per-conversation state
  // -------------------------------------------------------------------------
  const messages = useChatSessionStore.use.messages();
  const setError = useChatSessionStore.use.setError();

  // -------------------------------------------------------------------------
  // Local state (not store-backed)
  // -------------------------------------------------------------------------
  const [showAddCreditsModal, setShowAddCreditsModal] = useState(false);

  const [restoredDraftConversationId, setRestoredDraftConversationId] = useState<string | null>(null);
  const [refreshEpoch, setRefreshEpoch] = useState(0);
  const [assetsRefreshKey, setAssetsRefreshKey] = useState(0);

  // Hydrate per-conversation seq cursors from localStorage once so gap
  // detection in use-event-stream has a seeded cursor before the first
  // bus event arrives. Gated behind the debug flag.
  useEffect(() => {
    if (isSeqGapDetectionEnabled()) {
      hydrateLastSeenSeqFromStorage();
    }
  }, []);

  // -------------------------------------------------------------------------
  // Zustand store selectors
  // -------------------------------------------------------------------------
  const activeConversationId = useConversationStore.use.activeConversationId();
  const isTokenDialogOpen = useDeployStore.use.isTokenDialogOpen();
  const complexDeployApp = useDeployStore.use.complexDeployApp();

  // Assistant identity is fetched and stored by `useAssistantIdentityInit`
  // at the `ChatLayout` level (TanStack Query → Zustand) so the sidebar
  // header populates on every `/assistant/*` route. ActiveChatView reads the
  // store via atomic selectors per `docs/STATE_MANAGEMENT.md` rather
  // than maintaining its own local copy.
  const assistantName = useAssistantIdentityStore.use.name();

  // -------------------------------------------------------------------------
  // Pin-sync side-effect
  // -------------------------------------------------------------------------
  useActiveAppPinSync(useCallback((appId: string) => {
    const didClose = useViewerStore.getState().handleAppUnpinned(appId);
    if (didClose) {
      useConversationStore.getState().setEditingConversationId(null);
    }
  }, []));

  // -------------------------------------------------------------------------
  // Shared refs — owned here, read/written by hooks
  // -------------------------------------------------------------------------
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const sanitizedMessagesRef = useRef<DisplayMessage[]>([]);
  const transcriptItemsRef = useRef<TranscriptItem[]>([]);
  // Threaded down to ChatRouteContent and bound on the `<Transcript />`
  // instance there. Also read by useChatDebugRegistration for scroll state.
  const transcriptRef = useRef<TranscriptHandle | null>(null);

  // -------------------------------------------------------------------------
  // Onboarding orchestrator — owns onboarding refs, flags, and effects.
  // Refs are shared with useSendMessage + useConversationLoader below.
  // -------------------------------------------------------------------------
  const {
    didOnboarding,
    onboardingTasksEmpty,
    onboardingConversationId,
    pendingOnboardingContextRef,
    onboardingDraftConversationIdRef,
  } = useOnboardingOrchestrator();

  const conversationListInvalidatedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingInitialMessageRef = useRef<{ conversationId: string; content: string } | null>(null);

  // -------------------------------------------------------------------------
  // Routing
  // -------------------------------------------------------------------------
  const push = useCallback(
    (url: string) => { void navigate(url); },
    [navigate],
  );
  const navigateToConversation = useCallback(
    (key: string) => { void navigate(routes.conversation(key)); },
    [navigate],
  );
  // -------------------------------------------------------------------------
  // Reachability
  // -------------------------------------------------------------------------
  const reachability = useAssistantReachability(assistantId);
  const reachabilityReadyEpoch = useMemo(() => {
    if (reachability.state.phase === "ready") return refreshEpoch + 1;
    return 0;
  }, [reachability.state.phase, refreshEpoch]);

  // -------------------------------------------------------------------------
  // Disk pressure
  // -------------------------------------------------------------------------
  const diskPressure = useDiskPressureMonitor({
    assistantId,
    enabled: true,
  });
  const diskPressureChatBlockReason = getDiskPressureChatBlockReason({
    monitorEnabled: diskPressure.mode !== null,
    hasResolvedStatus: diskPressure.hasResolvedStatus,
    status: diskPressure.status,
  });

  // -------------------------------------------------------------------------
  // Draft input — owns composer `input` state and per-conversation draft
  // persistence to localStorage. Replaces the old manual `draftsRef` that was
  // threaded through useConversationLoader → useConversationHistory.
  // -------------------------------------------------------------------------
  const { input, setInput, saveDraft, clearDraft } = useDraftInput({
    assistantId,
    activeConversationId,
    onDraftRestored: setRestoredDraftConversationId,
  });

  // Keyboard focus: Electron host focus relay + typing auto-focus.
  useComposerKeyboard(inputRef, setInput);

  // Inbound deep links: pre-fill composer with `deeplink.send` text,
  // navigate to `/assistant/conversations/<id>` for `deeplink.openThread`,
  // and ensure the main window is visible first. The hook gates the
  // composer pre-fill on `input` being empty so it doesn't clobber
  // in-progress typing. Off Electron the bus events never fire.
  useDeepLinkConsumer({ composerInput: input, setComposerInput: setInput });

  // -------------------------------------------------------------------------
  // Attachments
  // -------------------------------------------------------------------------
  const {
    attachments: chatAttachments,
    uploadingCount: attachmentsUploadingCount,
    uploadedIds: attachmentUploadedIds,
    lastError: attachmentLastError,
    addFiles: addChatAttachmentFiles,
    removeAttachment: removeChatAttachment,
    reset: resetChatAttachments,
    dismissError: dismissChatAttachmentError,
  } = useChatAttachments(assistantId);



  // -------------------------------------------------------------------------
  // Derived state
  // -------------------------------------------------------------------------
  // Resolve the active row from either list cache, fetching the single row
  // when an open background/scheduled thread is in neither — so the header,
  // action menu, read-state, and SSE subscription have metadata without
  // pulling the whole background backlog onto the initial-render path.
  const activeConversation = useActiveConversation(
    assistantId,
    activeConversationId,
    true,
  );

  // Avatar — called here for sync-router invalidation; ChatRouteContent
  // has its own call (TanStack Query deduplicates the fetch).
  const avatar = useAssistantAvatar(assistantId);

  // -------------------------------------------------------------------------
  // Conversation loader
  // -------------------------------------------------------------------------
  const {
    refreshConversations,
    scheduleConversationListRefetch,
    switchConversation: rawSwitchConversation,
    startNewConversation: rawStartNewConversation,
    conversationExistsOnServer,
    historyResult,
  } = useConversationLoader({
    assistantId,
    assistantStateKind: assistantState.kind,
    activeConversationId,
    urlConversationId: urlConversationId ?? null,
    searchParams,
    navigate,
    activeConversation,
    conversationGroupsUI,
    refreshEpoch,
    reachabilityReadyEpoch,
    onboardingDraftConversationIdRef,
    conversationListInvalidatedTimerRef,
    pendingInitialMessageRef,
    shouldSuppressGenericChatErrorNotice,
    resetChatAttachments,
  });

  // Wrap conversation-switching to reset subagent state eagerly
  const switchConversation = useCallback(
    (key: string) => {
      useSubagentStore.getState().reset();
      rawSwitchConversation(key);
    },
    [rawSwitchConversation],
  );
  const startNewConversation = useCallback(
    (opts: { silent?: boolean; initialMessage?: string } = {}) => {
      useSubagentStore.getState().reset();
      rawStartNewConversation(opts);
      requestComposerFocus();
    },
    [rawStartNewConversation],
  );

  // -------------------------------------------------------------------------
  // Message reconciliation
  // -------------------------------------------------------------------------
  const {
    startReconciliationLoop,
    cancelReconciliation,
    reconcileActiveConversation,
  } = useMessageReconciliation({
    latestPageOldestTimestamp: historyResult.pagination.latestPageOldestTimestamp,
  });

  // -------------------------------------------------------------------------
  // Sync router — owns identity invalidation callbacks, reachability
  // refresh, and all sync_changed tag dispatch.
  // -------------------------------------------------------------------------
  const invalidateAvatar = useCallback(() => { avatar.invalidate(); }, [avatar.invalidate]);

  const { dispatchSyncChanged, dispatchReconnect } = useSyncRouter({
    assistantId,
    reachabilityReadyEpoch,
    invalidateAvatar,
    scheduleConversationListRefetch,
    reconcileActiveConversation,
  });

  // -------------------------------------------------------------------------
  // Stream event handler
  // -------------------------------------------------------------------------
  const { handleStreamEvent } = useStreamEventHandler({
    push,
    isNative,
    cancelReconciliation,
    startReconciliationLoop,
    setAssetsRefreshKey,
    scheduleConversationListRefetch,
    dispatchSyncChanged,
  });

  // -------------------------------------------------------------------------
  // Send message
  // -------------------------------------------------------------------------
  const {
    sendMessage,
    handleStopGenerating,
    queuedMessages,
    handleCancelQueuedMessage,
    handleCancelAllQueued,
    handleSteerMessage,
    handleEditQueueTail,
  } = useSendMessage({
    assistantId,
    activeConversationId,
    diskPressureChatBlockReason,
    messages,
    pendingOnboardingContextRef,
    onboardingDraftConversationIdRef,
    setInput,
    startReconciliationLoop,
    cancelReconciliation,
    refreshConversations,
    navigate,
  });

  // Auto-send: URL ?prompt=, pre-chat reachability probe, onboarding message.
  useAutoSendEffects({
    assistantId,
    activeConversationId,
    searchParams,
    sendMessage,
    reachabilityPhase: reachability.state.phase,
    reachabilityProbe: reachability.probe,
    getPendingInitialMessage: () => peekPendingPreChatContext()?.initialMessage ?? undefined,
  });

  // Post-hatch "Connecting…" overlay lifecycle — pre-chat detector,
  // messages-arrived clear, safety timer, conversation-switch clear.
  const autoGreetPending = useAutoGreetGate(
    activeConversationId,
    peekPendingPreChatContext()?.initialMessage != null,
  );

  // Deep-link: ?app=<id> auto-opens the app viewer on initial load.
  useDeepLinkApp(assistantId, searchParams);

  // Conversation-change side effects (dismiss prompts, reset subagent state,
  // auto-fetch subagent details for entries reconstructed from history)
  useConversationChangeEffects(assistantId, activeConversationId);

  // -------------------------------------------------------------------------
  // Event stream (SSE lifecycle)
  // -------------------------------------------------------------------------
  useEventStream({
    assistantStateKind: assistantState.kind,
    assistantId,
    activeConversationId,
    conversationExistsOnServer,
    handleStreamEvent,
    reconcileActiveConversation,
    startReconciliationLoop,
    cancelReconciliation,
    reachabilityProbe: reachability.probe,
    reachabilityPhase: reachability.state.phase,
    reachabilityReset: reachability.reset,
    dispatchReconnect,
    conversationListInvalidatedTimerRef,
  });

  // -------------------------------------------------------------------------
  // Non-destructive refresh for the chat title chevron's Refresh menu item.
  // -------------------------------------------------------------------------
  const refreshLatestMessages = useRefreshLatestMessages({
    assistantId,
  });

  // Debug API — dev-facing surface for in-the-moment chat inspection.
  // Unconditionally attached; negligible production overhead.
  useChatDebugRegistration({
    assistantId,
    sanitizedMessagesRef,
    transcriptItemsRef,
    transcriptRef,
    reconcileActiveConversation,
  });

  // -------------------------------------------------------------------------
  // Conversation secondary actions (fork, analyze, inspect, copy, etc.)
  // Primary actions (archive, pin, rename, mark-read) are owned by
  // ChatConversationHeader in chat-layout.tsx.
  // -------------------------------------------------------------------------
  const {
    handleForkConversation,
    handleForkConversationFromMenu,
    handleAnalyzeConversation,
    handleOpenInNewWindow,
    handleInspectConversation,
    handleInspectMessage,
    handleCopyConversation,
  } = useConversationSecondaryActions({
    assistantId,
    activeConversationId,
    activeConversation: activeConversation ?? null,
    assistantIdentityName: assistantName ?? undefined,
    refreshConversations,
    switchConversation,
    setError,
    navigateToConversation,
    navigate,
  });

  // -------------------------------------------------------------------------
  // Layout header slot registration — supplements, top bar right
  // -------------------------------------------------------------------------
  useChatHeaderRegistration({
    assetsRefreshKey,
    handleAnalyzeConversation,
    handleForkConversationFromMenu,
    handleOpenInNewWindow,
    handleInspectConversation,
    handleCopyConversation,
    refreshLatestMessages,
  });

  // -------------------------------------------------------------------------
  // Auto-greet connecting overlay — shows while waiting for the first
  // message after hatching. Hooks continue running (SSE, queries) so the
  // gate clears when the first message arrives.
  // -------------------------------------------------------------------------
  if (autoGreetPending) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-[var(--text-secondary)]">Connecting…</p>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Props assembly — only values ChatRouteContent can't own locally
  // -------------------------------------------------------------------------
  const chatRouteProps: ChatRouteContentProps = {
    // Send message (orchestration owns SSE / queue lifecycle)
    sendMessage,
    handleStopGenerating,
    queuedMessages,
    handleCancelQueuedMessage,
    handleCancelAllQueued,
    handleSteerMessage,
    handleEditQueueTail,

    // Conversation secondary actions
    handleForkConversation,
    handleInspectMessage: showLlmInspector ? handleInspectMessage : undefined,

    // History pagination
    historyPagination: historyResult.pagination,

    // Draft input (shared — keydown handler + deep link consumer here)
    input,
    setInput,
    saveDraft,
    clearDraft,
    restoredDraftConversationId,
    setRestoredDraftConversationId,

    // Attachments (shared — reset called by switchConversation)
    chatAttachments,
    attachmentsUploadingCount,
    attachmentUploadedIds,
    attachmentLastError,
    addChatAttachmentFiles,
    removeChatAttachment,
    resetChatAttachments,
    dismissChatAttachmentError,

    // Disk pressure (single instance — avoids duplicate polling/subscriptions)
    diskPressure,

    // Upward signals
    setShowAddCreditsModal,
    setRefreshEpoch,

    // Shared refs
    inputRef,
    sanitizedMessagesRef,
    transcriptItemsRef,
    transcriptRef,

    // Onboarding
    onboardingTasksEmpty,
    didOnboarding,
    onboardingConversationId,
  };

  return (
    <>
      <ChatRouteContent {...chatRouteProps} />
      {showAddCreditsModal ? (
        <LazyBoundary>
          <AddCreditsModal
            open={showAddCreditsModal}
            onOpenChange={setShowAddCreditsModal}
          />
        </LazyBoundary>
      ) : null}
      <ConnectingToAssistant
        state={reachability.state}
        onRetry={() => reachability.probe({ showConnectingImmediately: true })}
        onDismiss={reachability.reset}
      />

      {assistantId && (isTokenDialogOpen || complexDeployApp) ? (
        <LazyBoundary>
          <DeployDialogs
            assistantId={assistantId}
            assistantName={assistantName ?? undefined}
            onStartConversation={(msg) => startNewConversation({ initialMessage: msg })}
          />
        </LazyBoundary>
      ) : null}
      <MobileChatOverlays />
    </>
  );
}
