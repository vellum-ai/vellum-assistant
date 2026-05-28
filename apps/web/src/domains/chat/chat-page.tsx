/**
 * ChatPage — orchestration layer for the chat route.
 *
 * Owns the shared refs and state that multiple hooks read/write, calls each
 * hook in dependency order, and maps their outputs to `ChatRouteContent` props.
 */

import {
  type Dispatch,
  type SetStateAction,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { ChevronDown } from "lucide-react";
import * as Sentry from "@sentry/react";

import { useIsMobile } from "@/hooks/use-is-mobile";
import { useAuthStore } from "@/stores/auth-store";
import { useAssistantContext } from "@/components/layout/assistant-context";
import { useConversationStore } from "@/stores/conversation-store";
import {
  COMPOSER_FOCUS_EVENT,
  consumePendingComposerFocus,
  insertTextAtSelection,
  requestComposerFocus,
  shouldFocusComposerForTyping,
} from "./composer-focus";
import {
  useConversationGroupsQuery,
  useConversationListQuery,
} from "@/domains/conversations/conversation-queries";
import { useViewerStore } from "@/stores/viewer-store";
import { useDeployStore } from "@/stores/deploy-store";
import { useSubagentStore, type SubagentTimelineEvent } from "@/domains/subagents/subagent-store";
import type { SubagentStatus } from "@/domains/chat/api/event-types";
import { useInteractionStore } from "@/domains/interactions/interaction-store";
import { useClientFeatureFlagStore } from "@/lib/feature-flags/client-feature-flag-store";
import { useAssistantFeatureFlagStore } from "@/lib/feature-flags/assistant-feature-flag-store";
import { useIsNativePlatform } from "@/runtime/native-auth";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

import type { DisplayMessage } from "@/domains/chat/utils/reconcile";
import type { ChatError } from "@/domains/chat/types";
import type { ContextWindowUsage } from "@/domains/chat/components/context-window-indicator";
import type { TranscriptHandle } from "@/domains/chat/transcript/transcript";
import type { TranscriptItem } from "@/domains/chat/transcript/types";
import type { TranscriptPaginationState } from "@/domains/chat/transcript/types";
import { type UIContext } from "@/domains/messaging/turn-selectors";
import { peekPendingPreChatContext, type PreChatOnboardingContext } from "@/domains/onboarding/prechat";
import { createDraftConversationId } from "@/domains/chat/utils/conversation-selection";
import type { WebSyncRouter } from "@/lib/sync/web-sync-router";
import type { SyncChangedEvent } from "@/lib/sync/types";

import { Button } from "@vellum/design-library";
import { LazyBoundary } from "@/components/lazy-boundary";
import { useSyncChatStore } from "@/domains/chat/chat-store";
import { useChatAttachments } from "@/domains/chat/components/chat-attachments/use-chat-attachments";
import { useVoiceInput } from "@/domains/chat/hooks/use-voice-input";
import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";
import { useAssistantReachability } from "@/assistant/use-assistant-reachability";
import { useDiskPressureMonitor } from "@/assistant/use-disk-pressure-monitor";
import { getDiskPressureChatBlockReason } from "@/assistant/disk-pressure";
import { useAppNudges } from "@/domains/chat/hooks/use-app-nudges";
import { useConversationLoader } from "@/domains/conversations/use-conversation-loader";
import { useMobileOverlayTarget } from "@/domains/chat/hooks/use-mobile-overlay-target";
import { useContextWindowUsageHydration } from "@/domains/chat/hooks/use-context-window-usage-hydration";
import { useConversationActions } from "@/domains/conversations/use-conversation-actions";
import { RenameConversationDialog } from "@/domains/conversations/rename-conversation-dialog";
import { useConversationSecondaryActions } from "@/domains/chat/hooks/use-conversation-secondary-actions";
import { canUseLlmInspector } from "@/domains/chat/inspector/access";
import { useCommandPaletteSections } from "@/domains/chat/hooks/use-command-palette-sections";
import { useMessageReconciliation } from "@/domains/chat/hooks/use-message-reconciliation";
import { useStreamEventHandler } from "@/domains/chat/hooks/use-stream-event-handler";
import { useSendMessage } from "@/domains/chat/hooks/use-send-message";
import { useInteractionActions } from "@/domains/chat/hooks/use-interaction-actions";
import { useEventStream } from "@/domains/chat/hooks/use-event-stream";
import { useActiveAppPinSync } from "@/domains/chat/hooks/use-active-app-pin-sync";
import { useDraftInput } from "@/domains/chat/components/chat-composer/use-draft-input";
import { useRefreshLatestMessages } from "@/domains/chat/hooks/use-refresh-latest-messages";
import { useChatDebugApi } from "@/domains/chat/utils/debug-api";

import { SetupScreen } from "@/domains/chat/components/setup-screen";
import { CleanupScreen } from "@/domains/chat/components/cleanup-screen";
import { PlatformHostedScreen } from "@/domains/chat/components/platform-hosted-screen";
import { SelfHostedScreen } from "@/domains/chat/components/self-hosted-screen";
import { VersionSelectionScreen } from "@/domains/chat/components/version-selection-screen";
import { ConnectingToAssistant } from "@/domains/chat/components/connecting-to-assistant";
import { useGhostTextSuggestion } from "@/domains/chat/hooks/use-ghost-text-suggestion";
import { createWebSyncRouter } from "@/lib/sync/web-sync-router";
import { assistantIdentityQueryKey } from "@/hooks/use-assistant-identity-init";
import { useQueryClient } from "@tanstack/react-query";
import { shouldSuppressGenericChatErrorNotice } from "@/domains/chat/utils/error-classification";
import { hasPendingAssistantResponse } from "@/domains/chat/utils/chat-utils";
import { isSurfaceInteractive } from "@/domains/chat/types/types";
import { useTurnStore } from "@/domains/messaging/turn-store";
import { isChannelConversation } from "@/domains/chat/utils/conversation-channel";
import { buildMoveToGroupTargets } from "@/domains/chat/utils/group-conversations";
import { ConversationActionsMenu } from "@/domains/chat/components/conversation-actions-menu";
import { ConversationAssetsPill } from "@/domains/chat/components/conversation-assets-pill";
const AddCreditsModal = lazy(() =>
  import("@/components/add-credits-modal").then((m) => ({
    default: m.AddCreditsModal,
  })),
);
// Deploy dialogs (VercelTokenDialog + complex-deploy confirm) are only shown
// during the deploy flow. CommandPalette only renders on Cmd+K / Ctrl+K. Defer
// loading to keep their form/list deps out of the chat-critical bundle.
const DeployDialogs = lazy(() =>
  import("@/components/deploy-dialogs").then((m) => ({
    default: m.DeployDialogs,
  })),
);
const CommandPalette = lazy(() =>
  import("@/components/command-palette/command-palette").then((m) => ({
    default: m.CommandPalette,
  })),
);
import { shouldHandleShortcut } from "@/domains/chat/chat-layout";
import { subagentsByIdAbortPost } from "@/generated/daemon/sdk.gen";
import { fetchSubagentDetail } from "@/utils/fetch-subagent-detail";
import { MobileAppOverlay } from "@/domains/chat/components/mobile-app-overlay";
import { MobileDocumentOverlay } from "@/domains/chat/components/mobile-document-overlay";
import { MobileSubagentDetailOverlay } from "@/domains/chat/components/mobile-subagent-detail-overlay";
import { MobileToolDetailOverlay } from "@/domains/chat/components/mobile-tool-detail-overlay";
import {
  type ChatConnectingReason,
  resolveChatConnectingReason,
} from "@/domains/chat/utils/connecting-reason";
import { getEditChatConversationId, setEditChatConversationId } from "@/domains/chat/utils/edit-chat-session";
import { routes } from "@/utils/routes";
import { haptic } from "@/utils/haptics";
import type { ChatEventStream } from "@/domains/chat/api/stream";
import {
  ChatRouteContent,
  type ChatRouteContentProps,
} from "@/domains/chat/components/chat-route-content";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ChatPage() {
  const authLoading = useAuthStore.use.isLoading();
  const authUser = useAuthStore.use.user();
  const showLlmInspector = canUseLlmInspector(authUser);
  const isMobile = useIsMobile();
  const isNative = useIsNativePlatform();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { conversationId: urlConversationId } = useParams<{ conversationId?: string }>();
  const {
    assistantId,
    assistantState,
    checkAssistant,
    retryAssistant,
    hatchVersion,
    setTopBarCenter,
    setTopBarRightSlot,
    setOnSearchClick,
  } = useAssistantContext();
  const chatPullToRefreshEnabled = useClientFeatureFlagStore.use.chatPullToRefreshEnabled();
  const deployToVercel = useAssistantFeatureFlagStore.use.deployToVercel();
  const doctor = useClientFeatureFlagStore.use.doctor();
  const conversationGroupsUI = useAssistantFeatureFlagStore.use.conversationGroupsUI();
  const selfHostedChatEnabled = useClientFeatureFlagStore.use.selfHostedAssistant();

  // -------------------------------------------------------------------------
  // Local state
  // -------------------------------------------------------------------------
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [error, setError] = useState<ChatError | null>(null);
  // Seed with `true` so the chat scroll area renders the skeleton on the very
  // first frame. The conversation loader bootstrap (conversation list query →
  // `SET_ACTIVE_KEY` → `use-conversation-history`) is asynchronous, and
  // without this seed the brief window between mount and the history effect
  // dispatching `setIsLoadingHistory(true)` leaves the user staring at a
  // blank pane — none of `ChatScrollArea`'s four branches match
  // (`isLoadingHistory` false, `activeConversationId` null, no messages).
  // Set to true means "we're bootstrapping" until the history hook resolves
  // and flips it false (for both real conversations and empty drafts).
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);
  const [compactionCircuitOpenUntil, setCompactionCircuitOpenUntil] = useState<Date | null>(null);
  const [showAddCreditsModal, setShowAddCreditsModal] = useState(false);

  const [restoredDraftConversationId, setRestoredDraftConversationId] = useState<string | null>(null);
  const [refreshEpoch, setRefreshEpoch] = useState(0);
  const [autoGreetPending, setAutoGreetPending] = useState(
    () => peekPendingPreChatContext()?.initialMessage != null,
  );
  const [contextWindowUsage, setContextWindowUsage] = useState<ContextWindowUsage | null>(null);
  const [transcriptPagination, setTranscriptPagination] = useState<Omit<TranscriptPaginationState, "items">>({
    hasMore: false,
    oldestTimestamp: null,
    isLoadingOlder: false,
    isPinnedToLatest: true,
  });
  const [assetsRefreshKey, setAssetsRefreshKey] = useState(0);
  const prePinGroupIdsRef = useRef<Map<string, string | undefined>>(new Map());

  // -------------------------------------------------------------------------
  // Conversation list / groups (server state via TanStack Query)
  // -------------------------------------------------------------------------
  const isAssistantActive = assistantState.kind === "active";
  // The chat surface also renders for self-hosted assistants when the
  // `self-hosted-assistant` flag is on (see the early-return below). In that
  // mode the assistant is reachable from the API just like an active one, so
  // queries / effects that gate on "assistant can be talked to" should fire.
  const shouldRenderChat =
    isAssistantActive ||
    (assistantState.kind === "self_hosted" && selfHostedChatEnabled);
  const {
    conversations,
    isError: conversationListIsError,
    refetch: refetchConversationList,
  } = useConversationListQuery(assistantId, shouldRenderChat);
  const { conversationGroups } = useConversationGroupsQuery(
    assistantId,
    shouldRenderChat && conversationGroupsUI,
  );

  // -------------------------------------------------------------------------
  // Zustand store selectors
  // -------------------------------------------------------------------------
  const activeConversationId = useConversationStore.use.activeConversationId();
  const editingConversationId = useConversationStore.use.editingConversationId();
  const processingConversationIds = useConversationStore.use.processingConversationIds();
  const mainView = useViewerStore.use.mainView();
  const openedAppState = useViewerStore.use.openedAppState();
  const openedDocumentState = useViewerStore.use.openedDocumentState();
  const isAppMinimized = useViewerStore.use.isAppMinimized();
  const activeSubagentId = useViewerStore.use.activeSubagentId();
  const activeToolDetail = useViewerStore.use.activeToolDetail();
  const subagentById = useSubagentStore.use.byId();
  const isSharing = useDeployStore.use.isSharing();
  const isDeploying = useDeployStore.use.isDeploying();
  const isTokenDialogOpen = useDeployStore.use.isTokenDialogOpen();
  const complexDeployApp = useDeployStore.use.complexDeployApp();

  // Assistant identity is fetched and stored by `useAssistantIdentityInit`
  // at the `ChatLayout` level (TanStack Query → Zustand) so the sidebar
  // header populates on every `/assistant/*` route. ChatPage reads the
  // store via atomic selectors per `docs/STATE_MANAGEMENT.md` rather
  // than maintaining its own local copy.
  const assistantName = useAssistantIdentityStore.use.name();
  const queryClient = useQueryClient();

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
  const messagesRef = useRef<DisplayMessage[]>(messages);
  messagesRef.current = messages;
  const sanitizedMessagesRef = useRef<DisplayMessage[]>([]);
  const transcriptItemsRef = useRef<TranscriptItem[]>([]);
  // Owned here so `useChatDebugApi` (also called from this component) can
  // read scroll geometry directly via `transcriptRef.current.getScrollElement()`.
  // Threaded down to ChatRouteContent through the `refs` prop and bound on
  // the actual `<Transcript />` instance there.
  const transcriptRef = useRef<TranscriptHandle | null>(null);

  // Composer focus from the Electron host's File > Current Conversation
  // command. The command is dispatched in `chat-layout.tsx` via the
  // `useVellumCommands` hook; the textarea ref lives here, so we listen
  // for a window event rather than threading the ref upward through
  // props/context just for this one cross-cutting capability. On mount,
  // also drain any pending focus request that fired before we mounted
  // (e.g. when the command was invoked from `/assistant/home` and
  // chat-layout navigated us here) — see `./composer-focus.ts`.
  useEffect(() => {
    const focusInput = () => inputRef.current?.focus();
    const handleFocusRequest = () => {
      consumePendingComposerFocus();
      focusInput();
    };
    window.addEventListener(COMPOSER_FOCUS_EVENT, handleFocusRequest);
    if (consumePendingComposerFocus()) {
      queueMicrotask(focusInput);
    }
    return () =>
      window.removeEventListener(COMPOSER_FOCUS_EVENT, handleFocusRequest);
  }, []);


  const assistantIdRef = useRef<string | null>(assistantId);
  useEffect(() => { assistantIdRef.current = assistantId; }, [assistantId]);


  const streamRef = useRef<ChatEventStream | null>(null);
  const streamEpochRef = useRef(0);
  const streamContextRef = useRef<{ assistantId: string; conversationId: string } | null>(null);
  const reconcileAfterNextStreamOpenRef = useRef(false);
  const dismissedSurfaceIdsRef = useRef<Set<string>>(new Set());
  const pendingOnboardingContextRef = useRef<PreChatOnboardingContext | null>(null);
  const onboardingDraftConversationIdRef = useRef<string | null>(null);
  const [didOnboarding, setDidOnboarding] = useState(false);
  const [onboardingTasksEmpty, setOnboardingTasksEmpty] = useState(false);
  const [onboardingConversationId, setOnboardingConversationId] = useState<string | null>(null);
  const draftConversationIdResolutionRef = useRef(false);
  const previousConversationIdRef = useRef<string | null>(null);
  const pendingQueuedMessageIdsRef = useRef<string[]>([]);
  const requestIdToMessageIdRef = useRef<Map<string, string>>(new Map());
  const pendingLocalDeletionsRef = useRef<Set<string>>(new Set());
  const confirmationToolCallMapRef = useRef<Map<string, string>>(new Map());
  const streamingMessageIdsRef = useRef<Set<string>>(new Set());
  const autoGreetRef = useRef(false);
  const initialPageOldestTsRef = useRef<number | null>(null);
  const conversationListInvalidatedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingInitialMessageRef = useRef<{ conversationId: string; content: string } | null>(null);
  const expandedToolCallIdsRef = useRef<Set<string>>(new Set());
  const contextWindowUsageByConversationRef = useRef<Map<string, ContextWindowUsage>>(new Map());
  const syncRouterRef = useRef<WebSyncRouter | null>(null);

  useContextWindowUsageHydration({
    assistantId,
    activeConversationId,
    contextWindowUsageByConversationRef,
    setContextWindowUsage,
  });

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
    enabled: shouldRenderChat,
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
    draftConversationIdResolutionRef,
    onDraftRestored: setRestoredDraftConversationId,
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const inputEl = inputRef.current;
      if (!inputEl || inputEl.disabled || inputEl.readOnly) return;
      if (document.activeElement === inputEl) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      if (!shouldFocusComposerForTyping(event, document.activeElement)) return;

      event.preventDefault();
      inputEl.focus();
      setInput((current) => {
        const next = insertTextAtSelection({
          value: current,
          text: event.key,
          selectionStart: inputEl.selectionStart,
          selectionEnd: inputEl.selectionEnd,
        });
        requestAnimationFrame(() => {
          inputEl.setSelectionRange(next.cursor, next.cursor);
        });
        return next.value;
      });
    };

    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
    };
  }, [setInput]);

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
    () => conversations.find((c) => c.conversationId === activeConversationId),
    [conversations, activeConversationId],
  );
  const isChannelReadonly = isChannelConversation(activeConversation);

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
    conversations,
    conversationGroupsUI,
    refreshEpoch,
    reachabilityReadyEpoch,
    assistantIdRef,
    draftConversationIdResolutionRef,
    previousConversationIdRef,
    onboardingDraftConversationIdRef,
    contextWindowUsageByConversationRef,
    dismissedSurfaceIdsRef,
    streamingMessageIdsRef,
    pendingQueuedMessageIdsRef,
    requestIdToMessageIdRef,
    pendingLocalDeletionsRef,
    confirmationToolCallMapRef,
    autoGreetRef,
    conversationListInvalidatedTimerRef,
    pendingInitialMessageRef,
    setMessages,
    setTranscriptPagination: setTranscriptPagination as Dispatch<SetStateAction<Omit<TranscriptPaginationState, "items">>>,
    setIsLoadingHistory,
    setError,
    setAutoGreetPending,
    setContextWindowUsage,
    setCompactionCircuitOpenUntil,
    resetChatAttachments,
    shouldSuppressGenericChatErrorNotice,
  });

  // Keep initialPageOldestTsRef in sync with TQ pagination data — used by
  // useMessageReconciliation to scope reconciliation to the loaded window.
  useEffect(() => {
    initialPageOldestTsRef.current = historyResult.pagination.latestPageOldestTimestamp;
  }, [historyResult.pagination.latestPageOldestTimestamp]);

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
  // Onboarding signal consumption
  // -------------------------------------------------------------------------
  // Consume the `?onboarding=1` signal left by `/onboarding/hatching` when
  // it forwards the user after a successful hatch. Flipping `autoGreetRef`
  // mirrors the existing auto-greet paths so the first assistant message
  // fires once the chat history loads. The flag is stripped from the URL
  // immediately so a page refresh doesn't re-trigger the greet.
  useEffect(() => {
    if (searchParams.get("onboarding") !== "1") return;
    autoGreetRef.current = true;
    setDidOnboarding(true);
    setAutoGreetPending(true);
    const onboardingDraftConversationId =
      onboardingDraftConversationIdRef.current ?? createDraftConversationId();
    onboardingDraftConversationIdRef.current = onboardingDraftConversationId;
    setOnboardingConversationId(onboardingDraftConversationId);
    useConversationStore.getState().setActiveConversationId(onboardingDraftConversationId);
    // Do NOT drain sessionStorage here — this ChatPage instance unmounts
    // when we navigate to /conversations/:key (different route entry),
    // losing all refs. Leave the context in sessionStorage so the new
    // mount's sendMessage hook and auto-send effect can consume it.
    void navigate(routes.conversation(onboardingDraftConversationId), { replace: true });
  }, [searchParams, navigate]);

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
    initialPageOldestTsRef,
  });

  // -------------------------------------------------------------------------
  // Assistant identity (refresh trigger)
  // -------------------------------------------------------------------------
  // The actual fetch lives in `useAssistantIdentityInit` at the
  // `ChatLayout` level (TanStack Query → Zustand store). Chat-page only
  // owns the *invalidation* triggers that the layout's query doesn't
  // know about: SSE `identity_changed`, post-`/edit-identity` flush,
  // and reachability resumes. Each downstream consumer (sync router,
  // stream event handler, send-message hook) calls this and the layout
  // re-fetches.
  const refreshAssistantIdentity = useCallback(
    async () => {
      const targetId = assistantIdRef.current;
      if (!targetId) return;
      await queryClient.invalidateQueries({
        queryKey: assistantIdentityQueryKey(targetId),
      });
    },
    [queryClient],
  );

  useEffect(() => {
    if (!shouldRenderChat || !assistantId) return;
    void refreshAssistantIdentity();
  }, [shouldRenderChat, assistantId, reachabilityReadyEpoch, refreshAssistantIdentity]);

  // -------------------------------------------------------------------------
  // Sync router
  // -------------------------------------------------------------------------
  const invalidateAvatar = useCallback(() => { avatar.invalidate(); }, [avatar.invalidate]);

  useEffect(() => {
    const syncRouter = createWebSyncRouter({
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
    applyDiskPressureStatusEvent: diskPressure.applyStatusEvent,
    refreshAssistantIdentity,
    invalidateAvatar,
    dispatchSyncChanged,
    pendingQueuedMessageIdsRef,
    requestIdToMessageIdRef,
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
    handleSteerMessage,
    handleEditQueueTail,
  } = useSendMessage({
    assistantId,
    activeConversationId,
    diskPressureChatBlockReason,
    messages,
    assistantIdRef,
    messagesRef,
    streamRef,
    streamContextRef,
    streamEpochRef,
    dismissedSurfaceIdsRef,
    pendingOnboardingContextRef,
    onboardingDraftConversationIdRef,
    draftConversationIdResolutionRef,
    previousConversationIdRef,
    pendingQueuedMessageIdsRef,
    requestIdToMessageIdRef,
    pendingLocalDeletionsRef,
    confirmationToolCallMapRef,
    setMessages,
    setError,
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

  // Auto-send a message when navigated to with ?prompt= (e.g. Submit Feedback)
  const promptConsumedRef = useRef<string | null>(null);
  useEffect(() => {
    const prompt = searchParams.get("prompt");
    if (!prompt || !activeConversationId || promptConsumedRef.current === prompt) return;
    promptConsumedRef.current = prompt;
    void sendMessage(prompt);
  }, [searchParams, activeConversationId, sendMessage]);

  // Kick off a background reachability probe immediately when a pending
  // onboarding message exists, instead of waiting for a 502 from
  // the conversation list query to trigger the unreachable-bus.
  useEffect(() => {
    if (!assistantId) return;
    const message = peekPendingPreChatContext()?.initialMessage;
    if (!message) return;
    if (reachability.state.phase === "idle") {
      reachability.probe({ mode: "background" });
    }
  }, [assistantId, reachability]);

  // Auto-send onboarding initial message once the daemon is reachable.
  const initialMessageConsumedRef = useRef(false);
  useEffect(() => {
    if (initialMessageConsumedRef.current || !assistantId || !activeConversationId) return;
    if (reachability.state.phase !== "ready") return;
    const message = peekPendingPreChatContext()?.initialMessage;
    if (!message) return;
    initialMessageConsumedRef.current = true;
    void sendMessage(message);
  }, [activeConversationId, assistantId, reachability.state.phase, sendMessage]);

  // Clear the post-onboarding loading gate once the first message appears.
  useEffect(() => {
    if (!autoGreetPending) return;
    if (messages.length > 0) {
      setAutoGreetPending(false);
    }
  }, [autoGreetPending, messages.length]);

  // The onboarding redirect remounts ChatPage after leaving
  // `/assistant?onboarding=1`; a timeout armed on the first mount is cancelled
  // during that remount. Arm the safety timer from the actual mounted page
  // that is rendering the loading gate so a failed auto-send cannot strand
  // the user on "Connecting..." until refresh.
  useEffect(() => {
    if (!autoGreetPending) return;
    const timeout = setTimeout(() => {
      setAutoGreetPending(false);
    }, 10_000);
    return () => clearTimeout(timeout);
  }, [autoGreetPending]);

  // Derive onboardingTasksEmpty from the pending context in sessionStorage.
  // Runs once on mount — if initial message key is present, this is an
  // onboarding mount, so peek at the context for the tasks-empty flag.
  useEffect(() => {
    try {
      const raw = globalThis.sessionStorage?.getItem("onboarding.prechat.pendingContext");
      if (!raw) return;
      const ctx = JSON.parse(raw) as { tasks?: string[] };
      if (Array.isArray(ctx.tasks) && ctx.tasks.length === 0) {
        setOnboardingTasksEmpty(true);
      }
    } catch {
      // Storage or parse failure — ignore.
    }
  }, []);

  // Deep-link: ?app=<id> auto-opens the app viewer on initial load.
  const deepLinkAppConsumed = useRef(false);
  useEffect(() => {
    if (deepLinkAppConsumed.current) return;
    const appId = searchParams.get("app");
    if (!appId || !assistantId) return;
    deepLinkAppConsumed.current = true;
    void useViewerStore.getState().loadApp(assistantId, appId);
    const params = new URLSearchParams(searchParams.toString());
    params.delete("app");
    const query = params.toString();
    window.history.replaceState(
      null,
      "",
      query ? `${window.location.pathname}?${query}` : window.location.pathname,
    );
  }, [searchParams, assistantId]);

  // Clear question prompt when conversation changes
  useEffect(() => {
    useInteractionStore.getState().dismissQuestion();
  }, [activeConversationId]);

  // Reset subagent state when conversation changes
  useEffect(() => {
    useSubagentStore.getState().reset();
  }, [activeConversationId]);

  // -------------------------------------------------------------------------
  // Subagent detail fetching
  // -------------------------------------------------------------------------
  const handleRequestSubagentDetail = useCallback(
    async (subagentId: string) => {
      if (!assistantId) return;
      const entry = useSubagentStore.getState().byId[subagentId];
      if (!entry?.conversationId) return;

      const detail = await fetchSubagentDetail(assistantId, subagentId, entry.conversationId);
      if (!detail) return;

      let eventCounter = 0;
      const events: SubagentTimelineEvent[] = [];

      for (const evt of detail.events ?? []) {
        const rawType = typeof evt.type === "string" ? evt.type : "unknown";
        let type: SubagentTimelineEvent["type"];
        switch (rawType) {
          case "text":
          case "assistant_text_delta":
            type = "text";
            break;
          case "tool_use":
          case "tool_use_start":
            type = "tool_call";
            break;
          case "tool_result":
            type = "tool_result";
            break;
          case "error":
            type = "error";
            break;
          default:
            continue;
        }

        const content =
          typeof evt.content === "string"
            ? evt.content
            : typeof evt.text === "string"
              ? evt.text
              : typeof evt.result === "string"
                ? evt.result
                : "";

        if (type === "text" && content === "") continue;

        // Coalesce consecutive text events
        const prev = events[events.length - 1];
        if (type === "text" && prev && prev.type === "text") {
          prev.content += "\n\n" + content;
          continue;
        }

        events.push({
          id: `detail-${++eventCounter}`,
          type,
          content,
          toolName: typeof evt.toolName === "string" ? evt.toolName : undefined,
          isError: typeof evt.isError === "boolean" ? evt.isError : undefined,
          timestamp: typeof evt.timestamp === "number" ? evt.timestamp : Date.now(),
        });
      }

      useSubagentStore.getState().loadDetail({
        subagentId,
        status: (detail.status as SubagentStatus) || undefined,
        objective: detail.objective,
        inputTokens: detail.usage?.inputTokens,
        outputTokens: detail.usage?.outputTokens,
        totalCost: detail.usage?.estimatedCost,
        events,
      });
    },
    [assistantId],
  );

  // Auto-fetch details for subagents reconstructed from history (mirrors macOS
  // behavior of calling the detail endpoint on reload to get correct status,
  // metrics, and events).
  // Keyed by subagentId → spawnedAt at fetch time so that store rebuilds
  // (e.g. background TanStack Query refetches that reset + respawn entries)
  // produce a new spawnedAt and allow re-fetching.
  const fetchedSubagentsRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    fetchedSubagentsRef.current.clear();
  }, [activeConversationId]);
  useEffect(() => {
    if (!assistantId) return;
    const entries = Object.values(subagentById);
    for (const entry of entries) {
      if (entry.conversationId && entry.events.length === 0) {
        const fetchedAt = fetchedSubagentsRef.current.get(entry.subagentId);
        if (fetchedAt !== undefined && fetchedAt >= entry.spawnedAt) continue;
        fetchedSubagentsRef.current.set(entry.subagentId, entry.spawnedAt);
        handleRequestSubagentDetail(entry.subagentId);
      }
    }
  }, [assistantId, subagentById, handleRequestSubagentDetail]);

  // -------------------------------------------------------------------------
  // Interaction actions
  // -------------------------------------------------------------------------
  const interactionActions = useInteractionActions({
    setMessages,
    setError,
    messagesRef,
    streamContextRef,
    confirmationToolCallMapRef,
  });

  // -------------------------------------------------------------------------
  // Event stream (SSE lifecycle)
  // -------------------------------------------------------------------------
  useEventStream({
    assistantStateKind: assistantState.kind,
    assistantId,
    activeConversationId,
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
    syncRouterRef,
    conversationListInvalidatedTimerRef,
  });

  // -------------------------------------------------------------------------
  // Non-destructive refresh for the chat title chevron's Refresh menu item.
  // -------------------------------------------------------------------------
  const refreshLatestMessages = useRefreshLatestMessages({
    assistantId,
    messagesRef,
    setMessages,
    dismissedSurfaceIdsRef,
  });

  // Debug API — dev-facing surface for in-the-moment chat inspection.
  // Unconditionally attached; negligible production overhead.
  //
  // `getTurnState` / `getUIContext` read fresh values on every call via the
  // `latestRefs` indirection inside `useChatDebugApi`, so DevTools sees the
  // same snapshot the React render path is computing. `_uiContext` is
  // declared further down in this component but the lambda is only invoked
  // asynchronously (from `window._vellumDebug.chat.thinkingIndicator()`),
  // by which point initialization is complete.
  useChatDebugApi({
    messagesRef,
    sanitizedMessagesRef,
    transcriptItemsRef,
    transcriptRef,
    streamContextRef,
    streamRef,
    streamEpochRef,
    getAssistantId: () => assistantIdRef.current,
    getTurnState: () => useTurnStore.getState(),
    getUIContext: () => _uiContext,
    // The chat domain isn't allowed to import the interactions store
    // directly (cross-domain rule). chat-page.tsx is the composition
    // root with an allowlist exemption for `interactions`, so the
    // wiring lives here. Snapshotting the fields explicitly — rather
    // than returning the whole Zustand state — keeps the DevTools
    // payload predictable and avoids leaking actions/setters into the
    // serialized output.
    getPendingInteractionsSnapshot: () => {
      const state = useInteractionStore.getState();
      return {
        pendingSecret: state.pendingSecret,
        isSubmittingSecret: state.isSubmittingSecret,
        pendingConfirmation: state.pendingConfirmation,
        isSubmittingConfirmation: state.isSubmittingConfirmation,
        pendingContactRequest: state.pendingContactRequest,
        isSubmittingContactRequest: state.isSubmittingContactRequest,
        pendingQuestion: state.pendingQuestion,
        isSubmittingQuestion: state.isSubmittingQuestion,
        isQuestionCardDismissed: state.isQuestionCardDismissed,
        inlineConfirmationToolCallId: state.inlineConfirmationToolCallId,
      };
    },
    getScrollPagination: () => ({
      hasMore: transcriptPagination.hasMore,
      isLoadingOlder: transcriptPagination.isLoadingOlder,
    }),
    reconcileActiveConversation,
  });

  // -------------------------------------------------------------------------
  // Sync chat store (for deeply-nested components that read via context)
  // -------------------------------------------------------------------------
  useSyncChatStore({
    messages,
    activeConversationId,
    assistantId,
    sendMessage,
  });

  // (Previously: a useEffect mirrored a local `useState<AssistantIdentity>`
  // into `useAssistantIdentityStore`. That mirror is gone — chat-page now
  // reads the store via atomic selectors above and `useAssistantIdentityInit`
  // at the layout level owns the fetch + write. LUM-1959.)

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
    renameRequest,
    submitRenameConversation,
    cancelRenameConversation,
  } = useConversationActions({
    assistantId,
    activeConversationId,
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
    handleInspectMessage,
    handleCopyConversation,
  } = useConversationSecondaryActions({
    assistantId,
    activeConversationId,
    activeConversation: activeConversation ?? null,
    assistantIdentityName: assistantName ?? undefined,
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
      assistantName: assistantName ?? undefined,
      conversations,
      activeConversationId: activeConversationId ?? undefined,
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
    () => messages.some((m) => m.id != null),
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
          !isChannelReadonly && activeConversation.conversationId
            ? () => handleAnalyzeConversation(activeConversation)
            : undefined
        }
        onForkConversation={
          !isChannelReadonly && hasPersistedMessage
            ? handleForkConversationFromMenu
            : undefined
        }
        onOpenInNewWindow={
          activeConversation.conversationId
            ? () => handleOpenInNewWindow(activeConversation)
            : undefined
        }
        onInspect={
          showLlmInspector && activeConversation.conversationId
            ? () => handleInspectConversation(activeConversation)
            : undefined
        }
        onCopyConversation={
          messages.length > 0
            ? handleCopyConversation
            : undefined
        }
        onRefresh={
          activeConversation.conversationId != null
            ? refreshLatestMessages
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
    showLlmInspector,
    handleCopyConversation,
    handleMoveToGroup,
    handleRemoveFromGroup,
    handleMarkConversationUnread,
    handleMarkConversationRead,
    hasPersistedMessage,
    messages.length,
    refreshLatestMessages,
  ]);

  useEffect(() => {
    setTopBarCenter(topBarCenterContent);
    return () => { setTopBarCenter(null); };
  }, [topBarCenterContent, setTopBarCenter]);

  // Open an app from inside a chat (assets pill, "Open App" on a message).
  // On macOS this enters side-by-side editing mode (chat + app preview);
  // we mirror that here by transitioning the viewer to `app-editing` once
  // the load lands, keeping the current conversation as the edit chat.
  // Bail if the load failed or a newer open superseded this one.
  const handleOpenAppFromChat = useCallback(
    async (appId: string) => {
      if (!assistantId) return;
      haptic.light();
      await useViewerStore.getState().loadApp(assistantId, appId);
      const { activeAppId, openedAppState } = useViewerStore.getState();
      if (activeConversationId && openedAppState && activeAppId === appId) {
        useConversationStore.getState().setEditingConversationId(activeConversationId);
        useViewerStore.getState().enterAppEditing();
      }
    },
    [assistantId, activeConversationId],
  );

  const handleOpenDocument = useCallback(
    (surfaceId: string) => {
      haptic.light();
      if (assistantId) void useViewerStore.getState().loadDocument(assistantId, surfaceId);
    },
    [assistantId],
  );

  const topBarRightContent = useMemo(() => {
    if (!activeConversation?.conversationId || !assistantId) return null;
    return (
      <ConversationAssetsPill
        assistantId={assistantId}
        conversationId={activeConversation.conversationId}
        refreshKey={assetsRefreshKey}
        onOpenApp={handleOpenAppFromChat}
        onOpenDocument={handleOpenDocument}
      />
    );
  }, [activeConversation?.conversationId, assistantId, assetsRefreshKey, handleOpenAppFromChat, handleOpenDocument]);

  useEffect(() => {
    setTopBarRightSlot(topBarRightContent);
    return () => { setTopBarRightSlot(null); };
  }, [topBarRightContent, setTopBarRightSlot]);

  // -------------------------------------------------------------------------
  // Mobile overlay portal — resolve after DOM commit (CONVENTIONS.md §SSR)
  // -------------------------------------------------------------------------
  const overlayTarget = useMobileOverlayTarget();

  // -------------------------------------------------------------------------
  // Ghost-text suggestion (server state via TanStack Query — LUM-2009)
  // -------------------------------------------------------------------------
  // Derive the scalar the query keys on; the hook stays pure w.r.t.
  // composer input — `ChatComposer.computeGhostSuffix` is the single
  // source of truth for "what part of the suggestion is visible right
  // now given the user's typed prefix".
  const lastCompleteAssistantMsgId = useMemo<string | null>(() => {
    const last = messages[messages.length - 1];
    return last && last.role === "assistant" && !last.isStreaming
      ? last.id ?? null
      : null;
  }, [messages]);

  const suggestion = useGhostTextSuggestion({
    assistantId,
    conversationId: activeConversationId,
    lastCompleteAssistantMsgId,
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

  const activeConversationIsProcessing = activeConversationId != null && processingConversationIds.has(activeConversationId);
  const activeConversationHasPendingAssistantResponse = useMemo(
    () => hasPendingAssistantResponse(messages),
    [messages],
  );

  const pendingSecret = useInteractionStore.use.pendingSecret();
  const pendingConfirmation = useInteractionStore.use.pendingConfirmation();
  const pendingQuestion = useInteractionStore.use.pendingQuestion();
  const pendingContactRequest = useInteractionStore.use.pendingContactRequest();

  // Build UIContext first — needed for showThinking calculation
  const _uiContext: UIContext = {
    hasStreamingAssistantMessage: messages.some((m) => m.isStreaming),
    hasPendingSecret: !!pendingSecret,
    hasPendingConfirmation: !!pendingConfirmation,
    hasPendingQuestion: !!pendingQuestion,
    hasPendingContactRequest: !!pendingContactRequest,
    hasUncompletedVisibleSurface,
    activeConversationIsProcessing,
    hasPendingAssistantResponse: activeConversationHasPendingAssistantResponse,
  };
  void _uiContext;

  const connectingReason = resolveChatConnectingReason({
    authLoading,
    assistantStateKind: assistantState.kind,
    autoGreetPending,
  });
  const lastConnectingReasonRef = useRef<ChatConnectingReason | null>(null);
  useEffect(() => {
    if (connectingReason === null) {
      lastConnectingReasonRef.current = null;
      return;
    }
    if (lastConnectingReasonRef.current === connectingReason) return;
    lastConnectingReasonRef.current = connectingReason;
    Sentry.addBreadcrumb({
      category: "chat.connecting",
      level: "info",
      message: "ChatPage rendered Connecting",
      data: {
        reason: connectingReason,
        assistantStateKind: assistantState.kind,
        hasAssistantId: assistantId != null,
        hasActiveConversationId: activeConversationId != null,
      },
    });
  }, [activeConversationId, assistantId, assistantState.kind, connectingReason]);

  // -------------------------------------------------------------------------
  // Loading / error guards
  // -------------------------------------------------------------------------
  if (connectingReason !== null) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-[var(--text-secondary)]">Connecting…</p>
      </div>
    );
  }

  if (assistantState.kind === "error") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
        <p className="text-[var(--text-secondary)]">{assistantState.message}</p>
        <Button variant="primary" onClick={retryAssistant}>
          Try again
        </Button>
      </div>
    );
  }

  if (assistantState.kind === "initializing") {
    return <SetupScreen />;
  }

  if (assistantState.kind === "cleaning_up") {
    return <CleanupScreen />;
  }

  if (assistantState.kind === "platform_hosted") {
    return <PlatformHostedScreen />;
  }

  if (assistantState.kind === "self_hosted" && !selfHostedChatEnabled) {
    return <SelfHostedScreen />;
  }

  // Self-hosted runtime call failed — most commonly because we don't yet
  // have an actor-token JWT for the user's gateway (the web pair flow is
  // still being built; see `lib/self-hosted/actor-token.ts`). Land on a
  // terminal error state with a retry button instead of leaving the
  // sidebar + transcript stuck in the seeded `isLoadingHistory` skeleton.
  if (
    assistantState.kind === "self_hosted" &&
    selfHostedChatEnabled &&
    conversationListIsError
  ) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
        <p className="text-[var(--text-secondary)]">
          Couldn&apos;t reach your self-hosted assistant. Make sure your
          assistant is running, then try again.
        </p>
        <Button variant="primary" onClick={refetchConversationList}>
          Try again
        </Button>
      </div>
    );
  }

  if (assistantState.kind === "awaiting_version_selection") {
    return <VersionSelectionScreen onHatch={hatchVersion} />;
  }

  if (assistantState.kind === "retired") {
    return (
      <div className="flex h-full flex-col items-center justify-center p-8 text-center">
        <p className="text-title-medium text-[var(--content-default)]">
          This assistant has been retired
        </p>
        <p className="mt-2 max-w-md text-body-medium-lighter text-[var(--content-tertiary)]">
          This assistant is no longer active. You can create a new one from the
          settings page.
        </p>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Props assembly (only reached when shouldRenderChat is true — i.e.
  // assistantState.kind === "active", or self_hosted with the
  // `self-hosted-assistant` flag on)
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
    assistantName,
    chatPullToRefreshEnabled,
    deployToVercel,
    doctor,
    isMobile,
    messages,
    setMessages,
    input,
    setInput,
    error,
    setError,
    isLoadingHistory,
    conversations,
    activeConversationId,
    activeConversation,
    processingConversationIds,
    mainView,
    openedAppState,
    openedDocumentState,
    editingConversationId,
    restoredDraftConversationId,
    setRestoredDraftConversationId,
    saveDraft,
    clearDraft,
    avatar: {
      avatarComponents: avatar.components,
      avatarTraits: avatar.traits,
      avatarImageUrl: avatar.customImageUrl,
    },
    contextWindowUsage,
    compactionCircuitOpenUntil,
    setCompactionCircuitOpenUntil,
    suggestion,
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
      handleSteerMessage,
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
    handleOpenApp: handleOpenAppFromChat,
    handleOpenDocument,
    handleCloseDocument: () => {
      useViewerStore.getState().closeDocument();
    },
    handleCloseApp: () => {
      useViewerStore.getState().closeApp();
      useConversationStore.getState().setEditingConversationId(null);
    },
    handleCloseEditPanel: () => {
      useConversationStore.getState().setEditingConversationId(null);
      useViewerStore.getState().exitAppEditing();
    },
    handleEditApp: () => {
      const { openedAppState } = useViewerStore.getState();
      if (!openedAppState || !assistantId) return;

      const appId = openedAppState.appId;
      const conversationId = getEditChatConversationId(assistantId, appId) ?? crypto.randomUUID();
      setEditChatConversationId(assistantId, appId, conversationId);
      useConversationStore.getState().setEditingConversationId(conversationId);
      useViewerStore.getState().enterAppEditing();

      if (activeConversationId !== conversationId) {
        navigateToConversation(conversationId);
      }
    },
    handleShareApp: () => {
      const app = useViewerStore.getState().openedAppState;
      if (app && assistantId) void useDeployStore.getState().shareApp(assistantId, app.appId, app.name);
    },
    handleDeployApp: deployToVercel ? () => {
      const app = useViewerStore.getState().openedAppState;
      if (app && assistantId) void useDeployStore.getState().deployApp(assistantId, app.appId, app.name, app.html);
    } : undefined,
    handleForkConversation,
    handleInspectMessage: showLlmInspector ? handleInspectMessage : undefined,
    subagentState: { byId: subagentById },
    activeSubagentId,
    onSubagentClick: (id: string) => { useViewerStore.getState().openSubagentDetail(id); },
    onCloseSubagentDetail: () => { useViewerStore.getState().closeSubagentDetail(); },
    onStopSubagent: async (subagentId: string) => {
      if (!assistantId || !activeConversationId) return;
      try {
        await subagentsByIdAbortPost({
          path: { assistant_id: assistantId, id: subagentId },
          body: { conversationId: activeConversationId },
          throwOnError: true,
        });
      } catch {
        // Best-effort — the daemon may have already completed
      }
    },
    onRequestSubagentDetail: handleRequestSubagentDetail,
    pushToAiSettings,
    checkAssistant,
    setRefreshEpoch,
    historyPagination: historyResult.pagination,
    refs: {
      inputRef,
      messagesRef,
      sanitizedMessagesRef,
      transcriptItemsRef,
      assistantIdRef,
      streamContextRef,
      expandedToolCallIdsRef,
      dismissedSurfaceIdsRef,
      contextWindowUsageByConversationRef,
      streamRef,
      streamEpochRef,
      pendingQueuedMessageIdsRef,
      requestIdToMessageIdRef,
      pendingLocalDeletionsRef,
      confirmationToolCallMapRef,
      reconcileAfterNextStreamOpenRef,
      transcriptRef,
    },
    isChannelReadonly,
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
      {commandPalette.isOpen ? (
        <LazyBoundary>
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
        </LazyBoundary>
      ) : null}
      {assistantId && (isTokenDialogOpen || complexDeployApp) ? (
        <LazyBoundary>
          <DeployDialogs
            assistantId={assistantId}
            assistantName={assistantName ?? undefined}
            onStartConversation={(msg) => startNewConversation({ initialMessage: msg })}
          />
        </LazyBoundary>
      ) : null}
      <RenameConversationDialog
        open={renameRequest !== null}
        currentTitle={renameRequest?.currentTitle ?? ""}
        onSubmit={submitRenameConversation}
        onCancel={cancelRenameConversation}
      />
      {overlayTarget &&
        createPortal(
          <>
            <MobileAppOverlay
              openedAppState={
                mainView === "app" ? openedAppState : null
              }
              isAppMinimized={isAppMinimized}
              assistantId={assistantId}
              onToggleMinimized={() => {
                useViewerStore.getState().toggleAppMinimized();
              }}
              onClose={() => {
                useViewerStore.getState().closeApp();
                useConversationStore.getState().setEditingConversationId(null);
              }}
              onShare={() => {
                const app = useViewerStore.getState().openedAppState;
                if (app && assistantId) void useDeployStore.getState().shareApp(assistantId, app.appId, app.name);
              }}
              isSharing={isSharing}
              onDeploy={
                deployToVercel
                  ? () => {
                      const app = useViewerStore.getState().openedAppState;
                      if (app && assistantId) void useDeployStore.getState().deployApp(assistantId, app.appId, app.name, app.html);
                    }
                  : undefined
              }
              isDeploying={isDeploying}
            />
            <MobileDocumentOverlay
              openedDocumentState={
                mainView === "document"
                  ? openedDocumentState
                  : null
              }
              assistantId={assistantId}
              onClose={() => {
                useViewerStore.getState().closeDocument();
              }}
              onSubmitFeedback={() => {
                const docState = useViewerStore.getState().openedDocumentState;
                if (!docState) return;
                const prompt = `Please review and address my comments on "${docState.documentName}".`;
                navigate(
                  `${routes.conversation(docState.conversationId)}?prompt=${encodeURIComponent(prompt)}`,
                );
              }}
            />
            <MobileSubagentDetailOverlay
              entry={
                mainView === "subagent-detail" &&
                activeSubagentId
                  ? subagentById[activeSubagentId] ?? null
                  : null
              }
              onClose={() => {
                useViewerStore.getState().closeSubagentDetail();
              }}
              onStop={async (subagentId: string) => {
                if (!assistantId || !activeConversationId) return;
                try {
                  await subagentsByIdAbortPost({
                    path: { assistant_id: assistantId, id: subagentId },
                    body: { conversationId: activeConversationId },
                    throwOnError: true,
                  });
                } catch {
                  // Best-effort — the daemon may have already completed
                }
              }}
              onRequestDetail={handleRequestSubagentDetail}
            />
            <MobileToolDetailOverlay
              detail={
                mainView === "tool-detail"
                  ? activeToolDetail
                  : null
              }
              onClose={() => {
                useViewerStore.getState().closeToolDetail();
              }}
            />
          </>,
          overlayTarget,
        )}
    </>
  );
}
