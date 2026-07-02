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
import { useParams, useSearchParams } from "react-router";

import { useAssistantLifecycleStore } from "@/assistant/lifecycle-store";
import { useAutoGreetGate } from "@/domains/chat/hooks/use-auto-greet-gate";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useAuthStore } from "@/stores/auth-store";
import { useConversationStore } from "@/stores/conversation-store";
import { useActiveConversation } from "@/domains/chat/hooks/use-active-conversation";
import { useViewerStore } from "@/stores/viewer-store";
import { useDeployStore } from "@/stores/deploy-store";

import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

import type { DisplayMessage } from "@/domains/chat/types/types";
import type { TranscriptHandle } from "@/domains/chat/transcript/transcript";
import type { TranscriptItem } from "@/domains/chat/transcript/types";
import type { UIContext } from "@/domains/chat/turn-selectors";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";

import { peekPendingPreChatContext } from "@/domains/onboarding/prechat";

import { LazyBoundary } from "@/components/lazy-boundary";
import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";
import { useAssistantReachability } from "@/assistant/use-assistant-reachability";
import { useDiskPressureMonitor } from "@/assistant/use-disk-pressure-monitor";
import { getDiskPressureChatBlockReason } from "@/assistant/disk-pressure";
import { useActiveAssistantIsPlatformHosted } from "@/hooks/use-platform-gate";
import { useComposerStore } from "@/domains/chat/composer-store";

import { useConversationLoader } from "@/domains/chat/hooks/use-conversation-loader";
import { useDraftPersistence } from "@/domains/chat/hooks/use-draft-persistence";
import { useOnboardingOrchestrator } from "@/domains/chat/hooks/use-onboarding-orchestrator";

import { useConversationSecondaryActions } from "@/domains/chat/hooks/use-conversation-secondary-actions";
import { useCanUseLlmInspector } from "@/domains/chat/inspector/access";
import { useSendMessage } from "@/domains/chat/hooks/use-send-message";
import { useMessageLifecycle } from "@/domains/chat/hooks/use-message-lifecycle";
import { useActiveAppPinSync } from "@/domains/chat/hooks/use-active-app-pin-sync";
import { useDeepLinkConsumer } from "@/domains/chat/hooks/use-deep-link-consumer";

import { useChatDebugRegistration } from "@/domains/chat/hooks/use-chat-debug-registration";
import { useDeepLinkApp } from "@/domains/chat/hooks/use-deep-link-app";
import { useScrollToMessageParam } from "@/domains/chat/hooks/use-scroll-to-message";
import { lifecycleService } from "@/assistant/lifecycle-service";
import { isSending, useTurnStore } from "@/domains/chat/turn-store";
import { useOnboardingFocusStore } from "@/stores/onboarding-focus-store";
import { Button } from "@vellumai/design-library/components/button";

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
import { useChatHeaderRegistration } from "@/domains/chat/hooks/use-chat-header-registration";
import { useConversationChangeEffects } from "@/domains/chat/hooks/use-conversation-change-effects";
import { useComposerKeyboard } from "@/domains/chat/hooks/use-composer-keyboard";
import { useAutoSendEffects } from "@/domains/chat/hooks/use-auto-send-effects";
import { useOnboardingAttribution } from "@/hooks/use-onboarding-attribution";

import { ChatContentLayout } from "@/domains/chat/components/chat-content-layout";
import type { ChatMainPanelProps } from "@/domains/chat/components/chat-route-content";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ActiveChatView() {
  const showLlmInspector = useCanUseLlmInspector();
  const [searchParams, setSearchParams] = useSearchParams();
  const { conversationId: urlConversationId } = useParams<{ conversationId?: string }>();
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const assistantState = useAssistantLifecycleStore.use.assistantState();
  const turnPhase = useTurnStore.use.phase();

  // -------------------------------------------------------------------------
  // Chat session store — reactive selectors for per-conversation state
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Local state (not store-backed)
  // -------------------------------------------------------------------------
  const [showAddCreditsModal, setShowAddCreditsModal] = useState(false);

  const [refreshEpoch, setRefreshEpoch] = useState(0);
  const [assetsRefreshKey, setAssetsRefreshKey] = useState(0);

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
  const authUserId = useAuthStore.use.user()?.id ?? null;

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
  // Threaded down to ChatMainPanel and bound on the `<Transcript />`
  // instance there. Also read by useChatDebugRegistration for scroll state.
  const transcriptRef = useRef<TranscriptHandle | null>(null);
  // Written by ChatMainPanel every render with the exact `UIContext` it
  // renders from; read by useChatDebugRegistration so the debug snapshot
  // reflects on-screen state rather than a separate recomputation.
  const uiContextRef = useRef<UIContext | null>(null);

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

  // -------------------------------------------------------------------------
  // Reachability
  // -------------------------------------------------------------------------
  const reachability = useAssistantReachability(assistantId);
  const reachabilityReadyEpoch = useMemo(() => {
    if (reachability.state.phase === "ready") return refreshEpoch + 1;
    return 0;
  }, [reachability.state.phase, refreshEpoch]);

  // -------------------------------------------------------------------------
  // Disk pressure (only relevant for platform-hosted assistants)
  // -------------------------------------------------------------------------
  const isPlatformHosted = useActiveAssistantIsPlatformHosted();
  const diskPressure = useDiskPressureMonitor({
    assistantId,
    enabled: isPlatformHosted,
  });
  const diskPressureChatBlockReason = getDiskPressureChatBlockReason({
    monitorEnabled: diskPressure.mode !== null,
    hasResolvedStatus: diskPressure.hasResolvedStatus,
    status: diskPressure.status,
  });

  // -------------------------------------------------------------------------
  // Composer store — load drafts for the active assistant on mount / switch.
  // -------------------------------------------------------------------------
  // Note: Not a useEffect because loadAssistantDrafts is idempotent (no-ops
  // if already loaded for this assistant). Running during render ensures
  // drafts are available on first paint without a flash of empty state.
  useMemo(() => {
    if (assistantId) {
      // Pass the current conversation key so loadAssistantDrafts can save
      // any unsaved composer input into the outgoing assistant's draft map.
      const prevConvId = useChatSessionStore.getState().previousConversationId;
      useComposerStore.getState().loadAssistantDrafts(assistantId, prevConvId);
    }
  }, [assistantId]);

  // Keyboard focus: Electron host focus relay + typing auto-focus.
  useComposerKeyboard(inputRef);

  // Inbound deep links: pre-fill composer with `deeplink.send` text.
  useDeepLinkConsumer();

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

  // Avatar — called here so the cache is warm; ChatMainPanel has
  // its own call (TanStack Query deduplicates the fetch).
  useAssistantAvatar(assistantId);

  // -------------------------------------------------------------------------
  // Conversation loader
  // -------------------------------------------------------------------------
  const {
    refreshConversations,
    switchConversation,
    startNewConversation,
    conversationExistsOnServer,
    historyResult,
  } = useConversationLoader({
    assistantId,
    assistantStateKind: assistantState.kind,
    activeConversationId,
    urlConversationId: urlConversationId ?? null,
    searchParams,
    activeConversation,
    refreshEpoch,
    reachabilityReadyEpoch,
    onboardingDraftConversationIdRef,
  });

  // Persist the composer draft across reloads (debounced autosave + unload
  // flush) and restore it on cold load. Mounted after useConversationLoader
  // so the switchToConversation effect fires before restoreDraftIfEmpty.
  useDraftPersistence();

  // -------------------------------------------------------------------------
  // Message lifecycle — reconciliation, stream event handling, SSE
  // subscription, active-conversation message sync, and latest-message
  // refresh.
  // -------------------------------------------------------------------------
  const {
    startReconciliationLoop,
    cancelReconciliation,
    reconcileActiveConversation,
  } = useMessageLifecycle({
    assistantId,
    assistantStateKind: assistantState.kind,
    activeConversationId,
    conversationExistsOnServer,
    latestPageOldestTimestamp: historyResult.pagination.latestPageOldestTimestamp,
    reachability,
    setAssetsRefreshKey,
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
    uiContextRef,
    pendingOnboardingContextRef,
    onboardingDraftConversationIdRef,
    startReconciliationLoop,
    cancelReconciliation,
    refreshConversations,
  });

  // Auto-send: URL ?prompt=, pre-chat reachability probe, onboarding message.
  useAutoSendEffects({
    assistantId,
    activeConversationId,
    searchParams,
    setSearchParams,
    sendMessage,
    reachabilityPhase: reachability.state.phase,
    reachabilityProbe: reachability.probe,
    getPendingInitialMessage: () => peekPendingPreChatContext()?.initialMessage ?? undefined,
    getPendingInitialMessageHidden: () =>
      peekPendingPreChatContext()?.initialMessageHidden === true,
  });

  // Onboarding deep-link attribution: emit the research-onboarding check-in
  // funnel step when the user lands here from the Day-2 calendar event's CTA.
  useOnboardingAttribution({
    searchParams,
    setSearchParams,
    userId: authUserId,
  });

  useEffect(() => {
    if (reachability.state.phase !== "failed") return;
    useChatSessionStore.getState().setError({
      message: "Connection lost. Please try again.",
    });
  }, [reachability.state.phase]);

  // Focused research-onboarding "deeper dive": the results overlay (rendered
  // by ChatLayout, outside this component) stages a follow-up message; send it
  // through the real pipeline once the current turn is idle, then clear it.
  const pendingFollowupMessage =
    useOnboardingFocusStore.use.pendingFollowupMessage();
  useEffect(() => {
    if (!pendingFollowupMessage) return;
    if (isSending(useTurnStore.getState().phase)) return;
    useOnboardingFocusStore.getState().clearFollowup();
    void sendMessage(pendingFollowupMessage);
  }, [pendingFollowupMessage, sendMessage]);

  // Post-hatch "Connecting…" overlay lifecycle — pre-chat detector,
  // messages-arrived clear, safety timer, conversation-switch clear.
  const autoGreet = useAutoGreetGate(
    activeConversationId,
    peekPendingPreChatContext()?.initialMessage != null,
    onboardingConversationId,
  );

  // Stash the initial message before the first send consumes it from
  // sessionStorage, so the retry callback can re-send it.
  const initialMessageRef = useRef(
    peekPendingPreChatContext()?.initialMessage ?? null,
  );
  const handleAutoGreetRetry = useCallback(() => {
    const message = initialMessageRef.current;
    if (!message) {
      lifecycleService.clearExpectingFirstMessage();
      return;
    }
    if (isSending(useTurnStore.getState().phase)) return;
    lifecycleService.markExpectingFirstMessage();
    void sendMessage(message);
  }, [sendMessage]);

  // Deep-link: ?app=<id> auto-opens the app viewer on initial load.
  useDeepLinkApp(assistantId, searchParams);

  // Conversation-change side effects (dismiss prompts, reset subagent state,
  // auto-fetch subagent details for entries reconstructed from history)
  useConversationChangeEffects(assistantId, activeConversationId);

  // Debug API — dev-facing surface for in-the-moment chat inspection.
  // Unconditionally attached; negligible production overhead.
  useChatDebugRegistration({
    assistantId,
    sanitizedMessagesRef,
    transcriptItemsRef,
    transcriptRef,
    uiContextRef,
    reconcileActiveConversation,
  });

  // Deep-link: ?message=<id> scrolls to and highlights that message (e.g. the
  // "Open" button on a saved bookmark).
  useScrollToMessageParam({
    transcriptRef,
    searchParams,
    setSearchParams,
    conversationId: activeConversationId,
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
    activeConversation: activeConversation ?? null,
    refreshConversations,
    switchConversation,
  });

  // Manual "Refresh" menu item — re-fetch the latest history page through the
  // same TanStack Query invalidation the pull-to-refresh gesture uses, so the
  // transcript reconciles through the seq frontier exactly like a page reload.
  const invalidateHistory = historyResult.pagination.invalidate;
  const handleRefreshLatest = useCallback(() => {
    void invalidateHistory();
  }, [invalidateHistory]);

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
    onRefresh: handleRefreshLatest,
  });

  // -------------------------------------------------------------------------
  // Auto-greet connecting overlay — shows while waiting for the first
  // message after hatching. Hooks continue running (SSE, queries) so the
  // gate clears when the first message arrives.
  // -------------------------------------------------------------------------
  if (autoGreet.show) {
    const turnActive = turnPhase !== "idle";
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4">
        <p className="text-[var(--text-secondary)]">
          {autoGreet.timedOut
            ? turnActive
              ? "Your assistant is still working…"
              : "Your assistant is taking longer than expected."
            : "Starting your first conversation…"}
        </p>
        {autoGreet.timedOut && !turnActive && (
          <Button
            variant="outlined"
            size="regular"
            onClick={handleAutoGreetRetry}
          >
            Try again
          </Button>
        )}
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Props assembly — only values ChatMainPanel can't own locally
  // -------------------------------------------------------------------------
  const chatRouteProps: ChatMainPanelProps = {
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
    uiContextRef,

    // Onboarding
    onboardingTasksEmpty,
    didOnboarding,
    onboardingConversationId,
  };

  return (
    <>
      <ChatContentLayout {...chatRouteProps} />
      {showAddCreditsModal ? (
        <LazyBoundary>
          <AddCreditsModal
            open={showAddCreditsModal}
            onOpenChange={setShowAddCreditsModal}
          />
        </LazyBoundary>
      ) : null}

      {assistantId && (isTokenDialogOpen || complexDeployApp) ? (
        <LazyBoundary>
          <DeployDialogs
            assistantId={assistantId}
            assistantName={assistantName ?? undefined}
            onStartConversation={() => startNewConversation()}
          />
        </LazyBoundary>
      ) : null}
      <MobileChatOverlays />
    </>
  );
}
