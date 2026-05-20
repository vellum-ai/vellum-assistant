/**
 * ChatPage — orchestration layer for the chat route.
 *
 * Owns the shared refs and state that multiple hooks read/write, calls each
 * hook in dependency order, and maps their outputs to `ChatRouteContent` props.
 *
 * Equivalent of platform's `AssistantPageClient.tsx` lines ~200–1500, adapted
 * to the OSS repo's Zustand stores, React Router, and convention-compliant
 * architecture.
 */

import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { ChevronDown } from "lucide-react";

import { useIsMobile } from "@/hooks/use-is-mobile.js";
import { useAuthStore } from "@/stores/auth-store.js";
import { useAssistantContext } from "@/domains/chat/assistant-context.js";
import { useShallow } from "zustand/shallow";
import { useConversationStore } from "@/domains/conversations/conversation-store.js";
import {
  useConversationGroupsQuery,
  useConversationListQuery,
} from "@/domains/conversations/conversation-queries.js";
import { useViewerStore } from "@/stores/viewer-store.js";
import { useDeployStore } from "@/domains/chat/deploy-store.js";
import { useSubagentStore } from "@/domains/subagents/subagent-store.js";
import { useInteractionStore } from "@/domains/interactions/interaction-store.js";
import { useFeatureFlagStore } from "@/lib/feature-flags/feature-flag-store.js";
import { useIsNativePlatform } from "@/runtime/native-auth.js";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store.js";

import type { DisplayMessage } from "@/domains/chat/utils/reconcile.js";
import type { ChatError } from "@/domains/chat/types.js";
import type { ContextWindowUsage } from "@/domains/chat/components/context-window-indicator.js";
import type { TranscriptPaginationState } from "@/domains/chat/transcript/types.js";
import type { PreChatOnboardingContext } from "@/domains/onboarding/prechat.js";
import type { WebSyncRouter } from "@/lib/sync/web-sync-router.js";
import type { RefreshSettleHandle } from "@/domains/chat/hooks/use-pull-refresh.js";
import type { SyncChangedEvent } from "@/lib/sync/types.js";

import { Button } from "@vellum/design-library";
import { useSyncChatStore } from "@/domains/chat/chat-store.js";
import { useChatAttachments } from "@/domains/chat/components/chat-attachments/use-chat-attachments.js";
import { useVoiceInput } from "@/domains/chat/hooks/use-voice-input.js";
import { useConversationStarters } from "@/domains/chat/hooks/use-conversation-starters.js";
import { useAssistantAvatar } from "@/domains/avatar/use-assistant-avatar.js";
import { useAssistantReachability } from "@/domains/assistant/use-assistant-reachability.js";
import { useDiskPressureMonitor } from "@/domains/assistant/use-disk-pressure-monitor.js";
import { getDiskPressureChatBlockReason } from "@/domains/assistant/disk-pressure.js";
import { useAppNudges } from "@/domains/chat/hooks/use-app-nudges.js";
import { useConversationLoader } from "@/domains/conversations/use-conversation-loader.js";
import { useConversationActions } from "@/domains/conversations/use-conversation-actions.js";
import { useConversationSecondaryActions } from "@/domains/chat/hooks/use-conversation-secondary-actions.js";
import { useCommandPaletteSections } from "@/domains/chat/hooks/use-command-palette-sections.js";
import { useMessageReconciliation } from "@/domains/chat/hooks/use-message-reconciliation.js";
import { useStreamEventHandler } from "@/domains/chat/hooks/use-stream-event-handler.js";
import { useSendMessage } from "@/domains/chat/hooks/use-send-message.js";
import { useInteractionActions } from "@/domains/chat/hooks/use-interaction-actions.js";
import { useEventStream } from "@/domains/chat/hooks/use-event-stream.js";

import { createWebSyncRouter } from "@/lib/sync/web-sync-router.js";
import { fetchAssistantIdentity } from "@/domains/chat/api/assistant.js";
import { shouldSuppressGenericChatErrorNotice } from "@/domains/chat/utils/error-classification.js";
import { hasPendingAssistantResponse } from "@/domains/chat/utils/chat-utils.js";
import { isSurfaceInteractive } from "@/domains/chat/types/types.js";
import type { UIContext } from "@/domains/chat/utils/turn-selectors.js";
import { isChannelConversation } from "@/domains/chat/utils/conversation-channel.js";
import { buildMoveToGroupTargets } from "@/domains/chat/utils/groupConversations.js";
import { ConversationActionsMenu } from "@/domains/chat/components/conversation-actions-menu.js";
import { ConversationAssetsPill } from "@/domains/chat/components/conversation-assets-pill.js";
import { CommandPalette } from "@/components/command-palette/command-palette.js";
import { shouldHandleShortcut } from "@/domains/chat/chat-layout.js";
import { abortSubagent } from "@/domains/chat/api/conversations.js";
import { MobileAppOverlay } from "@/domains/chat/components/mobile-app-overlay.js";
import { MobileDocumentOverlay } from "@/domains/chat/components/mobile-document-overlay.js";
import { MobileSubagentDetailOverlay } from "@/domains/chat/components/mobile-subagent-detail-overlay.js";
import { routes } from "@/utils/routes.js";
import { haptic } from "@/utils/haptics.js";
import type { AssistantIdentity } from "@/domains/chat/api/assistant.js";
import type { ChatEventStream } from "@/domains/chat/api/stream.js";
import {
  ChatRouteContent,
  type ChatRouteContentProps,
} from "@/domains/chat/components/chat-route-content.js";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ChatPage() {
  const authLoading = useAuthStore.use.isLoading();
  const isLoggedIn = useAuthStore.use.isLoggedIn();
  const isMobile = useIsMobile();
  const isNative = useIsNativePlatform();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { conversationKey: urlConversationKey } = useParams<{ conversationKey?: string }>();
  const {
    assistantId,
    assistantState,
    checkAssistant,
    setAssistantId,
    setTopBarCenter,
    setTopBarRightSlot,
    setOnSearchClick,
  } = useAssistantContext();
  const chatPullToRefresh = useFeatureFlagStore.use.chatPullToRefresh();
  const deployToVercel = useFeatureFlagStore.use.deployToVercel();
  const doctor = useFeatureFlagStore.use.doctor();
  const conversationGroupsUI = useFeatureFlagStore.use.conversationGroupsUI();

  // -------------------------------------------------------------------------
  // Local state
  // -------------------------------------------------------------------------
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState("");
  const [error, setError] = useState<ChatError | null>(null);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [compactionCircuitOpenUntil, setCompactionCircuitOpenUntil] = useState<Date | null>(null);
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [showAddCreditsModal, setShowAddCreditsModal] = useState(false);
  void showAddCreditsModal;
  const [restoredDraftConversationKey, setRestoredDraftConversationKey] = useState<string | null>(null);
  const [refreshEpoch, setRefreshEpoch] = useState(0);
  const [streamRetryNonce, setStreamRetryNonce] = useState(0);
  const [_autoGreetPending, setAutoGreetPending] = useState(false);
  const [contextWindowUsage, setContextWindowUsage] = useState<ContextWindowUsage | null>(null);
  const [transcriptPagination, setTranscriptPagination] = useState<Omit<TranscriptPaginationState, "items">>({
    hasMore: false,
    oldestTimestamp: null,
    isLoadingOlder: false,
    isPinnedToLatest: true,
  });
  const [assetsRefreshKey, setAssetsRefreshKey] = useState(0);
  const [assistantIdentity, setAssistantIdentity] = useState<AssistantIdentity | null>(null);
  const prePinGroupIdsRef = useRef<Map<string, string | undefined>>(new Map());

  // -------------------------------------------------------------------------
  // Conversation list / groups (server state via TanStack Query)
  // -------------------------------------------------------------------------
  const isAssistantActive = assistantState.kind === "active";
  const { conversations } = useConversationListQuery(
    assistantId,
    isAssistantActive,
  );
  const { conversationGroups } = useConversationGroupsQuery(
    assistantId,
    isAssistantActive && conversationGroupsUI,
  );

  // -------------------------------------------------------------------------
  // Zustand store selectors
  // -------------------------------------------------------------------------
  const activeConversationKey = useConversationStore.use.activeConversationKey();
  const editingConversationKey = useConversationStore.use.editingConversationKey();
  const processingKeys = useConversationStore.use.processingKeys();
  const viewerState = useViewerStore(useShallow((s) => ({
    mainView: s.mainView,
    activeAppId: s.activeAppId,
    openedAppState: s.openedAppState,
    openedDocumentState: s.openedDocumentState,
    isAppMinimized: s.isAppMinimized,
    intelligenceTab: s.intelligenceTab,
    assetsRefreshKey: s.assetsRefreshKey,
    viewBeforeDocument: s.viewBeforeDocument,
    activeSubagentId: s.activeSubagentId,
    viewBeforeSubagentDetail: s.viewBeforeSubagentDetail,
  })));
  const subagentState = useSubagentStore(useShallow((s) => ({ byId: s.byId, orderedIds: s.orderedIds })));
  const isSharing = useDeployStore.use.isSharing();
  const isDeploying = useDeployStore.use.isDeploying();
  const subagentEntries = useMemo(
    () => subagentState.orderedIds.map((id) => subagentState.byId[id]!).filter(Boolean),
    [subagentState.byId, subagentState.orderedIds],
  );

  // -------------------------------------------------------------------------
  // Shared refs — owned here, read/written by hooks
  // -------------------------------------------------------------------------
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const messagesRef = useRef<DisplayMessage[]>(messages);
  messagesRef.current = messages;

  const activeConversationKeyRef = useRef<string | null>(activeConversationKey);
  useEffect(() => { activeConversationKeyRef.current = activeConversationKey; }, [activeConversationKey]);

  const assistantIdRef = useRef<string | null>(assistantId);
  useEffect(() => { assistantIdRef.current = assistantId; }, [assistantId]);


  const streamRef = useRef<ChatEventStream | null>(null);
  const streamEpochRef = useRef(0);
  const streamContextRef = useRef<{ assistantId: string; conversationKey: string } | null>(null);
  const reconcileAfterNextStreamOpenRef = useRef(false);
  const needsNewBubbleRef = useRef(true);
  const dismissedSurfaceIdsRef = useRef<Set<string>>(new Set());
  const pendingOnboardingContextRef = useRef<PreChatOnboardingContext | null>(null);
  const onboardingDraftConversationKeyRef = useRef<string | null>(null);
  const draftKeyResolutionRef = useRef(false);
  const previousConversationKeyRef = useRef<string | null>(null);
  const pendingQueuedStableIdsRef = useRef<string[]>([]);
  const requestIdToStableIdRef = useRef<Map<string, string>>(new Map());
  const pendingLocalDeletionsRef = useRef<Set<string>>(new Set());
  const confirmationToolCallMapRef = useRef<Map<string, string>>(new Map());
  const streamingMessageIdsRef = useRef<Set<string>>(new Set());
  const lastSuggestionMsgIdRef = useRef<string | null>(null);
  const autoGreetRef = useRef(false);
  const initialPageOldestTsRef = useRef<number | null>(null);
  const isLoadingOlderRef = useRef(false);
  const historyLoadedRef = useRef(false);
  const conversationListInvalidatedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadEpochRef = useRef(0);
  const pendingInitialMessageRef = useRef<{ conversationKey: string; content: string } | null>(null);
  const expandedToolCallIdsRef = useRef<Set<string>>(new Set());
  const draftsRef = useRef<Map<string, string>>(new Map());
  const conversationCacheRef = useRef<Map<string, { messages: DisplayMessage[]; pagination: { hasMore: boolean; oldestTimestamp: number | null } }>>(new Map());
  const contextWindowUsageByConversationRef = useRef<Map<string, ContextWindowUsage>>(new Map());
  const refreshSettleRef = useRef<RefreshSettleHandle | null>(null);
  const syncRouterRef = useRef<WebSyncRouter | null>(null);

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
    enabled: assistantState.kind === "active",
  });
  const diskPressureChatBlockReason = getDiskPressureChatBlockReason({
    monitorEnabled: diskPressure.mode !== null,
    hasResolvedStatus: diskPressure.hasResolvedStatus,
    status: diskPressure.status,
  });

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
  // Voice input
  // -------------------------------------------------------------------------
  const {
    voiceInputRef,
    voiceInterim,
    voiceError,
    clearVoiceError,
    setVoiceError,
    showPrimer: _showPrimer,
    handleVoiceBeforeStart,
    handleVoiceTranscript,
    setVoiceInterim,
    handleRetryMicPermission,
  } = useVoiceInput({ assistantId, inputRef, setInput });

  // -------------------------------------------------------------------------
  // Conversation starters
  // -------------------------------------------------------------------------
  const { starters: conversationStarters } = useConversationStarters(assistantId);

  // -------------------------------------------------------------------------
  // Avatar
  // -------------------------------------------------------------------------
  const avatar = useAssistantAvatar(assistantId);

  // -------------------------------------------------------------------------
  // Nudges
  // -------------------------------------------------------------------------
  const nudges = useAppNudges(messages, conversations.length, streamingMessageIdsRef);

  // -------------------------------------------------------------------------
  // Derived state
  // -------------------------------------------------------------------------
  const activeConversation = useMemo(
    () => conversations.find((c) => c.conversationKey === activeConversationKey),
    [conversations, activeConversationKey],
  );
  const isChannelReadonly = isChannelConversation(activeConversation);

  const syncNeedsNewBubbleFromMessages = useCallback((nextMessages: DisplayMessage[]) => {
    const lastMsg = nextMessages[nextMessages.length - 1];
    needsNewBubbleRef.current = !lastMsg || lastMsg.role !== "assistant" || !lastMsg.isStreaming;
  }, []);

  // -------------------------------------------------------------------------
  // Conversation loader
  // -------------------------------------------------------------------------
  const {
    refreshConversations,
    scheduleConversationListRefetch,
    switchConversation: rawSwitchConversation,
    startNewConversation: rawStartNewConversation,
    conversationExistsOnServer,
  } = useConversationLoader({
    assistantId,
    assistantStateKind: assistantState.kind,
    activeConversationKey,
    urlConversationKey: urlConversationKey ?? null,
    searchParams,
    navigate,
    conversations,
    transcriptPagination,
    conversationGroupsUI,
    refreshEpoch,
    reachabilityReadyEpoch,
    assistantIdRef,
    conversationCacheRef,
    draftKeyResolutionRef,
    previousConversationKeyRef,
    onboardingDraftConversationKeyRef,
    activeConversationKeyRef,
    inputRef,
    draftsRef,
    messagesRef,
    contextWindowUsageByConversationRef,
    dismissedSurfaceIdsRef,
    needsNewBubbleRef,
    streamingMessageIdsRef,
    pendingQueuedStableIdsRef,
    requestIdToStableIdRef,
    pendingLocalDeletionsRef,
    confirmationToolCallMapRef,
    refreshSettleRef,
    lastSuggestionMsgIdRef,
    autoGreetRef,
    initialPageOldestTsRef,
    isLoadingOlderRef,
    historyLoadedRef,
    conversationListInvalidatedTimerRef,
    loadEpochRef,
    pendingInitialMessageRef,
    setAssistantId,
    setMessages,
    setTranscriptPagination: setTranscriptPagination as Dispatch<SetStateAction<Omit<TranscriptPaginationState, "items">>>,
    setIsLoadingHistory,
    setError,
    setAutoGreetPending,
    setContextWindowUsage,
    setSuggestion,
    setCompactionCircuitOpenUntil,
    setInput,
    resetChatAttachments,
    syncNeedsNewBubbleFromMessages,
    onDraftRestored: setRestoredDraftConversationKey,
    shouldSuppressGenericChatErrorNotice,
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
    setMessages,
    streamContextRef,
    streamEpochRef,
    activeConversationKeyRef,
    initialPageOldestTsRef,
  });

  // -------------------------------------------------------------------------
  // Assistant identity
  // -------------------------------------------------------------------------
  const refreshAssistantIdentity = useCallback(
    async (preserveOnFailure = false) => {
      const targetId = assistantIdRef.current;
      if (!targetId) return;
      const identity = await fetchAssistantIdentity(targetId);
      if (assistantIdRef.current !== targetId) return;
      if (identity === null && preserveOnFailure) return;
      setAssistantIdentity(identity);
    },
    [],
  );

  useEffect(() => {
    if (assistantState.kind !== "active" || !assistantId) return;
    void refreshAssistantIdentity();
  }, [assistantState.kind, assistantId, reachabilityReadyEpoch, refreshAssistantIdentity]);

  // -------------------------------------------------------------------------
  // Sync router
  // -------------------------------------------------------------------------
  const invalidateAvatar = useCallback(() => { avatar.invalidate(); }, [avatar.invalidate]);

  useEffect(() => {
    const syncRouter = createWebSyncRouter({
      activeConversationKeyRef,
      invalidateAvatar,
      refreshAssistantIdentity,
      invalidateAssistantConfig: () => {},
      invalidateAssistantSounds: () => {},
      invalidateAssistantSchedules: () => {},
      scheduleConversationListRefetch,
      refreshActiveConversationMessages: reconcileActiveConversation,
    });
    syncRouterRef.current = syncRouter;
    return () => {
      if (syncRouterRef.current === syncRouter) {
        syncRouterRef.current = null;
      }
      syncRouter.dispose();
    };
  }, [
    invalidateAvatar,
    refreshAssistantIdentity,
    scheduleConversationListRefetch,
    reconcileActiveConversation,
  ]);

  const dispatchSyncChanged = useCallback(
    (event: SyncChangedEvent) => { void syncRouterRef.current?.dispatchSyncChanged(event); },
    [],
  );

  // -------------------------------------------------------------------------
  // Stream event handler
  // -------------------------------------------------------------------------
  const { handleStreamEvent } = useStreamEventHandler({
    push,
    isNative,
    streamEpochRef,
    activeConversationKeyRef,
    streamContextRef,
    assistantIdRef,
    setMessages,
    messagesRef,
    needsNewBubbleRef,
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
    applyDiskPressureStatusEvent: diskPressure.applyStatusEvent,
    refreshAssistantIdentity,
    invalidateAvatar,
    dispatchSyncChanged,
    pendingQueuedStableIdsRef,
    requestIdToStableIdRef,
    pendingLocalDeletionsRef,
  });

  // -------------------------------------------------------------------------
  // Send message
  // -------------------------------------------------------------------------
  const {
    sendMessage,
    handleStopGenerating: baseHandleStopGenerating,
    queuedMessages,
    handleCancelQueuedMessage,
    handleCancelAllQueued,
    handleEditQueueTail,
  } = useSendMessage({
    assistantId,
    activeConversationKey,
    diskPressureChatBlockReason,
    messages,
    assistantIdRef,
    activeConversationKeyRef,
    messagesRef,
    streamRef,
    streamContextRef,
    streamEpochRef,
    needsNewBubbleRef,
    dismissedSurfaceIdsRef,
    pendingOnboardingContextRef,
    onboardingDraftConversationKeyRef,
    draftKeyResolutionRef,
    previousConversationKeyRef,
    pendingQueuedStableIdsRef,
    requestIdToStableIdRef,
    pendingLocalDeletionsRef,
    confirmationToolCallMapRef,
    setMessages,
    setError,
    setStreamRetryNonce,
    setInput,
    startReconciliationLoop,
    cancelReconciliation,
    refreshConversations,

    navigate,
  });

  const handleStopGenerating = useCallback(async () => {
    useInteractionStore.getState().dismissQuestion();
    await baseHandleStopGenerating();
  }, [baseHandleStopGenerating]);

  // Clear question prompt when conversation changes
  useEffect(() => {
    useInteractionStore.getState().dismissQuestion();
  }, [activeConversationKey]);

  // Reset subagent state when conversation changes
  useEffect(() => {
    useSubagentStore.getState().reset();
  }, [activeConversationKey]);

  // -------------------------------------------------------------------------
  // Interaction actions
  // -------------------------------------------------------------------------
  const interactionActions = useInteractionActions({
    setMessages,
    setError,
    messagesRef,
    streamContextRef,
    activeConversationKeyRef,
    confirmationToolCallMapRef,
  });

  // -------------------------------------------------------------------------
  // Event stream (SSE lifecycle)
  // -------------------------------------------------------------------------
  useEventStream({
    assistantStateKind: assistantState.kind,
    assistantId,
    activeConversationKey,
    conversationExistsOnServer,
    streamRef,
    streamEpochRef,
    reconcileAfterNextStreamOpenRef,
    streamContextRef,
    handleStreamEvent,
    reconcileActiveConversation,
    startReconciliationLoop,
    cancelReconciliation,
    reachabilityProbe: reachability.probe,
    reachabilityPhase: reachability.state.phase,
    reachabilityReset: reachability.reset,
    setMessages,
    setError,
    streamRetryNonce,
    setStreamRetryNonce,
    refreshEpoch,
    syncRouterRef,
    conversationListInvalidatedTimerRef,
    isLoggedIn,
    isLoading: authLoading,
    checkAssistant,
  });

  // -------------------------------------------------------------------------
  // Sync chat store (for deeply-nested components that read via context)
  // -------------------------------------------------------------------------
  useSyncChatStore({
    messages,
    activeConversationKey,
    assistantId,
    sendMessage,
  });

  // -------------------------------------------------------------------------
  // Sync assistant identity to the global store (read by ChatLayout)
  // -------------------------------------------------------------------------
  useEffect(() => {
    // Identity is hoisted to the layout via `useAssistantIdentityInit`
    // (LUM-1747) so the sidebar keeps the correct name on sibling
    // routes (Library, Identity, Contacts). ChatPage still writes
    // when it has fresher local state (e.g. after an SSE
    // `identity_changed` refresh), and only when non-null — clearing
    // on assistant context change (tenant switch, logout) is owned
    // by `useAssistantIdentityInit`, not by route transitions.
    if (assistantIdentity) {
      useAssistantIdentityStore.getState().setIdentity(
        assistantIdentity.name ?? null,
        assistantIdentity.version ?? null,
      );
    }
  }, [assistantIdentity]);

  // -------------------------------------------------------------------------
  // Conversation actions (archive, pin, rename, etc.)
  // -------------------------------------------------------------------------
  const {
    handleArchiveConversation,
    handleUnarchiveConversation,
    handleMarkConversationUnread,
    handleMarkConversationRead,
    handleTogglePinConversation,
    handleMoveToGroup,
    handleRemoveFromGroup,
    handleRenameConversation,
  } = useConversationActions({
    assistantId,
    activeConversationKey,
    conversations,
    refreshConversations,
    switchConversation,
    startNewConversation,
    prePinGroupIdsRef,
  });

  const {
    handleForkConversation,
    handleForkConversationFromMenu,
    handleAnalyzeConversation,
    handleOpenInNewWindow,
    handleInspectConversation,
    handleCopyConversation,
  } = useConversationSecondaryActions({
    assistantId,
    activeConversationKey,
    activeConversation: activeConversation ?? null,
    assistantIdentityName: assistantIdentity?.name ?? undefined,
    messagesRef,
    refreshConversations,
    switchConversation,
    setError,
    navigateToConversation,
    navigate,
  });

  // -------------------------------------------------------------------------
  // Command palette
  // -------------------------------------------------------------------------
  const navigateToSettings = useCallback(() => {
    void navigate(routes.settings.root);
  }, [navigate]);

  const { commandPalette, mergedSections, handleItemSelect } =
    useCommandPaletteSections({
      assistantId,
      assistantName: assistantIdentity?.name ?? undefined,
      conversations,
      activeConversationKey: activeConversationKey ?? undefined,
      startNewConversation: () => startNewConversation(),
      switchConversation,
      navigate: (to: string | number) => {
        if (typeof to === "number") navigate(to);
        else void navigate(to);
      },
      navigateToSettings,
    });

  // Guard: command palette should only be togglable once the page is fully loaded
  const isPageReady = !authLoading && assistantState.kind !== "loading" && assistantState.kind !== "error";

  // Ctrl/Cmd+K shortcut for command palette
  useEffect(() => {
    if (!isPageReady) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!shouldHandleShortcut(event, document.activeElement, "k")) return;
      event.preventDefault();
      commandPalette.toggle();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => { window.removeEventListener("keydown", onKeyDown); };
  }, [commandPalette.toggle, isPageReady]);

  // Register command palette toggle as the search callback for the layout
  useEffect(() => {
    if (!isPageReady) return;
    setOnSearchClick(commandPalette.toggle);
    return () => { setOnSearchClick(null); };
  }, [commandPalette.toggle, setOnSearchClick, isPageReady]);

  // -------------------------------------------------------------------------
  // Layout header slot registration — topBarCenter + topBarRightSlot
  // -------------------------------------------------------------------------
  const hasPersistedMessage = useMemo(
    () => messages.some((m) => m.daemonMessageId != null || m.id != null),
    [messages],
  );

  const topBarCenterContent = useMemo(() => {
    if (!activeConversation) {
      return assistantId ? (
        <span className="text-sm font-medium text-[var(--content-default)]">
          New conversation
        </span>
      ) : null;
    }
    const moveToGroups = buildMoveToGroupTargets(activeConversation, conversationGroups);
    const isPinned = activeConversation.isPinned || activeConversation.groupId === "system:pinned";
    const isArchived = activeConversation.archivedAt != null;
    return (
      <ConversationActionsMenu
        variant="header"
        isPinned={isPinned}
        isArchived={isArchived}
        isReadonly={isChannelReadonly}
        onPinToggle={() => handleTogglePinConversation(activeConversation)}
        onRename={() => handleRenameConversation(activeConversation)}
        onArchive={() => handleArchiveConversation(activeConversation)}
        onUnarchive={() => handleUnarchiveConversation(activeConversation)}
        onAnalyze={
          !isChannelReadonly && activeConversation.conversationKey
            ? () => handleAnalyzeConversation(activeConversation)
            : undefined
        }
        onForkConversation={
          !isChannelReadonly && hasPersistedMessage
            ? handleForkConversationFromMenu
            : undefined
        }
        onOpenInNewWindow={
          activeConversation.conversationKey
            ? () => handleOpenInNewWindow(activeConversation)
            : undefined
        }
        onInspect={
          activeConversation.conversationKey
            ? () => handleInspectConversation(activeConversation)
            : undefined
        }
        onCopyConversation={
          messages.length > 0
            ? handleCopyConversation
            : undefined
        }
        moveToGroups={moveToGroups}
        onMoveToGroup={(groupId) => handleMoveToGroup(activeConversation, groupId)}
        onRemoveFromGroup={
          activeConversation.groupId && !activeConversation.groupId.startsWith("system:")
            ? () => handleRemoveFromGroup(activeConversation)
            : undefined
        }
        onMarkUnread={
          !isChannelReadonly && activeConversation.hasUnseenLatestAssistantMessage === false
            ? () => handleMarkConversationUnread(activeConversation)
            : undefined
        }
        onMarkRead={
          activeConversation.hasUnseenLatestAssistantMessage
            ? () => handleMarkConversationRead(activeConversation)
            : undefined
        }
        side="bottom"
        align="center"
        sideOffset={8}
        trigger={
          <Button
            variant="ghost"
            rightIcon={<ChevronDown />}
            aria-haspopup="menu"
            className="min-w-0"
          >
            <span className="min-w-0 max-w-[240px] truncate">
              {isArchived && (
                <span className="mr-1 text-[var(--content-tertiary)]">
                  [Archived]
                </span>
              )}
              {activeConversation.title ?? "Untitled"}
            </span>
          </Button>
        }
      />
    );
  }, [
    activeConversation,
    assistantId,
    isChannelReadonly,
    conversationGroups,
    handleTogglePinConversation,
    handleRenameConversation,
    handleArchiveConversation,
    handleUnarchiveConversation,
    handleAnalyzeConversation,
    handleForkConversationFromMenu,
    handleOpenInNewWindow,
    handleInspectConversation,
    handleCopyConversation,
    handleMoveToGroup,
    handleRemoveFromGroup,
    handleMarkConversationUnread,
    handleMarkConversationRead,
    hasPersistedMessage,
    messages.length,
  ]);

  useEffect(() => {
    setTopBarCenter(topBarCenterContent);
    return () => { setTopBarCenter(null); };
  }, [topBarCenterContent, setTopBarCenter]);

  const topBarRightContent = useMemo(() => {
    if (!activeConversation?.conversationKey || !assistantId) return null;
    return (
      <ConversationAssetsPill
        assistantId={assistantId}
        conversationId={activeConversation.conversationKey}
        refreshKey={assetsRefreshKey}
        onOpenApp={(appId) => {
          haptic.light();
          useViewerStore.getState().openApp(appId);
        }}
        onOpenDocument={() => {
          haptic.light();
          useViewerStore.getState().openDocument();
        }}
      />
    );
  }, [activeConversation?.conversationKey, assistantId, assetsRefreshKey]);

  useEffect(() => {
    setTopBarRightSlot(topBarRightContent);
    return () => { setTopBarRightSlot(null); };
  }, [topBarRightContent, setTopBarRightSlot]);

  // -------------------------------------------------------------------------
  // Derived UI state
  // -------------------------------------------------------------------------
  const hasUncompletedVisibleSurface = useMemo(() => {
    for (const msg of messages) {
      if (msg.surfaces) {
        for (const s of msg.surfaces) {
          if (isSurfaceInteractive(s)) return true;
        }
      }
    }
    return false;
  }, [messages]);

  const activeConversationIsProcessing = activeConversationKey != null && processingKeys.has(activeConversationKey);
  const activeConversationHasPendingAssistantResponse = useMemo(
    () => hasPendingAssistantResponse(messages),
    [messages],
  );

  const pendingSecret = useInteractionStore.use.pendingSecret();
  const pendingConfirmation = useInteractionStore.use.pendingConfirmation();

  const _uiContext: UIContext = {
    hasStreamingAssistantMessage: messages.some((m) => m.isStreaming),
    hasPendingSecret: !!pendingSecret,
    hasPendingConfirmation: !!pendingConfirmation,
    hasUncompletedVisibleSurface,
    activeConversationIsProcessing,
    hasPendingAssistantResponse: activeConversationHasPendingAssistantResponse,
  };
  void _uiContext;

  // -------------------------------------------------------------------------
  // Loading / error guards
  // -------------------------------------------------------------------------
  if (authLoading || assistantState.kind === "loading") {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-[var(--text-secondary)]">Connecting…</p>
      </div>
    );
  }

  if (assistantState.kind === "error") {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center">
        <p className="text-[var(--text-secondary)]">{assistantState.message}</p>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Props assembly
  // -------------------------------------------------------------------------
  const handleReviewDiskUsage = () => {
    haptic.light();
    useViewerStore.getState().setIntelligenceTab("workspace");
    void navigate(routes.identity);
  };

  const pushToAiSettings = () => { void navigate(routes.settings.ai); };

  const chatRouteProps: ChatRouteContentProps = {
    assistantId,
    assistantState,
    assistantIdentity,
    chatPullToRefresh,
    deployToVercel,
    doctor,
    isMobile,
    isKeyboardOpen: false,
    messages,
    setMessages,
    input,
    setInput,
    error,
    setError,
    isLoadingHistory,
    conversations,
    activeConversationKey,
    activeConversation,
    processingKeys,
    mainView: viewerState.mainView,
    openedAppState: viewerState.openedAppState,
    openedDocumentState: viewerState.openedDocumentState,
    editingConversationKey,
    restoredDraftConversationKey,
    setRestoredDraftConversationKey,
    avatar: {
      avatarComponents: avatar.components,
      avatarTraits: avatar.traits,
      avatarImageUrl: avatar.customImageUrl,
    },
    conversationStarters,
    contextWindowUsage,
    compactionCircuitOpenUntil,
    setCompactionCircuitOpenUntil,
    suggestion,
    setSuggestion,
    transcriptPagination,
    setTranscriptPagination: setTranscriptPagination as Dispatch<SetStateAction<Omit<TranscriptPaginationState, "items">>>,
    setShowAddCreditsModal,
    diskPressure: {
      status: diskPressure.status,
      mode: diskPressure.mode,
      diskPressureMonitorEnabled: diskPressure.mode !== null,
      hasResolvedDiskPressureStatus: diskPressure.hasResolvedStatus,
      isAcknowledgingDiskPressure: diskPressure.isAcknowledging,
      diskPressureAcknowledgeError: diskPressure.acknowledgeError,
      acknowledgeDiskPressure: diskPressure.acknowledge,
    },
    handleReviewDiskUsage,
    nudges: {
      isOnIOS: nudges.isOnIOS,
      showBanner: nudges.showBanner,
      nudge: {
        handleDownload: nudges.nudge.handleDownload,
        handleBannerDismiss: nudges.nudge.handleBannerDismiss,
      },
      githubNudge: {
        handleStar: nudges.githubNudge.handleStar,
        handleBannerDismiss: nudges.githubNudge.handleBannerDismiss,
      },
      showGitHubBanner: nudges.showGitHubBanner,
      discordNudge: {
        handleJoin: nudges.discordNudge.handleJoin,
        handleBannerDismiss: nudges.discordNudge.handleBannerDismiss,
      },
      showDiscordBanner: nudges.showDiscordBanner,
    },
    attachments: {
      chatAttachments,
      attachmentsUploadingCount,
      attachmentUploadedIds,
      attachmentLastError,
      addChatAttachmentFiles,
      removeChatAttachment,
      resetChatAttachments,
      dismissChatAttachmentError,
    },
    voice: {
      voiceInputRef,
      voiceInterim,
      voiceError,
      clearVoiceError,
      setVoiceError,
      handleVoiceBeforeStart,
      handleVoiceTranscript,
      setVoiceInterim,
      handleRetryMicPermission,
    },
    send: {
      sendMessage,
      handleStopGenerating,
      queuedMessages,
      handleCancelQueuedMessage,
      handleCancelAllQueued,
      handleEditQueueTail,
    },
    interactionActions: {
      handleSecretSubmit: interactionActions.handleSecretSubmit,
      handleSecretCancel: interactionActions.handleSecretCancel,
      handleContactPromptSubmit: interactionActions.handleContactPromptSubmit,
      handleContactPromptCancel: interactionActions.handleContactPromptCancel,
      handleConfirmationSubmit: interactionActions.handleConfirmationSubmit,
      handleAllowAndCreateRule: interactionActions.handleAllowAndCreateRule,
      handleOpenRuleEditorForToolCall: interactionActions.handleOpenRuleEditorForToolCall,
      handleQuestionResponse: interactionActions.handleQuestionResponse,
      handleSurfaceAction: interactionActions.handleSurfaceAction,
      unknownNudgeToolCallIds: interactionActions.unknownNudgeToolCallIds,
      setUnknownNudgeToolCallIds: interactionActions.setUnknownNudgeToolCallIds,
    },
    handleOpenApp: (appId: string) => {
      haptic.light();
      useViewerStore.getState().openApp(appId);
    },
    handleOpenDocument: (_surfaceId: string) => {
      haptic.light();
      useViewerStore.getState().openDocument();
    },
    handleCloseDocument: () => {
      useViewerStore.getState().closeDocument();
    },
    handleCloseApp: () => {
      useViewerStore.getState().closeApp();
      useViewerStore.getState().setMainView("chat");
    },
    handleCloseEditPanel: () => {
      useViewerStore.getState().exitAppEditing();
    },
    handleShareApp: () => {
      useDeployStore.getState().startSharing();
    },
    handleDeployApp: deployToVercel ? () => {
      useDeployStore.getState().startDeploying();
    } : undefined,
    handleForkConversation,
    subagentEntries,
    subagentState,
    activeSubagentId: viewerState.activeSubagentId,
    onSubagentClick: (id: string) => { useViewerStore.getState().openSubagentDetail(id); },
    onCloseSubagentDetail: () => { useViewerStore.getState().closeSubagentDetail(); },
    onStopSubagent: async (subagentId: string) => {
      if (!assistantId || !activeConversationKey) return;
      try {
        await abortSubagent(assistantId, activeConversationKey, subagentId);
      } catch {
        // Best-effort — the daemon may have already completed
      }
    },
    onRequestSubagentDetail: async () => {},
    pushToAiSettings,
    checkAssistant,
    setRefreshEpoch,
    streamRetryNonce,
    refs: {
      inputRef,
      messagesRef,
      activeConversationKeyRef,
      assistantIdRef,
      streamContextRef,
      expandedToolCallIdsRef,
      draftsRef,
      conversationCacheRef,
      dismissedSurfaceIdsRef,
      isLoadingOlderRef,
      initialPageOldestTsRef,
      contextWindowUsageByConversationRef,
      refreshSettleRef,
      streamRef,
      streamEpochRef,
      historyLoadedRef,
      pendingQueuedStableIdsRef,
      requestIdToStableIdRef,
      pendingLocalDeletionsRef,
      confirmationToolCallMapRef,
      reconcileAfterNextStreamOpenRef,
    },
    isChannelReadonly,
  };

  // -------------------------------------------------------------------------
  // Mobile overlay portal — resolve after DOM commit (CONVENTIONS.md §SSR)
  // -------------------------------------------------------------------------
  const [overlayTarget, setOverlayTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setOverlayTarget(
      isMobile ? document.getElementById("viewport-overlays") : null,
    );
  }, [isMobile]);

  return (
    <>
      <ChatRouteContent {...chatRouteProps} />
      <CommandPalette
        isOpen={commandPalette.isOpen}
        onClose={commandPalette.close}
        query={commandPalette.query}
        onQueryChange={commandPalette.setQuery}
        selectedIndex={commandPalette.selectedIndex}
        sections={mergedSections}
        isSearching={commandPalette.isSearching}
        onItemSelect={handleItemSelect}
        onKeyDown={commandPalette.handleKeyDown}
      />
      {overlayTarget &&
        createPortal(
          <>
            <MobileAppOverlay
              openedAppState={
                viewerState.mainView === "app" ? viewerState.openedAppState : null
              }
              isAppMinimized={viewerState.isAppMinimized}
              assistantId={assistantId}
              onToggleMinimized={() => {
                useViewerStore.getState().toggleAppMinimized();
              }}
              onClose={() => {
                useViewerStore.getState().closeApp();
                useViewerStore.getState().setMainView("chat");
              }}
              onShare={() => {
                useDeployStore.getState().startSharing();
              }}
              isSharing={isSharing}
              onDeploy={
                deployToVercel
                  ? () => {
                      useDeployStore.getState().startDeploying();
                    }
                  : undefined
              }
              isDeploying={isDeploying}
            />
            <MobileDocumentOverlay
              openedDocumentState={
                viewerState.mainView === "document"
                  ? viewerState.openedDocumentState
                  : null
              }
              assistantId={assistantId}
              onClose={() => {
                useViewerStore.getState().closeDocument();
              }}
            />
            <MobileSubagentDetailOverlay
              entry={
                viewerState.mainView === "subagent-detail" &&
                viewerState.activeSubagentId
                  ? subagentState.byId[viewerState.activeSubagentId] ?? null
                  : null
              }
              onClose={() => {
                useViewerStore.getState().closeSubagentDetail();
              }}
              onStop={async (subagentId: string) => {
                if (!assistantId || !activeConversationKey) return;
                try {
                  await abortSubagent(assistantId, activeConversationKey, subagentId);
                } catch {
                  // Best-effort — the daemon may have already completed
                }
              }}
              onRequestDetail={async () => {}}
            />
          </>,
          overlayTarget,
        )}
    </>
  );
}
