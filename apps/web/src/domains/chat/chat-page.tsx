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
import { useNavigate, useSearchParams } from "react-router";

import { useIsMobile } from "@/hooks/use-is-mobile.js";
import { useAuthStore } from "@/stores/auth-store.js";
import { useAssistantContext } from "@/domains/chat/assistant-context.js";
import { useShallow } from "zustand/shallow";
import { useConversationListStore } from "@/domains/conversations/conversation-list-store.js";
import { useViewerStore } from "@/stores/viewer-store.js";
import { useSubagentStore } from "@/domains/subagents/subagent-store.js";
import { useInteractionStore } from "@/domains/interactions/interaction-store.js";
import { useAppFeatureFlags } from "@/lib/feature-flags/app.js";
import { useIsNativePlatform } from "@/runtime/native-auth.js";

import type { DisplayMessage } from "@/domains/chat/lib/reconcile.js";
import type { ChatEventStream, AssistantIdentity } from "@/domains/chat/lib/api.js";
import type { ChatError } from "@/domains/chat/types.js";
import type { ContextWindowUsage } from "@/domains/chat/components/context-window-indicator.js";
import type { TranscriptPaginationState } from "@/domains/chat/lib/transcript/types.js";
import type { PreChatOnboardingContext } from "@/lib/onboarding/prechat.js";
import type { WebSyncRouter } from "@/lib/sync/web-sync-router.js";
import type { RefreshSettleHandle } from "@/domains/chat/hooks/use-pull-refresh.js";
import type { SyncChangedEvent } from "@/lib/sync/types.js";

import { useSyncChatStore } from "@/domains/chat/chat-store.js";
import { useChatAttachments } from "@/domains/chat/components/chat-attachments/use-chat-attachments.js";
import { useVoiceInput } from "@/domains/chat/hooks/use-voice-input.js";
import { useConversationStarters } from "@/domains/chat/lib/use-conversation-starters.js";
import { useAssistantAvatar } from "@/domains/avatar/use-assistant-avatar.js";
import { useAssistantReachability } from "@/domains/assistant/use-assistant-reachability.js";
import { useDiskPressureMonitor } from "@/domains/assistant/use-disk-pressure-monitor.js";
import { getDiskPressureChatBlockReason } from "@/domains/assistant/disk-pressure.js";
import { useAppNudges } from "@/domains/chat/hooks/use-app-nudges.js";
import { useConversationLoader } from "@/domains/chat/hooks/use-conversation-loader.js";
import { useMessageReconciliation } from "@/domains/chat/lib/use-message-reconciliation.js";
import { useStreamEventHandler } from "@/domains/chat/hooks/use-stream-event-handler.js";
import { useSendMessage } from "@/domains/chat/hooks/use-send-message.js";
import { useInteractionActions } from "@/domains/chat/hooks/use-interaction-actions.js";
import { useEventStream } from "@/domains/chat/hooks/use-event-stream.js";

import { createWebSyncRouter } from "@/lib/sync/web-sync-router.js";
import { fetchAssistantIdentity } from "@/domains/chat/lib/assistant.js";
import { shouldSuppressGenericChatErrorNotice } from "@/domains/chat/lib/error-classification.js";
import { hasPendingAssistantResponse } from "@/domains/chat/utils/chat-utils.js";
import { isSurfaceInteractive } from "@/domains/chat/lib/types.js";
import type { UIContext } from "@/domains/chat/lib/turn-selectors.js";
import { isChannelConversation } from "@/domains/chat/lib/conversation-channel.js";
import { abortSubagent } from "@/domains/chat/lib/conversations.js";
import { routes } from "@/utils/routes.js";
import { haptic } from "@/utils/haptics.js";
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
  const { assistantId, assistantState, checkAssistant, setAssistantId } = useAssistantContext();
  const {
    chatPullToRefresh,
    deployToVercel,
    doctor,
    conversationGroupsUI,
  } = useAppFeatureFlags();

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
  void assetsRefreshKey;
  const [assistantIdentity, setAssistantIdentity] = useState<AssistantIdentity | null>(null);

  // -------------------------------------------------------------------------
  // Zustand store selectors
  // -------------------------------------------------------------------------
  const conversations = useConversationListStore.use.conversations();
  const activeConversationKey = useConversationListStore.use.activeConversationKey();
  const editingConversationKey = useConversationListStore.use.editingConversationKey();
  const processingKeys = useConversationListStore.use.processingKeys();
  const attentionKeys = useConversationListStore.use.attentionKeys();
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
    isSharing: s.isSharing,
    isDeploying: s.isDeploying,
    isTokenDialogOpen: s.isTokenDialogOpen,
    pendingDeployAppId: s.pendingDeployAppId,
    complexDeployApp: s.complexDeployApp,
  })));
  const subagentState = useSubagentStore(useShallow((s) => ({ byId: s.byId, orderedIds: s.orderedIds })));
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

  const conversationsRef = useRef<typeof conversations>(conversations);
  conversationsRef.current = conversations;

  const streamRef = useRef<ChatEventStream | null>(null);
  const streamEpochRef = useRef(0);
  const streamContextRef = useRef<{ assistantId: string; conversationKey: string } | null>(null);
  const reconcileAfterNextStreamOpenRef = useRef(false);
  const needsNewBubbleRef = useRef(true);
  const processingSnapshotsRef = useRef<Map<string, string | undefined>>(new Map());
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
  // Routing adapters
  // -------------------------------------------------------------------------
  const pushRoute = useCallback(
    (url: string) => { void navigate(url); },
    [navigate],
  );
  const replaceUrl = useCallback(
    (url: string) => { void navigate(url, { replace: true }); },
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
    handleVoiceRecordingChange,
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
    searchParams,
    pushRoute,
    conversations,
    activeConversation,
    processingKeys,
    attentionKeys,
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
    conversationsRef,
    contextWindowUsageByConversationRef,
    dismissedSurfaceIdsRef,
    needsNewBubbleRef,
    streamingMessageIdsRef,
    pendingQueuedStableIdsRef,
    requestIdToStableIdRef,
    pendingLocalDeletionsRef,
    confirmationToolCallMapRef,
    processingSnapshotsRef,
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
  void switchConversation;
  const startNewConversation = useCallback(
    (opts: { silent?: boolean; initialMessage?: string } = {}) => {
      useSubagentStore.getState().reset();
      rawStartNewConversation(opts);
    },
    [rawStartNewConversation],
  );
  void startNewConversation;

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
    push: pushRoute,
    isNative,
    streamEpochRef,
    activeConversationKeyRef,
    streamContextRef,
    assistantIdRef,
    setMessages,
    messagesRef,
    needsNewBubbleRef,
    processingSnapshotsRef,
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
    conversationsRef,
    streamRef,
    streamContextRef,
    streamEpochRef,
    needsNewBubbleRef,
    processingSnapshotsRef,
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

    replaceUrl,
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
    processingSnapshotsRef,
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

  const handleForkConversation = async (_throughMessageId: string) => {
    // Fork is not yet implemented in the OSS app
  };

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
    viewerState,
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
      handleVoiceRecordingChange,
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
      useViewerStore.getState().startSharing();
    },
    handleDeployApp: deployToVercel ? () => {
      useViewerStore.getState().startDeploying();
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
      processingSnapshotsRef,
      historyLoadedRef,
      pendingQueuedStableIdsRef,
      requestIdToStableIdRef,
      pendingLocalDeletionsRef,
      confirmationToolCallMapRef,
      reconcileAfterNextStreamOpenRef,
    },
    isChannelReadonly,
  };

  return <ChatRouteContent {...chatRouteProps} />;
}
