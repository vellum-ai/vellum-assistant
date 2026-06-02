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
import { useAssistantSelectionStore } from "@/assistant/selection-store";
import { useConversationStore } from "@/stores/conversation-store";
import {
  COMPOSER_FOCUS_EVENT,
  consumePendingComposerFocus,
  insertTextAtSelection,
  requestComposerFocus,
  shouldFocusComposerForTyping,
} from "./composer-focus";
import {
  useConversationListQuery,
} from "@/hooks/conversation-queries";
import { useActiveConversation } from "@/domains/chat/hooks/use-active-conversation";
import { useViewerStore } from "@/stores/viewer-store";
import { useDeployStore } from "@/stores/deploy-store";
import { useSubagentStore } from "@/domains/chat/subagent-store";
import { useInteractionStore } from "@/domains/chat/interaction-store";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { useIsNativePlatform } from "@/runtime/native-auth";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

import type { DisplayMessage } from "@/domains/chat/utils/reconcile";
import type { TranscriptHandle } from "@/domains/chat/transcript/transcript";
import type { TranscriptItem } from "@/domains/chat/transcript/types";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { shouldSuppressGenericChatErrorNotice } from "@/domains/chat/utils/error-classification";
import { type UIContext } from "@/domains/chat/turn-selectors";
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
import { useCommandPaletteSections } from "@/domains/chat/hooks/use-command-palette-sections";
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
import { useChatDebugApi } from "@/domains/chat/utils/debug-api";

import { ConnectingToAssistant } from "@/domains/chat/components/connecting-to-assistant";

import {
  assistantIdentityIntroQueryKey,
  assistantIdentityQueryKey,
} from "@/lib/sync/query-tags";
import { useQueryClient } from "@tanstack/react-query";

import { hasPendingAssistantResponse } from "@/domains/chat/utils/chat";
import { isSurfaceInteractive } from "@/domains/chat/types/types";
import { useTurnStore } from "@/domains/chat/turn-store";

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
import { lifecycleService } from "@/assistant/lifecycle-service";
import { MobileChatOverlays } from "@/domains/chat/components/mobile-chat-overlays";
import { useSyncRouter } from "@/domains/chat/hooks/use-sync-router";
import { useChatHeaderRegistration } from "@/domains/chat/hooks/use-chat-header-registration";
import { useConversationChangeEffects } from "@/domains/chat/hooks/use-conversation-change-effects";

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
  const transcriptPagination = useChatSessionStore.use.transcriptPagination();

  // -------------------------------------------------------------------------
  // Local state (not store-backed)
  // -------------------------------------------------------------------------
  const [showAddCreditsModal, setShowAddCreditsModal] = useState(false);

  const [restoredDraftConversationId, setRestoredDraftConversationId] = useState<string | null>(null);
  const [refreshEpoch, setRefreshEpoch] = useState(0);
  // Auto-greet loading gate — single source of truth lives in
  // `useAssistantLifecycleStore.expectingFirstMessage`. Set by every
  // hatch path (vanilla auto-hatch, nonprod `hatchVersion`, onboarding
  // hatching-screen, pre-chat-flow) and by the mount-time pre-chat
  // detector below. Cleared on the exit conditions below (messages
  // arrived, 10s safety, conversation switch) or on terminal lifecycle
  // transitions (error / retired / logout).
  const autoGreetPending =
    useAssistantLifecycleStore.use.expectingFirstMessage();

  // Pre-chat sessionStorage detector. Load-bearing on the *reload*
  // path: sessionStorage survives a refresh / iOS webview restore,
  // the lifecycle store does not. If the user reloads after the
  // pre-chat context is staged but before the first message arrives,
  // the auto-send hook below still fires from the persisted context,
  // so the gate has to show. Mark is idempotent.
  useEffect(() => {
    if (peekPendingPreChatContext()?.initialMessage != null) {
      lifecycleService.markExpectingFirstMessage();
    }
  }, []);
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
  // Conversation list / groups (server state via TanStack Query)
  // -------------------------------------------------------------------------
  const {
    conversations,
  } = useConversationListQuery(assistantId, true);

  // -------------------------------------------------------------------------
  // Zustand store selectors
  // -------------------------------------------------------------------------
  const activeConversationId = useConversationStore.use.activeConversationId();
  const processingConversationIds = useConversationStore.use.processingConversationIds();
  const isTokenDialogOpen = useDeployStore.use.isTokenDialogOpen();
  const complexDeployApp = useDeployStore.use.complexDeployApp();

  // Assistant identity is fetched and stored by `useAssistantIdentityInit`
  // at the `ChatLayout` level (TanStack Query → Zustand) so the sidebar
  // header populates on every `/assistant/*` route. ActiveChatView reads the
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

  const initialPageOldestTsRef = useRef<number | null>(null);
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

  // Inbound deep links: pre-fill composer with `deeplink.send` text,
  // navigate to `/assistant/conversations/<id>` for `deeplink.openThread`,
  // and ensure the main window is visible first. The hook gates the
  // composer pre-fill on `input` being empty so it doesn't clobber
  // in-progress typing. Off Electron the bus events never fire.
  useDeepLinkConsumer({ composerInput: input, setComposerInput: setInput });

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
    assistantIdRef,
    onboardingDraftConversationIdRef,
    conversationListInvalidatedTimerRef,
    pendingInitialMessageRef,
    shouldSuppressGenericChatErrorNotice,
    resetChatAttachments,
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
  // Message reconciliation
  // -------------------------------------------------------------------------
  const {
    startReconciliationLoop,
    cancelReconciliation,
    reconcileActiveConversation,
  } = useMessageReconciliation({
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

  const invalidateAssistantIdentityIntro = useCallback(
    () => {
      const targetId = assistantIdRef.current;
      if (!targetId) return;
      void queryClient.invalidateQueries({
        queryKey: assistantIdentityIntroQueryKey(targetId),
      });
    },
    [queryClient],
  );

  useEffect(() => {
    if (!assistantId) return;
    void refreshAssistantIdentity();
  }, [assistantId, reachabilityReadyEpoch, refreshAssistantIdentity]);

  // -------------------------------------------------------------------------
  // Sync router
  // -------------------------------------------------------------------------
  const invalidateAvatar = useCallback(() => { avatar.invalidate(); }, [avatar.invalidate]);

  const { syncRouterRef, dispatchSyncChanged } = useSyncRouter({
    invalidateAvatar,
    refreshAssistantIdentity,
    invalidateAssistantIdentityIntro,
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
    pendingOnboardingContextRef,
    onboardingDraftConversationIdRef,
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

  // Clear the post-hatch loading gate once the first message appears.
  useEffect(() => {
    if (!autoGreetPending) return;
    if (messages.length > 0) lifecycleService.clearExpectingFirstMessage();
  }, [autoGreetPending, messages.length]);

  // Safety timer: a failed auto-send / never-arriving greeting can't
  // strand the user on "Connecting..." until refresh.
  useEffect(() => {
    if (!autoGreetPending) return;
    const timeout = setTimeout(
      () => lifecycleService.clearExpectingFirstMessage(),
      10_000,
    );
    return () => clearTimeout(timeout);
  }, [autoGreetPending]);

  // Clear the gate when `activeConversationId` changes after first
  // mount. Auto-greet isn't per-conversation state — it's a
  // system-wide "we just hatched" signal that happens to surface in
  // the chat UI, so it doesn't belong in the conversation-switch
  // reset. Draft → real ID handoff also trips this, but by then
  // the messages-arrived effect has already dismissed the gate (sending
  // the first message is what resolves the draft), so the second
  // dismiss is a no-op.
  const lastSeenConvIdForGateRef = useRef<string | null>(null);
  useEffect(() => {
    if (activeConversationId == null) return;
    const previous = lastSeenConvIdForGateRef.current;
    lastSeenConvIdForGateRef.current = activeConversationId;
    if (previous != null && previous !== activeConversationId) {
      lifecycleService.clearExpectingFirstMessage();
    }
  }, [activeConversationId]);

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
    syncRouterRef,
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
  useChatDebugApi({
    sanitizedMessagesRef,
    transcriptItemsRef,
    transcriptRef,
    getAssistantId: () => assistantIdRef.current,
    getTurnState: () => useTurnStore.getState(),
    getUIContext: () => _debugUiContext,
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

  // Ctrl/Cmd+K shortcut for command palette
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!shouldHandleShortcut(event, document.activeElement, "k")) return;
      event.preventDefault();
      commandPalette.toggle();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => { window.removeEventListener("keydown", onKeyDown); };
  }, [commandPalette.toggle]);

  // -------------------------------------------------------------------------
  // Layout header slot registration — supplements, top bar right, search
  // -------------------------------------------------------------------------
  useChatHeaderRegistration({
    assetsRefreshKey,
    handleAnalyzeConversation,
    handleForkConversationFromMenu,
    handleOpenInNewWindow,
    handleInspectConversation,
    handleCopyConversation,
    refreshLatestMessages,
    commandPaletteToggle: commandPalette.toggle,
  });

  // -------------------------------------------------------------------------
  // Debug API — UIContext snapshot (read lazily by useChatDebugApi closure)
  // -------------------------------------------------------------------------
  const _debugUiContext = useMemo<UIContext>(() => {
    const isProcessing = activeConversationId != null && processingConversationIds.has(activeConversationId);
    const interactionState = useInteractionStore.getState();
    let hasUncompletedSurface = false;
    for (const msg of messages) {
      if (msg.surfaces) {
        for (const s of msg.surfaces) {
          if (isSurfaceInteractive(s)) { hasUncompletedSurface = true; break; }
        }
      }
      if (hasUncompletedSurface) break;
    }
    return {
      hasStreamingAssistantMessage: isProcessing && messages.length > 0 && messages[messages.length - 1]?.role === "assistant",
      hasPendingSecret: !!interactionState.pendingSecret,
      hasPendingConfirmation: !!interactionState.pendingConfirmation,
      hasPendingQuestion: !!interactionState.pendingQuestion,
      hasPendingContactRequest: !!interactionState.pendingContactRequest,
      hasUncompletedVisibleSurface: hasUncompletedSurface,
      activeConversationIsProcessing: isProcessing,
      hasPendingAssistantResponse: hasPendingAssistantResponse(messages),
    };
  }, [messages, activeConversationId, processingConversationIds]);

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
      <MobileChatOverlays />
    </>
  );
}
