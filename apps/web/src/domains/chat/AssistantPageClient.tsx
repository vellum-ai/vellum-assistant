
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Loader2 } from "lucide-react";
import { type Dispatch, type SetStateAction, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";

import { AddCreditsModal } from "@/components/shared/add-credits-modal.js";
import { ConnectingToAssistant } from "@/components/app/assistant/ConnectingToAssistant/ConnectingToAssistant.js";
import { Notice } from "@vellum/design-library";
import { Tabs } from "@vellum/design-library";
import { Typography } from "@vellum/design-library";
import { ContactsTab } from "@/components/app/intelligence/contacts/contacts-tab.js";
import { IdentityTab } from "@/components/app/intelligence/IdentityTab.js";
import { SkillsTab } from "@/components/app/intelligence/skills/SkillsTab.js";
import { ChatRouteContent } from "@/domains/chat/components/chat-route-content.js";
import { MobileAppOverlay } from "@/domains/chat/components/mobile-app-overlay.js";
import { MobileDocumentOverlay } from "@/domains/chat/components/mobile-document-overlay.js";
import { MobileSubagentDetailOverlay } from "@/domains/chat/components/mobile-subagent-detail-overlay.js";
import { AppViewerContainer } from "@/components/app/intelligence/apps/AppViewerContainer.js";
import { HomePage } from "@/domains/home/home-page.js";
import { LibraryView } from "@/components/app/intelligence/apps/LibraryView.js";
import { ConfirmDialog } from "@vellum/design-library";
import { VercelTokenDialog } from "@/components/app/intelligence/apps/vercel-token-dialog.js";
import { WorkspaceBrowser } from "@/components/app/intelligence/WorkspaceBrowser.js";
import { AssistantShell, type AssistantShellSideMenuArgs } from "@/components/shell/assistant-shell.js";
import { CommandPalette } from "@/components/app/assistant/CommandPalette/CommandPalette.js";
import { PreferencesMenu } from "@/components/shared/preferences-menu/preferences-menu.js";
import { ConversationActionsMenu } from "@/components/app/assistant/ConversationActionsMenu/ConversationActionsMenu.js";
import { ConversationAssetsPill } from "@/components/app/assistant/conversation-assets-pill/conversation-assets-pill.js";
import { Button } from "@vellum/design-library";
import {
  useChatAttachments,
} from "@/components/app/assistant/ChatAttachments/index.js";
import { RuleEditorModal } from "@/components/assistant/RuleEditorModal.js";
import {
  MicPermissionPrimer,
} from "@/components/app/assistant/MicPermissionPrimer.js";
import { ShareFeedbackModal } from "@/components/shared/ShareFeedbackModal/ShareFeedbackModal.js";

import { useVoiceInput } from "@/domains/chat/hooks/use-voice-input.js";
import { useIsMobile } from "@/hooks/use-is-mobile.js";
import { useVisibleViewport } from "@/hooks/use-visible-viewport.js";
import { useIsNativePlatform } from "@/lib/native-auth.js";
import {
  consumePendingPushNavigation,
  initializePushNotifications,
  setPushDeepLinkHandler,
} from "@/lib/push/register.js";
import { routes } from "@/lib/routes.js";
import {
  type ContextWindowUsage,
} from "@/components/assistant/ContextWindowIndicator.js";
import {
  PinnedAppsProvider,
} from "@/domains/chat/lib/pinnedAppsContext.js";
import { fetchSuggestion } from "@/domains/chat/lib/suggestion-api.js";
import { useAssistantAvatar } from "@/domains/avatar/use-assistant-avatar.js";
import { useDynamicFavicon } from "@/domains/avatar/use-dynamic-favicon.js";
import {
  setNotificationTapHandler,
} from "@/lib/notifications/native.js";
import {
  type Assistant,
  listAssistants,
} from "@/lib/assistants/api.js";

import { useAppFeatureFlags } from "@/lib/feature-flags/feature-flag-provider.js";
import {
  consumePendingPreChatContext,
  consumePendingAssistantName,
  type PreChatOnboardingContext,
} from "@/lib/onboarding/prechat.js";
import {
  getDiskPressureChatBlockReason,
  shouldEnableDiskPressureMonitor,
} from "@/lib/assistants/disk-pressure.js";
import { useAssistantReachability } from "@/lib/assistants/useAssistantReachability.js";
import { useDiskPressureMonitor } from "@/lib/assistants/useDiskPressureMonitor.js";
import { useAuth } from "@/lib/auth/auth-provider.js";
import {
  type AssistantIdentity,
  type AssistantSyncChangedEvent,
  type ChatEventStream,
  type Conversation,
  abortSubagent,
  fetchAssistantIdentity,
  fetchSubagentDetail,
} from "@/domains/chat/lib/api.js";
import {
  summarizeDisplayMessages,
} from "@/domains/chat/lib/diagnostics.js";
import {
  type DisplayMessage,
} from "@/domains/chat/lib/reconcile.js";
import { dedupingMessagesReducer } from "@/domains/chat/lib/message-state.js";
import { useMessageReconciliation } from "@/domains/chat/lib/use-message-reconciliation.js";
import { useConversationStarters } from "@/domains/chat/lib/use-conversation-starters.js";
import {
  createDraftConversationKey,
} from "@/domains/chat/lib/conversation-selection.js";
import { consumePendingInitialMessage } from "@/domains/chat/lib/initial-message-launch.js";
import { buildTranscriptItems } from "@/domains/chat/lib/transcript/build-items.js";
import type { TranscriptPaginationState } from "@/domains/chat/lib/transcript/types.js";
import {
  getThinkingStatusText,
  shouldShowThinkingIndicator,
  shouldShowAssistantBubble,
  isSendDisabled,
  type UIContext,
} from "@/domains/chat/lib/turn-selectors.js";
import {
  INITIAL_TURN_STATE,
  isSending,
  turnReducer,
} from "@/domains/chat/lib/turn-state-machine.js";
import {
  INITIAL_INTERACTION_STATE,
  interactionReducer,
} from "@/domains/chat/lib/interaction-state-machine.js";
import {
  INITIAL_SUBAGENT_STATE,
  subagentReducer,
  type SubagentStatus,
} from "@/domains/chat/lib/subagent-state.js";
import {
  INITIAL_CONVERSATION_LIST_STATE,
  conversationListReducer,
} from "@/domains/chat/lib/conversation-list-state.js";
import {
  INITIAL_VIEWER_STATE,
  viewerReducer,
  type MainView,
  type ViewerState,
} from "@/domains/chat/lib/viewer-state.js";
import { useNavigationHistory } from "@/domains/chat/lib/navigation-history.js";
import { isSurfaceInteractive } from "@/domains/chat/lib/types.js";
import { haptic } from "@/utils/haptics.js";
import { IOSAppSidebarEntry } from "@/components/app/assistant/IOSAppSidebarEntry/IOSAppSidebarEntry.js";
import { MacOSAppSidebarEntry } from "@/components/app/assistant/MacOSAppSidebarEntry/MacOSAppSidebarEntry.js";
import { GitHubNudgeSidebarEntry } from "@/components/app/assistant/GitHubNudgeSidebarEntry/GitHubNudgeSidebarEntry.js";
import { DiscordNudgeSidebarEntry } from "@/components/app/assistant/discord-nudge-sidebar-entry/discord-nudge-sidebar-entry.js";
import { AssistantSideMenu } from "@/components/app/assistant/AssistantSideMenu/AssistantSideMenu.js";
import { buildMoveToGroupTargets, isConversationPinned } from "@/domains/chat/lib/groupConversations.js";
import { isChannelConversation } from "@/domains/chat/lib/conversation-channel.js";
import {
  shouldSuppressGenericChatErrorNotice,
} from "@/domains/chat/lib/error-classification.js";
import {
  hasPendingAssistantResponse,
  identitiesEqual,
} from "@/domains/chat/utils/chat-utils.js";
import { useAppViewerActions } from "@/domains/chat/hooks/use-app-viewer-actions.js";
import { useConversationActions } from "@/domains/chat/hooks/use-conversation-actions.js";
import { useConversationSecondaryActions } from "@/domains/chat/hooks/use-conversation-secondary-actions.js";
import { useCommandPaletteSections } from "@/domains/chat/hooks/use-command-palette-sections.js";
import { useAssistantLifecycle } from "@/domains/chat/hooks/use-assistant-lifecycle.js";
import { useConversationGroupActions } from "@/domains/chat/hooks/use-conversation-group-actions.js";
import { useRefreshLatestMessages } from "@/domains/chat/hooks/use-refresh-latest-messages.js";
import { useStreamEventHandler } from "@/domains/chat/hooks/use-stream-event-handler.js";
import { useSendMessage } from "@/domains/chat/hooks/use-send-message.js";
import { useEventStream } from "@/domains/chat/hooks/use-event-stream.js";
import { useInteractionActions } from "@/domains/chat/hooks/use-interaction-actions.js";
import { useConversationLoader, MAX_CACHED_CONVERSATIONS } from "@/domains/chat/hooks/use-conversation-loader.js";
import { useAppNudges } from "@/domains/chat/hooks/use-app-nudges.js";
import { useRouting } from "@/domains/chat/hooks/use-routing.js";
import {
  createWebSyncRouter,
  type WebSyncRouter,
} from "@/lib/sync/web-sync-router.js";
import {
  invalidateAssistantConfigQueries,
  invalidateAssistantSchedulesQueries,
  invalidateAssistantSoundsQueries,
} from "@/lib/sync/query-tags.js";
import type { RefreshSettleHandle } from "@/domains/chat/hooks/use-pull-refresh.js";
import type { ChatError } from "@/domains/chat/types.js";
import { CleanupScreen } from "@/domains/chat/components/cleanup-screen.js";
import { PlatformHostedScreen } from "@/domains/chat/components/platform-hosted-screen.js";
import { SelfHostedScreen } from "@/domains/chat/components/self-hosted-screen.js";
import { SetupScreen } from "@/domains/chat/components/setup-screen.js";
import { VersionSelectionScreen } from "@/domains/chat/components/version-selection-screen.js";
import { ChatProvider } from "@/domains/chat/context/chat-context.js";


export default function AssistantPageWrapper() {
  return (
    <PinnedAppsProvider>
      <Suspense>
        <AssistantPage />
      </Suspense>
    </PinnedAppsProvider>
  );
}

function AssistantPage() {
  const { isLoggedIn, isLoading } = useAuth();
  const { push, replace, replaceUrl, searchParams } = useRouting();
  const queryClient = useQueryClient();
  const { analyzeConversation: analyzeConversationEnabled, chatPullToRefresh, conversationGroupsUI, deployToVercel, doctor, homePage: homePageEnabled, isNonProduction, multiPlatformAssistant, safeStorageLimits } = useAppFeatureFlags();
  const isRetired = searchParams.get("retired") === "true";
  const {
    assistantState,
    assistantId,
    setAssistantId,
    checkAssistant,
    retryAssistant,
    hatchVersion,
    autoGreetRef,
  } = useAssistantLifecycle({
    isLoggedIn,
    isLoading,
    isRetired,
    isNonProduction,
    onRedirect: replace,
  });
  const [messages, setMessages] = useReducer(dedupingMessagesReducer, []);
  const messagesRef = useRef<DisplayMessage[]>(messages);
  // Keep messagesRef in sync for synchronous reads outside state updaters.
  messagesRef.current = messages;
  const [input, setInput] = useState("");
  const draftsRef = useRef<Map<string, string>>(new Map());
  const previousConversationKeyRef = useRef<string | null>(null);
  const draftKeyResolutionRef = useRef(false);
  /**
   * Conversation key whose saved draft was just restored into the composer
   * via {@link useConversationLoader}'s `onDraftRestored` callback. Drives
   * the transient "Draft restored" notice that prevents the user from
   * mistaking restored draft text for stale unsent content.
   * `null` when no restored-draft notice should be shown.
   */
  const [restoredDraftConversationKey, setRestoredDraftConversationKey] =
    useState<string | null>(null);
  // Per-conversation message cache: avoids re-fetching stale server history
  // when switching back to a recently-viewed conversation. Matches macOS
  // ConversationSelectionStore.chatViewModels cache with LRU eviction.
  const conversationCacheRef = useRef<Map<string, { messages: DisplayMessage[]; pagination: { hasMore: boolean; oldestTimestamp: number | null } }>>(new Map());
  const isNative = useIsNativePlatform();
  const [turnState, dispatchTurn] = useReducer(turnReducer, INITIAL_TURN_STATE);
  const turnStateRef = useRef(turnState);
  useLayoutEffect(() => { turnStateRef.current = turnState; }, [turnState]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [error, setError] = useState<ChatError | null>(null);
  const [compactionCircuitOpenUntil, setCompactionCircuitOpenUntil] = useState<Date | null>(null);
  const [showAddCreditsModal, setShowAddCreditsModal] = useState(false);
  const [conversationListState, dispatchConversationList] = useReducer(conversationListReducer, INITIAL_CONVERSATION_LIST_STATE);
  const { conversations, conversationGroups, activeConversationKey, editingConversationKey, processingKeys, attentionKeys } = conversationListState;
  const conversationsRef = useRef<Conversation[]>(conversations);
  conversationsRef.current = conversations;
  const processingSnapshotsRef = useRef<Map<string, string | undefined>>(new Map());
  const reachability = useAssistantReachability(assistantId);
  const proactivelyCheckedAssistantIdRef = useRef<string | null>(null);
  const activeAssistantIsLocal =
    assistantState.kind === "active" && assistantState.isLocal;

  useEffect(() => {
    if (assistantState.kind !== "active" || activeAssistantIsLocal || !assistantId) {
      return;
    }
    if (proactivelyCheckedAssistantIdRef.current === assistantId) {
      return;
    }
    proactivelyCheckedAssistantIdRef.current = assistantId;
    reachability.probe({ showConnectingImmediately: false });
  }, [
    assistantId,
    assistantState.kind,
    activeAssistantIsLocal,
    reachability.probe,
  ]);
  // Bumps every time the reachability hook transitions to `ready` -- used
  // as a dependency of the init / identity fetch effects so that
  // conversations and the assistant identity re-fetch themselves after
  // the pod comes back from a restart, without requiring the user to
  // reload the page.
  const [reachabilityReadyEpoch, setReachabilityReadyEpoch] = useState(0);
  const lastReachabilityPhaseRef = useRef(reachability.state.phase);
  useEffect(() => {
    const previous = lastReachabilityPhaseRef.current;
    lastReachabilityPhaseRef.current = reachability.state.phase;
    if (reachability.state.phase === "ready" && previous !== "ready") {
      setReachabilityReadyEpoch((n) => n + 1);
    }
  }, [reachability.state.phase]);
  // Manual refresh counter — incrementing this causes the init effect to
  // re-run, re-fetching the chat context and reconnecting the SSE stream.
  const [refreshEpoch, setRefreshEpoch] = useState(0);

  const diskPressureMonitorEnabled = shouldEnableDiskPressureMonitor({
    safeStorageLimits,
    assistantStateKind: assistantState.kind,
    assistantId,
  });
  const diskPressureMonitor = useDiskPressureMonitor({
    assistantId,
    enabled: diskPressureMonitorEnabled,
    refreshKey: reachabilityReadyEpoch,
  });
  const {
    status: diskPressureStatus,
    mode: diskPressureMode,
    hasResolvedStatus: hasResolvedDiskPressureStatus,
    isAcknowledging: isAcknowledgingDiskPressure,
    acknowledgeError: diskPressureAcknowledgeError,
    acknowledge: acknowledgeDiskPressure,
    applyStatusEvent: applyDiskPressureStatusEvent,
  } = diskPressureMonitor;
  const { starters: conversationStarters } = useConversationStarters(assistantId);
  const [streamRetryNonce, setStreamRetryNonce] = useState(0);
  const [interactionState, dispatchInteraction] = useReducer(interactionReducer, INITIAL_INTERACTION_STATE);
  const interactionStateRef = useRef(interactionState);
  interactionStateRef.current = interactionState;
  const { pendingSecret, pendingConfirmation, pendingContactRequest, inlineConfirmationToolCallId } = interactionState;
  const [subagentState, dispatchSubagent] = useReducer(subagentReducer, INITIAL_SUBAGENT_STATE);
  const subagentEntries = useMemo(
    () => subagentState.orderedIds.map((id) => subagentState.byId[id]!),
    [subagentState],
  );
  const inlineConfirmationAttached = inlineConfirmationToolCallId !== null;
  const [contextWindowUsage, setContextWindowUsage] = useState<ContextWindowUsage | null>(null);
  const [suggestion, setSuggestion] = useState<string | null>(null);

  const {
    components: avatarComponents,
    traits: avatarTraits,
    customImageUrl: avatarImageUrl,
    invalidate: invalidateAvatar,
  } = useAssistantAvatar(assistantId);
  useDynamicFavicon(avatarImageUrl, avatarComponents, avatarTraits);
  // Deterministic mapping from confirmation requestId → the tool call ID that
  // hosted the inline prompt. Used by handleConfirmationSubmit to stamp risk
  // metadata on the correct tool call instead of relying on a heuristic.
  const confirmationToolCallMapRef = useRef<Map<string, string>>(new Map());
  // Retained after the legacy sidebar removal: these setters are still called
  // from the multi-assistant identity-name resolution effect and from error
  // recovery paths even though the read-side (`assistants`, `identityNames`)
  // is no longer rendered directly by this component.
  const [, setAssistants] = useState<Assistant[]>([]);
  const [, setIdentityNames] = useState<Map<string, string>>(new Map());
  // Seed with the optimistic name written by PreChatFlow.finish() so the
  // sidebar label is correct on the very first render — before the async
  // fetchAssistantIdentity round-trip completes. The key is consumed (and
  // cleared from sessionStorage) here so a later refresh falls back to the
  // real identity fetch. The full identity object overwrites this stub once
  // the real fetch resolves.
  const [assistantIdentity, setAssistantIdentity] = useState<AssistantIdentity | null>(() => {
    const optimisticName = consumePendingAssistantName();
    if (!optimisticName) return null;
    return {
      name: optimisticName,
      role: "",
      personality: "",
      emoji: "",
      home: "",
      version: "",
    };
  });
  // Deep-link support: ?view=library|intelligence switches the panel,
  // ?app=<id> auto-opens an app (always implies "app" view, overrides ?view),
  // ?skill=<id> auto-opens the intelligence panel on the Skills tab with the
  // given skill selected (implies "intelligence" view + "skills" tab).
  // /assistant/library opens the Library view.
  // /assistant/library/<slug> auto-opens the named app (slug = dirName or
  // appId, same resolution as ?app=).
  // /assistant/contacts and /assistant/contacts/:id open the Contacts tab.
  // Values captured in refs so they survive URL cleanup below.
  const deepLinkSkillId = useRef(searchParams.get("skill") ?? undefined);
  const initialPathname = typeof window !== "undefined" ? window.location.pathname : "";
  const isContactsPath =
    initialPathname === routes.contacts.root ||
    initialPathname.startsWith(routes.contacts.root + "/");
  const isIdentityPath = initialPathname === routes.identity;
  const isWorkspacePath = initialPathname === routes.workspace;
  const isHomePath = initialPathname === routes.home;
  const isLibraryPath = initialPathname === routes.library.root;
  // /assistant/library/<slug> opens the named app. <slug> accepts either a
  // dirName (e.g. "support-monitor") or an appId UUID — server-side `openApp`
  // resolves both. Captured here so the existing deep-link auto-open flow
  // (which consumes `deepLinkAppId.current`) works without any extra wiring.
  const libraryAppSlug =
    initialPathname.startsWith(routes.library.root + "/")
      ? initialPathname.slice(routes.library.root.length + 1) || null
      : null;
  const [initialDeepLinkAppId] = useState(() => searchParams.get("app") ?? libraryAppSlug ?? undefined);
  const deepLinkAppId = useRef(initialDeepLinkAppId);
  const initialContactId = useRef<string | null>(
    isContactsPath ? initialPathname.slice(routes.contacts.root.length + 1) || null : null,
  );
  const contactsSelectedIdRef = useRef<string | null>(initialContactId.current);
  const [initialDeepLinkRoute] = useState(() =>
    typeof window !== "undefined" && window.location.hash
      ? window.location.hash.slice(1)
      : undefined,
  );
  const deepLinkRoute = useRef(initialDeepLinkRoute);
  const [viewerState, dispatchViewer] = useReducer(viewerReducer, undefined, (): ViewerState => {
    const initialMainView = (() => {
      if (deepLinkAppId.current) return "app" as const;
      if (deepLinkSkillId.current) return "intelligence" as const;
      const v = searchParams.get("view");
      if (v === "library" || v === "intelligence") return v;
      if (isHomePath && homePageEnabled) return "home" as const;
      if (isLibraryPath) return "library" as const;
      if (isContactsPath) return "intelligence" as const;
      if (isIdentityPath) return "intelligence" as const;
      if (isWorkspacePath) return "intelligence" as const;
      return "chat" as const;
    })();
    const initialIntelligenceTab = (() => {
      if (deepLinkSkillId.current) return "skills" as const;
      if (isContactsPath) return "contacts" as const;
      if (isWorkspacePath) return "workspace" as const;
      return "identity" as const;
    })();
    return {
      ...INITIAL_VIEWER_STATE,
      mainView: initialMainView,
      activeAppId: deepLinkAppId.current ?? null,
      intelligenceTab: initialIntelligenceTab,
    };
  });
  const { mainView, activeAppId, openedAppState, openedDocumentState, isAppMinimized, intelligenceTab, assetsRefreshKey, activeSubagentId, isSharing, isDeploying, showTokenDialog, pendingDeployAppId, complexDeployApp } = viewerState;
  const isMobile = useIsMobile();
  // Detect the on-screen keyboard so the composer can hug it on mobile —
  // the AssistantShell drops its bottom safe-area inset, and the wrapper
  // below tightens its own padding to match. Mirrors the threshold used
  // in AssistantShell so both components flip in sync.
  const visibleViewport = useVisibleViewport();
  const isKeyboardOpen =
    isMobile &&
    visibleViewport !== null &&
    visibleViewport.keyboardHeight > 100;

  // Compatibility wrappers for hooks that accept Dispatch<SetStateAction<...>>.
  // These are thin stable callbacks that forward to dispatchViewer so existing
  // hook signatures don't need to change in this PR.
  const viewerStateRef = useRef(viewerState);
  viewerStateRef.current = viewerState;
  const setMainView = useCallback(
    (viewOrUpdater: SetStateAction<MainView>) => {
      const view =
        typeof viewOrUpdater === "function"
          ? viewOrUpdater(viewerStateRef.current.mainView)
          : viewOrUpdater;
      dispatchViewer({ type: "SET_MAIN_VIEW", view });
    },
    [],
  ) satisfies Dispatch<SetStateAction<MainView>>;
  const setAssetsRefreshKey = useCallback(
    (_updater: SetStateAction<number>) => {
      dispatchViewer({ type: "REFRESH_ASSETS" });
    },
    [],
  ) satisfies Dispatch<SetStateAction<number>>;

  const lastConversationKeyRef = useRef<string | null>(null);
  const switchConversationRef = useRef<(key: string) => void>(() => {});

  // Navigation history for Back/Forward support
  const {
    canGoBack: navCanGoBack,
    canGoForward: navCanGoForward,
    push: navPush,
    remapConversationKey: navRemapKey,
    goBack: navGoBack,
    goForward: navGoForward,
  } = useNavigationHistory();

  // Seed the initial view into navigation history so the first Back works.
  const navHistorySeededRef = useRef(false);
  useEffect(() => {
    if (navHistorySeededRef.current) return;
    if (mainView === "app" && activeAppId) {
      navPush({ type: "app", appId: activeAppId });
      navHistorySeededRef.current = true;
    } else if (mainView === "intelligence") {
      navPush({ type: "intelligence" });
      navHistorySeededRef.current = true;
    } else if (mainView === "library") {
      navPush({ type: "library" });
      navHistorySeededRef.current = true;
    } else if (mainView === "home") {
      navPush({ type: "home" });
      navHistorySeededRef.current = true;
    } else if (mainView === "chat" && activeConversationKey) {
      navPush({ type: "conversation", key: activeConversationKey });
      navHistorySeededRef.current = true;
    }
  }, [mainView, activeConversationKey, activeAppId]);

  // Clean consumed deep-link params from the URL so they don't re-trigger on
  // component remount (same pattern as the ?onboarding= cleanup below).
  useEffect(() => {
    const params = new URLSearchParams(searchParams.toString());
    let dirty = false;
    if (params.has("app")) { params.delete("app"); dirty = true; }
    if (params.has("view")) { params.delete("view"); dirty = true; }
    if (params.has("skill")) { params.delete("skill"); dirty = true; }
    if (dirty || window.location.hash) {
      const query = params.toString();
      const clean = query ? `?${query}` : window.location.pathname;
      replaceUrl(clean);
    }
  }, []);
  // Keep the URL in sync with contacts, identity, and workspace tab state.
  // Uses replaceState (not router.push) to avoid triggering a Next.js navigation
  // that would remount the page and tear down the chat.
  //
  // Next.js patches replaceState to sync usePathname/useSearchParams, so
  // path-only writes silently wipe query params (e.g. conversationKey).
  // Preserve search + hash the same way the library sync below does.
  useEffect(() => {
    const writePath = (nextPath: string) => {
      if (window.location.pathname === nextPath) return;
      replaceUrl(`${nextPath}${window.location.search}${window.location.hash}`);
    };
    if (mainView !== "intelligence") {
      if (
        window.location.pathname.startsWith(routes.contacts.root) ||
        window.location.pathname === routes.identity ||
        window.location.pathname === routes.workspace
      ) {
        writePath(routes.assistant);
      }
      return;
    }
    if (intelligenceTab === "contacts") {
      const id = contactsSelectedIdRef.current;
      const target = id ? routes.contacts.detail(id) : routes.contacts.root;
      writePath(target);
    } else if (intelligenceTab === "identity") {
      writePath(routes.identity);
    } else if (intelligenceTab === "workspace") {
      writePath(routes.workspace);
    } else {
      // Skills — no dedicated path; reset any intelligence path.
      if (
        window.location.pathname.startsWith(routes.contacts.root) ||
        window.location.pathname === routes.identity ||
        window.location.pathname === routes.workspace
      ) {
        writePath(routes.assistant);
      }
    }
  }, [mainView, intelligenceTab]);

  // Keep the URL in sync with the Library view + open-app state. Mirrors the
  // intelligence sync above — replaceState so we don't remount the page.
  //
  // Three shapes:
  //   - mainView === "library"                   → /assistant/library
  //   - mainView === "app" | "app-editing"
  //     && openedAppState is loaded              → /assistant/library/<slug>
  //   - any other view                           → clear if currently on a
  //                                                library path
  //
  // We wait for `openedAppState` before writing the per-app URL so the slug
  // can prefer `dirName` ("support-monitor") over the appId UUID — much
  // friendlier to share. Until the app resolves, the URL stays at whatever
  // it was (either the original deep-link path or the bare library root).
  useEffect(() => {
    // Path-only writes here would drop query params + hash that other
    // call sites set (e.g. `handleEditApp` sets `?conversationKey=...` so a
    // refresh inside app editing restores the right conversation). Rebuild
    // every replaceState as `<path><search><hash>` to preserve them across
    // the path swap.
    const libraryRoot = routes.library.root;
    const writePath = (nextPath: string) => {
      if (window.location.pathname === nextPath) return;
      replaceUrl(`${nextPath}${window.location.search}${window.location.hash}`);
    };
    if (mainView === "library") {
      writePath(libraryRoot);
      return;
    }
    if (mainView === "app" || mainView === "app-editing") {
      // Once the app has loaded, prefer dirName ("support-monitor") over the
      // UUID for the slug. Until it loads, leave the URL alone so a fresh
      // /assistant/library/<slug> deep-link doesn't get cleared mid-load
      // and a Library-card click doesn't transiently wipe the path either.
      if (openedAppState) {
        const slug = openedAppState.dirName ?? openedAppState.appId;
        writePath(routes.library.app(slug));
      }
      return;
    }
    const pathname = window.location.pathname;
    if (pathname === libraryRoot || pathname.startsWith(libraryRoot + "/")) {
      writePath(routes.assistant);
    }
  }, [mainView, openedAppState]);

  // Keep the URL in sync with the Home view. Mirrors the library sync above.
  useEffect(() => {
    if (mainView === "home") {
      if (window.location.pathname !== routes.home) {
        window.history.replaceState(null, "", routes.home);
      }
      return;
    }
    // Clear home path when navigating away, preserving query params
    // (e.g. ?conversationKey=draft-xxx set by startNewConversation).
    if (window.location.pathname === routes.home) {
      window.history.replaceState(
        null,
        "",
        `${routes.assistant}${window.location.search}`,
      );
    }
  }, [mainView]);

  const handleContactSelected = useCallback((contactId: string | null) => {
    contactsSelectedIdRef.current = contactId;
    if (mainView === "intelligence" && intelligenceTab === "contacts") {
      const target = contactId ? routes.contacts.detail(contactId) : routes.contacts.root;
      if (window.location.pathname !== target) {
        replaceUrl(`${target}${window.location.search}${window.location.hash}`);
      }
    }
  }, [mainView, intelligenceTab]);

  const historyLoadedRef = useRef(false);
  const loadEpochRef = useRef(0);
  const [transcriptPagination, setTranscriptPagination] = useState<
    Omit<TranscriptPaginationState, "items">
  >({
    hasMore: false,
    oldestTimestamp: null,
    isLoadingOlder: false,
    isPinnedToLatest: true,
  });
  const isLoadingOlderRef = useRef(false);
  const initialPageOldestTsRef = useRef<number | null>(null);
  const streamRef = useRef<ChatEventStream | null>(null);
  const needsNewBubbleRef = useRef(true);
  const streamEpochRef = useRef(0);
  const reconcileAfterNextStreamOpenRef = useRef(false);
  const syncNeedsNewBubbleFromMessages = useCallback((nextMessages: DisplayMessage[]) => {
    const last = nextMessages[nextMessages.length - 1];
    needsNewBubbleRef.current = !(last?.role === "assistant" && last.isStreaming);
  }, []);
  const [autoGreetPending, setAutoGreetPending] = useState(false);
  // PreChat onboarding context handed off from `/onboarding/prechat`.
  // Drained by the FIRST `postChatMessage` call after mount so the
  // auto-greet (or whichever message lands first) carries the wire
  // payload mirroring macOS `MessageClient.swift`. Consume-once at both
  // the storage layer (`consumePendingPreChatContext`) and this ref.
  const pendingOnboardingContextRef = useRef<PreChatOnboardingContext | null>(
    null,
  );
  // Fresh draft key used only for the post-onboarding auto-greet. This prevents
  // stale background conversations from becoming the first foreground chat.
  const onboardingDraftConversationKeyRef = useRef<string | null>(null);
  // Set true when the ?onboarding=1 signal is consumed. Triggers a
  // one-shot identity re-fetch after the first assistant response lands
  // so the name written by persistOnboardingArtifacts shows up in the
  // sidebar without a manual refresh.
  const didOnboardingRef = useRef(false);

  // Queue tracking: FIFO of stableIds for messages awaiting `message_queued`
  // correlation, and a map from daemon-assigned requestId → stableId.
  const pendingQueuedStableIdsRef = useRef<string[]>([]);
  const requestIdToStableIdRef = useRef<Map<string, string>>(new Map());
  // Messages cancelled locally before the daemon's `message_queued` ack.
  // The FIFO stays intact so ack ordering is preserved; once the ack
  // provides the requestId the deletion is forwarded to the daemon.
  const pendingLocalDeletionsRef = useRef<Set<string>>(new Set());
  const streamingMessageIdsRef = useRef<Set<string>>(new Set());

  const conversationListInvalidatedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dismissedSurfaceIdsRef = useRef<Set<string>>(new Set());
  const expandedToolCallIdsRef = useRef<Set<string>>(new Set());
  // Cache context window usage per conversation key so the indicator persists
  // across conversation switches (mirroring desktop's per-conversation ChatViewModel).
  // Hydrated from localStorage in an effect below so the indicator survives
  // page reloads for conversations visited in prior sessions.
  const contextWindowUsageByConversationRef = useRef<Map<string, ContextWindowUsage>>(new Map());
  const streamContextRef = useRef<{
    assistantId: string;
    conversationKey: string;
  } | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const pendingInitialMessageRef = useRef<{ conversationKey: string; content: string } | null>(null);
  // Stores the groupId a conversation belonged to before it was pinned,
  // so we can restore it on unpin (matching macOS prePinGroupIds behaviour).
  const prePinGroupIdsRef = useRef<Map<string, string | undefined>>(new Map());
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

  const {
    voiceInputRef,
    voiceInterim,
    voiceError,
    clearVoiceError,
    setVoiceError,
    showPrimer,
    handleVoiceBeforeStart,
    handleVoiceTranscript,
    handleVoiceRecordingChange,
    setVoiceInterim,
    handlePrimerContinue,
    handlePrimerCancel,
    handleRetryMicPermission,
  } = useVoiceInput({
    assistantId,
    inputRef,
    setInput,
  });

  const {
    isOnIOS,
    isOnNudgePlatform,
    nudge,
    showBanner,
    githubNudge,
    showGitHubBanner,
    showGitHubSidebar,
    discordNudge,
    showDiscordBanner,
    showDiscordSidebar,
  } = useAppNudges(messages, conversations.length, streamingMessageIdsRef);

  // ---------------------------------------------------------------------------
  // Ghost-text autocomplete: fetch a suggestion after each completed assistant turn
  // ---------------------------------------------------------------------------
  const lastSuggestionMsgIdRef = useRef<string | null>(null);
  // Ref to current input so the fetch resolver can detect typing-after-fetch
  // races without re-running the effect on every keystroke.
  const inputRef2 = useRef(input);
  useEffect(() => { inputRef2.current = input; }, [input]);
  useEffect(() => {
    const lastMsg = messages[messages.length - 1];
    if (!lastMsg || lastMsg.role !== "assistant" || lastMsg.isStreaming) return;
    if (!assistantId || !activeConversationKey) return;
    if (lastMsg.id === lastSuggestionMsgIdRef.current) return;
    lastSuggestionMsgIdRef.current = lastMsg.id ?? null;
    const controller = new AbortController();
    fetchSuggestion(assistantId, activeConversationKey, lastMsg.id, controller.signal)
      .then((r) => {
        if (controller.signal.aborted) return;
        // If the user already started typing, don't clobber their input with
        // a late-arriving ghost suggestion.
        if (inputRef2.current) return;
        setSuggestion(r.suggestion);
      })
      .catch(() => {});
    return () => { controller.abort(); };
  }, [messages, assistantId, activeConversationKey]);

  // Derived values from turn state machine
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
  const activeConversationIsProcessing =
    activeConversationKey != null && processingKeys.has(activeConversationKey);
  const activeConversationHasPendingAssistantResponse = useMemo(
    () => hasPendingAssistantResponse(messages),
    [messages],
  );

  const uiContext: UIContext = {
    hasStreamingAssistantMessage: messages.some((m) => m.isStreaming),
    hasPendingSecret: !!pendingSecret,
    hasPendingConfirmation: !!pendingConfirmation,
    hasUncompletedVisibleSurface,
    activeConversationIsProcessing,
    hasPendingAssistantResponse: activeConversationHasPendingAssistantResponse,
  };
  const showThinking = shouldShowThinkingIndicator(turnState, uiContext);
  const _showAssistantBubble = shouldShowAssistantBubble(turnState, uiContext);
  const diskPressureChatBlockReason = getDiskPressureChatBlockReason({
    monitorEnabled: diskPressureMonitorEnabled,
    hasResolvedStatus: hasResolvedDiskPressureStatus,
    status: diskPressureStatus,
  });
  const diskPressureInputDisabled = diskPressureChatBlockReason !== null;
  const activeConversation = useMemo(
    () =>
      conversations.find(
        (conversation) => conversation.conversationKey === activeConversationKey,
      ),
    [activeConversationKey, conversations],
  );

  // Conversations bound to an external channel (Slack, Telegram, voice, etc.)
  // are read-only from the desktop/web/iOS surface because the daemon does
  // not mirror outbound writes back to the source channel. Mirrors the
  // macOS gate in PanelCoordinator.swift + ChatView.swift.
  const isChannelReadonly = isChannelConversation(activeConversation);
  const typingDisabled =
    isLoadingHistory ||
    (assistantState.kind === "active" && !!assistantState.maintenanceMode?.enabled) ||
    diskPressureInputDisabled ||
    isChannelReadonly;
  const sendDisabled =
    isSendDisabled(turnState, uiContext) || typingDisabled;
  const activeConversationKeyRef = useRef<string | null>(activeConversationKey);
  useEffect(() => {
    activeConversationKeyRef.current = activeConversationKey;
    if (activeConversationKey) {
      lastConversationKeyRef.current = activeConversationKey;
    }
  }, [activeConversationKey]);

  // Latest committed assistantId — guards in-flight fetches against id swaps.
  const assistantIdRef = useRef<string | null>(assistantId);
  useEffect(() => {
    assistantIdRef.current = assistantId;
  }, [assistantId]);

  const refreshSettleRef = useRef<RefreshSettleHandle | null>(null);

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
    pushRoute: push,
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
    interactionStateRef,
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
    dispatchConversationList,
    setMessages,
    setTranscriptPagination,
    setIsLoadingHistory,
    setError,
    dispatchInteraction,
    setAutoGreetPending,
    setContextWindowUsage,
    setSuggestion,
    setCompactionCircuitOpenUntil,
    setInput,
    setMainView,
    dispatchTurn,
    dispatchSubagent,
    resetChatAttachments,
    syncNeedsNewBubbleFromMessages,
    navPush,
    onDraftRestored: setRestoredDraftConversationKey,
    shouldSuppressGenericChatErrorNotice,
  });

  // Wrap conversation-switching functions to eagerly reset subagent state
  // before the URL roundtrip updates activeConversationKey.
  const switchConversation = useCallback(
    (key: string) => {
      dispatchSubagent({ type: "SUBAGENT_RESET" });
      rawSwitchConversation(key);
    },
    [rawSwitchConversation],
  );
  const startNewConversation = useCallback(
    (opts: { silent?: boolean; initialMessage?: string } = {}) => {
      dispatchSubagent({ type: "SUBAGENT_RESET" });
      rawStartNewConversation(opts);
    },
    [rawStartNewConversation],
  );

  useEffect(() => {
    const message = consumePendingInitialMessage();
    if (!message) {
      return;
    }
    startNewConversation({ initialMessage: message });
  }, [startNewConversation]);
  // "Move to Group" targets for the active conversation's topbar menu.
  const _activeConversationMoveTargets = useMemo(
    () =>
      conversationGroupsUI && activeConversation
        ? buildMoveToGroupTargets(activeConversation, conversationGroups)
        : [],
    [conversationGroupsUI, activeConversation, conversationGroups],
  );

  const hasPersistedMessage = useMemo(() => messages.some((m) => m.id), [messages]);
  const hasNonEmptyMessage = useMemo(() => messages.some((m) => m.content.trim().length > 0), [messages]);

  const handleReviewDiskUsage = useCallback(() => {
    haptic.light();
    navPush({ type: "intelligence" });
    dispatchViewer({ type: "SET_MAIN_VIEW", view: "intelligence" });
    dispatchViewer({ type: "SET_INTELLIGENCE_TAB", tab: "workspace" });
  }, [navPush]);

  const pushToAiSettings = useCallback(() => push(routes.settings.ai), [push]);

  const {
    startReconciliationLoop,
    cancelReconciliation,
    reconcileActiveConversation,
  } = useMessageReconciliation({
    setMessages,
    streamContextRef,
    streamEpochRef,
    activeConversationKeyRef,
    dispatchTurn,
    turnStateRef,
    initialPageOldestTsRef,
  });

  // Consume the `?onboarding=1` signal left by `/onboarding/hatching` when
  // it forwards the user after a successful hatch. We only see this on the
  // very first mount post-onboarding; flipping `autoGreetRef` here mirrors
  // the existing auto-greet paths (auto_hatch branch, handleHatchNewAssistant)
  // so the first assistant message ("Wake up, my friend!") fires once the
  // chat history loads. The flag is stripped from the URL immediately so a
  // page refresh doesn't re-trigger the greet.
  useEffect(() => {
    if (searchParams.get("onboarding") !== "1") return;
    autoGreetRef.current = true;
    didOnboardingRef.current = true;
    const onboardingDraftKey =
      onboardingDraftConversationKeyRef.current ?? createDraftConversationKey();
    onboardingDraftConversationKeyRef.current = onboardingDraftKey;
    // Drain any pending PreChat context from sessionStorage at the same
    // moment the auto-greet is armed. Tying the two together keeps the
    // onboarding payload from leaking onto a later message and ensures
    // it only ever rides along the single greet send.
    //
    // React strict-mode double-fires effects in dev; the second
    // invocation would otherwise overwrite the ref with `null`
    // (sessionStorage was already drained on the first call). Guard so
    // the second invocation is a no-op.
    if (pendingOnboardingContextRef.current === null) {
      pendingOnboardingContextRef.current = consumePendingPreChatContext();
    }
    const params = new URLSearchParams(searchParams.toString());
    params.delete("onboarding");
    params.set("conversationKey", onboardingDraftKey);
    replace(`?${params.toString()}`);
  }, [searchParams, replace]);

  // Register the notification tap handler once per mount. Routes through
  // switchConversationRef so all conversation switches (sidebar taps,
  // notification taps) go through the same code path.
  useEffect(() => {
    setNotificationTapHandler((payload) => {
      if (payload.conversationKey) {
        switchConversationRef.current(payload.conversationKey);
      }
    });
  }, []);

  // APNs remote push registration (Capacitor iOS only). The push module
  // module-level guard dedupes listener wiring across re-renders; this
  // effect re-runs on assistantId switches so the token row gets re-POSTed
  // under the new assistant when the user changes pods. Logout DELETE
  // lands in PR 11.
  useEffect(() => {
    if (!assistantId) return;
    void initializePushNotifications(assistantId);
  }, [assistantId]);

  // APNs deep-link wiring (PR 10). One-mount effect:
  //
  //   1. Registers a live deep-link handler so that
  //      `pushNotificationActionPerformed` events fired while this client
  //      is mounted (background → foreground tap) navigate immediately
  //      via Next.js router instead of stashing on `pushState`.
  //   2. Drains any pending cold-launch deep link the
  //      `pushNotificationActionPerformed` listener stashed *before* React
  //      mounted (app fully suspended → tap → cold launch). Reading is
  //      atomic with clearing so a re-mount cannot re-navigate.
  //
  // The cleanup unregisters the live handler so a subsequent action that
  // arrives after unmount (e.g. mid-route-transition) falls back to the
  // stash path and is consumed by the next mount.
  useEffect(() => {
    setPushDeepLinkHandler((deepLink: string) => {
      push(deepLink);
    });
    const pending = consumePendingPushNavigation();
    if (pending) {
      push(pending);
    }
    return () => {
      setPushDeepLinkHandler(null);
    };
  }, [push]);

  // Refetch canonical identity. Reads `assistantIdRef` so the callback stays
  // referentially stable across assistant switches, avoiding cascade
  // invalidations of `handleStreamEvent` (and anything memoized on it).
  //
  // `preserveOnFailure=true` is for callers where the fetch racing against a
  // pending IDENTITY.md write is expected (post-onboarding re-fetch; SSE
  // invalidation): a transient null shouldn't blank an already-populated
  // identity. The active-assistant switch effect uses the default (false) so
  // switching to a failing assistant clears the previous name.
  const refreshAssistantIdentity = useCallback(
    async (preserveOnFailure = false) => {
      const targetId = assistantIdRef.current;
      if (!targetId) return;
      const identity = await fetchAssistantIdentity(targetId);
      if (assistantIdRef.current !== targetId) return;
      if (identity === null && preserveOnFailure) return;
      setAssistantIdentity((prev) => (identitiesEqual(prev, identity) ? prev : identity));
    },
    [],
  );

  const invalidateAssistantConfig = useCallback(() => {
    invalidateAssistantConfigQueries(queryClient, assistantIdRef.current);
  }, [queryClient, assistantIdRef]);

  const invalidateAssistantSounds = useCallback(() => {
    invalidateAssistantSoundsQueries(queryClient, assistantIdRef.current);
  }, [queryClient, assistantIdRef]);

  const invalidateAssistantSchedules = useCallback(() => {
    invalidateAssistantSchedulesQueries(queryClient, assistantIdRef.current);
  }, [queryClient, assistantIdRef]);

  const syncRouterRef = useRef<WebSyncRouter | null>(null);
  useEffect(() => {
    const syncRouter = createWebSyncRouter({
      activeConversationKeyRef,
      invalidateAvatar,
      refreshAssistantIdentity,
      invalidateAssistantConfig,
      invalidateAssistantSounds,
      invalidateAssistantSchedules,
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
    activeConversationKeyRef,
    invalidateAvatar,
    refreshAssistantIdentity,
    invalidateAssistantConfig,
    invalidateAssistantSounds,
    invalidateAssistantSchedules,
    scheduleConversationListRefetch,
    reconcileActiveConversation,
  ]);

  const dispatchSyncChanged = useCallback(
    (event: AssistantSyncChangedEvent) => {
      void syncRouterRef.current?.dispatchSyncChanged(event);
    },
    [],
  );

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
  });

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
    turnStateRef,
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
    dispatchConversationList,
    dispatchInteraction,
    setStreamRetryNonce,
    setInput,
    dispatchTurn,
    dispatchSubagent,
    startReconciliationLoop,
    cancelReconciliation,
    refreshConversations,
    navRemapKey,
    replaceUrl,
  });

  // Wrap the hook's stop-generation handler so we also clear the
  // question prompt state — useSendMessage doesn't know about it yet.
  const handleStopGenerating = useCallback(async () => {
    dispatchInteraction({ type: "DISMISS_QUESTION" });
    await baseHandleStopGenerating();
  }, [baseHandleStopGenerating, dispatchInteraction]);

  // Clear any pending question when the active conversation changes — a
  // question is scoped to the conversation that produced it.
  useEffect(() => {
    dispatchInteraction({ type: "DISMISS_QUESTION" });
  }, [activeConversationKey, dispatchInteraction]);

  useEffect(() => {
    dispatchSubagent({ type: "SUBAGENT_RESET" });
  }, [activeConversationKey]);

  useEffect(() => {
    if (
      !autoGreetPending ||
      !autoGreetRef.current ||
      diskPressureChatBlockReason ||
      sendDisabled
    ) {
      return;
    }

    autoGreetRef.current = false;
    setAutoGreetPending(false);
    void sendMessage("Wake up, my friend!");
  }, [autoGreetPending, diskPressureChatBlockReason, sendDisabled, sendMessage]);

  const {
    handleSecretSubmit,
    handleSecretCancel,
    handleContactPromptSubmit,
    handleContactPromptCancel,
    handleConfirmationSubmit,
    handleAllowAndCreateRule,
    handleOpenRuleEditorForToolCall,
    handleSaveRule,
    handleQuestionResponse,
    handleSurfaceAction,
    showRuleEditor,
    ruleEditorContext,
    unknownNudgeToolCallIds,
    setUnknownNudgeToolCallIds,
    dismissRuleEditor,
  } = useInteractionActions({
    interactionState,
    interactionStateRef,
    dispatchInteraction,
    dispatchConversationList,
    dispatchTurn,
    setMessages,
    setError,
    messagesRef,
    streamContextRef,
    activeConversationKeyRef,
    confirmationToolCallMapRef,
  });

  // Load the full assistant list when multi-assistant flag is on and the
  // assistant becomes active. This populates the switcher dropdown.
  useEffect(() => {
    if (!multiPlatformAssistant || assistantState.kind !== "active") {
      if (!multiPlatformAssistant) {
        setAssistants([]);
      }
      return;
    }

    let cancelled = false;
    listAssistants().then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setAssistants(result.data);

        // Fetch identity names from the runtime for each active assistant
        const activeAssistants = result.data.filter(
          (a) => a.status === "active",
        );
        Promise.all(
          activeAssistants.map((a) =>
            fetchAssistantIdentity(a.id).then((identity) => ({
              id: a.id,
              name: identity?.name || "",
            })),
          ),
        ).then((results) => {
          if (cancelled) return;
          const names = new Map<string, string>();
          for (const r of results) {
            if (r.name) {
              names.set(r.id, r.name);
            }
          }
          setIdentityNames(names);
        }).catch(() => { /* best-effort */ });
      }
    }).catch(() => { /* best-effort — switcher will just be empty */ });

    return () => { cancelled = true; };
    // `reachabilityReadyEpoch` is intentionally in the deps: if per-
    // assistant identity lookups failed during a pod restart we want
    // the switcher dropdown to refill with real names once the pods
    // recover.
  }, [multiPlatformAssistant, assistantState.kind, reachabilityReadyEpoch]);

  // Fetch the current assistant's identity for the sidebar header
  useEffect(() => {
    if (assistantState.kind !== "active" || !assistantId) {
      return;
    }
    void refreshAssistantIdentity();
    // `reachabilityReadyEpoch` is intentionally in the deps: if the
    // identity fetch failed because the pod was restarting, we want to
    // re-fetch once it recovers so the sidebar header populates.
  }, [assistantState.kind, assistantId, reachabilityReadyEpoch, refreshAssistantIdentity]);

  // One-shot identity re-fetch after the onboarding auto-greet completes.
  // The daemon writes `IDENTITY.md` with the user-chosen assistant name
  // during the first message (persistOnboardingArtifacts), so the initial
  // identity fetch on mount races the write and often loses. Once we see
  // the first assistant response we know the write is done — re-fetching
  // here updates the sidebar label without requiring a manual reload.
  useEffect(() => {
    if (!didOnboardingRef.current) return;
    if (!assistantId) return;
    const hasAssistantReply = messages.some((m) => m.role === "assistant");
    if (!hasAssistantReply) return;
    // Drain the flag so subsequent message changes don't re-fire.
    didOnboardingRef.current = false;
    void refreshAssistantIdentity(true);
  }, [messages, assistantId, refreshAssistantIdentity]);

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
    dispatchTurn,
    turnStateRef,
    dispatchConversationList,
    processingSnapshotsRef,
    setMessages,
    setError,
    streamRetryNonce,
    setStreamRetryNonce,
    refreshEpoch,
    syncRouterRef,
    conversationListInvalidatedTimerRef,
    isLoggedIn,
    isLoading,
    checkAssistant,
  });

  switchConversationRef.current = switchConversation;

  const pushConversationKeyParam = useCallback(
    (key: string) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("conversationKey", key);
      push(`?${params.toString()}`);
    },
    [push, searchParams],
  );

  const {
    loadApp,
    loadDocument,
    handleGoBack,
    handleGoForward,
    handleOpenApp,
    handleOpenDocument,
    handleCloseDocument,
    handleCloseApp,
    handleToggleAppMinimized,
    handleEditApp,
    handleEditAppFromDetached,
    handleCloseEditPanel,
    handleShareApp,
    handleDeployApp,
    handleDeployTokenSaved,
  } = useAppViewerActions({
    assistantId,
    activeConversationKey,
    conversations,
    openedAppState,
    isSharing,
    isDeploying,
    pendingDeployAppId,
    dispatchViewer,
    dispatchConversationList,
    viewerStateRef,
    lastConversationKeyRef,
    deepLinkAppId,
    switchConversation,
    setMainView,
    navPush,
    navGoBack,
    navGoForward,
    pushConversationKeyParam,
  });

  // ---------------------------------------------------------------------------
  // Command palette (Cmd+K)
  // ---------------------------------------------------------------------------

  const {
    commandPalette,
    mergedSections: mergedCommandPaletteSections,
    handleItemSelect: handleCommandPaletteItemSelect,
  } = useCommandPaletteSections({
    assistantId,
    assistantName: assistantIdentity?.name,
    conversations,
    activeConversationKey: activeConversation?.conversationKey,
    startNewConversation,
    switchConversation,
    navPush,
    handleGoBack,
    handleGoForward,
    setMainView,
    navigateToSettings: useCallback(() => push(routes.settings.root), [push]),
  });

  const handleSubagentClick = useCallback((subagentId: string) => {
    haptic.light();
    dispatchViewer({ type: "OPEN_SUBAGENT_DETAIL", subagentId });
  }, []);

  const handleCloseSubagentDetail = useCallback(() => {
    dispatchViewer({ type: "CLOSE_SUBAGENT_DETAIL" });
  }, []);

  const handleStopSubagent = useCallback(async (subagentId: string) => {
    if (!assistantId || !activeConversationKey) {
      return;
    }
    try {
      await abortSubagent(assistantId, activeConversationKey, subagentId);
    } catch {
      // Best-effort — the daemon may have already completed
    }
  }, [assistantId, activeConversationKey]);

  const handleRequestSubagentDetail = useCallback(async (subagentId: string) => {
    if (!assistantId) {
      return;
    }
    const entry = subagentState.byId[subagentId];
    if (!entry?.conversationId) {
      return;
    }
    const detail = await fetchSubagentDetail(assistantId, subagentId, entry.conversationId);
    if (!detail) {
      return;
    }

    let eventCounter = 0;
    const events: Array<{
      id: string;
      type: "text" | "tool_call" | "tool_result" | "error";
      content: string;
      toolName?: string;
      isError?: boolean;
      timestamp: number;
    }> = [];

    for (const evt of detail.events ?? []) {
      const rawType = typeof evt.type === "string" ? evt.type : "unknown";
      let type: "text" | "tool_call" | "tool_result" | "error";
      switch (rawType) {
        // Detail endpoint returns "text", "tool_use", "tool_result"
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

      const content = typeof evt.content === "string"
        ? evt.content
        : typeof evt.text === "string"
          ? evt.text
          : typeof evt.result === "string"
            ? evt.result
            : "";

      if (type === "text" && content === "") {
        continue;
      }

      // Coalesce consecutive text events into one (mirrors live-stream
      // reducer behavior and macOS populateFromDetailResponse).
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

    dispatchSubagent({
      type: "SUBAGENT_DETAIL_LOADED",
      subagentId,
      status: (detail.status as SubagentStatus) || undefined,
      objective: detail.objective,
      inputTokens: detail.usage?.inputTokens,
      outputTokens: detail.usage?.outputTokens,
      totalCost: detail.usage?.estimatedCost,
      events,
    });
  }, [assistantId, subagentState.byId, dispatchSubagent]);

  // Auto-fetch details for subagents reconstructed from history (mirrors macOS
  // behavior of calling the detail endpoint on reload to get correct status,
  // metrics, and events).
  const fetchedSubagentsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    fetchedSubagentsRef.current.clear();
  }, [activeConversationKey]);
  useEffect(() => {
    if (!assistantId) {
      return;
    }
    const entries = Object.values(subagentState.byId);
    for (const entry of entries) {
      if (
        entry.conversationId &&
        entry.events.length === 0 &&
        !fetchedSubagentsRef.current.has(entry.subagentId)
      ) {
        fetchedSubagentsRef.current.add(entry.subagentId);
        handleRequestSubagentDetail(entry.subagentId);
      }
    }
  }, [assistantId, subagentState.byId, handleRequestSubagentDetail]);

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
    dispatchConversationList,
    refreshConversations,
    switchConversation,
    startNewConversation,
    prePinGroupIdsRef,
  });

  const {
    handleCreateGroup,
    handleRenameGroup,
    handleDeleteGroup,
  } = useConversationGroupActions({
    assistantId,
    conversationGroups,
    dispatchConversationList,
    refreshConversations,
  });

  const {
    handleForkConversation,
    handleForkConversationFromMenu,
    handleAnalyzeConversation,
    handleOpenInNewWindow,
    handleInspectConversation,
    handleCopyConversation,
    feedbackOpen,
    setFeedbackOpen,
    handleShareFeedback,
  } = useConversationSecondaryActions({
    assistantId,
    activeConversationKey,
    activeConversation,
    assistantIdentityName: assistantIdentity?.name,
    messagesRef,
    refreshConversations,
    switchConversation,
    setError,
    pushConversationKeyParam,
    pushRoute: push,
  });

  // Non-destructive refresh for the chat title chevron's Refresh menu item.
  // Fetches the latest history page and merges it into the current
  // transcript — preserves in-flight streaming bubbles, optimistic rows,
  // composer state, and the live SSE stream. See
  // `_hooks/use-refresh-latest-messages.ts` for the full contract.
  const refreshLatestMessages = useRefreshLatestMessages({
    assistantId,
    activeConversationKeyRef,
    messagesRef,
    setMessages,
    dismissedSurfaceIdsRef,
  });

  // Open a fresh conversation and auto-send an initial message. Used by the
  // Identity tab's "edit name" / "edit role" buttons and the Contacts tab's
  // channel "Set up" buttons — both mirror macOS' ConversationManager
  // openConversation(message:, forceNew: true) pattern.
  const handleOpenThreadWithMessage = useCallback(
    (message: string) => {
      if (!assistantId) return;
      const newKey = createDraftConversationKey();
      pendingInitialMessageRef.current = { conversationKey: newKey, content: message };
      switchConversation(newKey);
    },
    [assistantId, switchConversation],
  );

  useEffect(() => {
    const pending = pendingInitialMessageRef.current;
    if (!pending) return;
    if (pending.conversationKey !== activeConversationKey) return;
    if (sendDisabled) return;
    pendingInitialMessageRef.current = null;
    void sendMessage(pending.content);
  }, [activeConversationKey, sendDisabled, sendMessage]);

  /**
   * True when the active conversation key matches the most recently
   * restored draft. Drives the transient "Draft restored" notice surfaced
   * above the composer. Auto-dismissed below.
   */
  const showRestoredDraftNotice =
    restoredDraftConversationKey !== null &&
    restoredDraftConversationKey === activeConversationKey;

  // Auto-dismiss the restored-draft notice after a short delay so it
  // doesn't linger while the user is composing. The notice is also
  // cleared on a conversation switch via the second effect below.
  useEffect(() => {
    if (!showRestoredDraftNotice) return;
    const id = window.setTimeout(() => {
      setRestoredDraftConversationKey(null);
    }, 5000);
    return () => window.clearTimeout(id);
  }, [showRestoredDraftNotice]);

  // Clear the restored-draft notice as soon as the user navigates away
  // from the conversation it was restored for — otherwise switching to
  // another thread and back would re-show the notice for the old key.
  useEffect(() => {
    if (
      restoredDraftConversationKey !== null &&
      restoredDraftConversationKey !== activeConversationKey
    ) {
      setRestoredDraftConversationKey(null);
    }
  }, [activeConversationKey, restoredDraftConversationKey]);

  const thinkingLabel = getThinkingStatusText(turnState);

  const transcriptItems = useMemo(
    () =>
      buildTranscriptItems({
        messages,
        pendingSecret: pendingSecret
          ? { requestId: pendingSecret.requestId }
          : null,
        pendingConfirmation: pendingConfirmation && !inlineConfirmationAttached
          ? { requestId: pendingConfirmation.requestId }
          : null,
        pendingContactRequest: pendingContactRequest
          ? {
              requestId: pendingContactRequest.requestId,
              channel: pendingContactRequest.channel,
              placeholder: pendingContactRequest.placeholder,
              label: pendingContactRequest.label,
              description: pendingContactRequest.description,
              role: pendingContactRequest.role,
            }
          : null,
        isThinking: showThinking,
        thinkingLabel,
        // Errors are shown by the {error && <Notice>} block below the transcript;
        // passing errorNotice here too produces a duplicate toast. Keep null.
        errorNotice: null,
      }),
    [
      messages,
      pendingSecret,
      pendingConfirmation,
      inlineConfirmationAttached,
      pendingContactRequest,
      showThinking,
      thinkingLabel,
    ],
  );

  const getFeedbackDiagnosticsSnapshot = useCallback((): Record<string, unknown> => {
    const cacheEntries = Array.from(conversationCacheRef.current.entries()).map(
      ([conversationKey, entry]) => ({
        conversationKey,
        pagination: entry.pagination,
        messages: summarizeDisplayMessages(entry.messages, 5),
      }),
    );

    return {
      assistantId,
      assistantVersion: assistantIdentity?.version ?? null,
      assistantStateKind: assistantState.kind,
      mainView,
      activeConversationKey,
      activeConversation: activeConversation
        ? {
            conversationKey: activeConversation.conversationKey,
            titleLength: activeConversation.title?.length ?? 0,
            draft: activeConversation.draft === true,
            source: activeConversation.source ?? null,
            groupId: activeConversation.groupId ?? null,
            conversationType: activeConversation.conversationType ?? null,
            lastMessageAt: activeConversation.lastMessageAt ?? null,
            latestAssistantMessageAt: activeConversation.latestAssistantMessageAt ?? null,
            archivedAt: activeConversation.archivedAt ?? null,
          }
        : null,
      conversationExistsOnServer,
      conversationCount: conversations.length,
      messages: summarizeDisplayMessages(messagesRef.current),
      transcript: {
        itemCount: transcriptItems.length,
        pagination: {
          ...transcriptPagination,
          isLoadingOlder:
            isLoadingOlderRef.current || transcriptPagination.isLoadingOlder,
        },
        initialPageOldestTimestamp: initialPageOldestTsRef.current,
        historyLoaded: historyLoadedRef.current,
        isLoadingHistory,
      },
      stream: {
        hasStream: streamRef.current != null,
        streamEpoch: streamEpochRef.current,
        streamContext: streamContextRef.current,
        reconcileAfterNextStreamOpen: reconcileAfterNextStreamOpenRef.current,
        retryNonce: streamRetryNonce,
      },
      turnState,
      cache: {
        size: conversationCacheRef.current.size,
        maxSize: MAX_CACHED_CONVERSATIONS,
        entries: cacheEntries,
      },
      pending: {
        queuedStableIds: pendingQueuedStableIdsRef.current.length,
        requestIdToStableId: requestIdToStableIdRef.current.size,
        localDeletions: pendingLocalDeletionsRef.current.size,
        processingConversationCount: processingKeys.size,
        activeConversationProcessing: activeConversationKey
          ? processingKeys.has(activeConversationKey)
          : false,
        secret: pendingSecret ? { requestId: pendingSecret.requestId } : null,
        confirmation: pendingConfirmation
          ? {
              requestId: pendingConfirmation.requestId,
              toolUseId: pendingConfirmation.toolUseId ?? null,
            }
          : null,
        contactRequest: pendingContactRequest
          ? { requestId: pendingContactRequest.requestId }
          : null,
      },
      uiState: {
        dismissedSurfaceCount: dismissedSurfaceIdsRef.current.size,
        unknownNudgeToolCallCount: unknownNudgeToolCallIds.size,
        hasPersistedMessage,
        hasNonEmptyMessage,
        errorCode: error?.code ?? null,
        errorMessageLength: error?.message.length ?? null,
      },
      contextWindowUsage,
    };
  }, [
    activeConversation,
    activeConversationKey,
    assistantId,
    assistantIdentity?.version,
    assistantState.kind,
    contextWindowUsage,
    conversationExistsOnServer,
    conversations.length,
    error?.code,
    error?.message,
    hasNonEmptyMessage,
    hasPersistedMessage,
    isLoadingHistory,
    mainView,
    pendingConfirmation,
    pendingContactRequest,
    pendingSecret,
    processingKeys,
    streamRetryNonce,
    transcriptItems.length,
    transcriptPagination,
    turnState,
    unknownNudgeToolCallIds.size,
  ]);

  if (isLoading) {
    return null;
  }

  if (!isLoggedIn) {
    return null;
  }

  if (assistantState.kind === "loading") {
    return (
      <AssistantShell>
        <div className="flex w-full flex-col items-center justify-center px-4 py-16">
          <Loader2 className="h-8 w-8 animate-spin text-[var(--content-disabled)]" />
        </div>
      </AssistantShell>
    );
  }

  if (assistantState.kind === "initializing") {
    return <AssistantShell><SetupScreen /></AssistantShell>;
  }

  if (assistantState.kind === "cleaning_up") {
    return <AssistantShell><CleanupScreen /></AssistantShell>;
  }

  if (assistantState.kind === "platform_hosted") {
    return <AssistantShell><PlatformHostedScreen /></AssistantShell>;
  }

  if (assistantState.kind === "self_hosted") {
    return <AssistantShell><SelfHostedScreen /></AssistantShell>;
  }

  if (assistantState.kind === "awaiting_version_selection") {
    return (
      <AssistantShell>
        <VersionSelectionScreen onHatch={hatchVersion} />
      </AssistantShell>
    );
  }

  if (assistantState.kind === "retired") {
    return (
      <AssistantShell>
        <div className="flex w-full flex-col items-center justify-center px-4 py-24">
          <div
            className="flex h-16 w-16 items-center justify-center rounded-xl bg-[var(--surface-base)]"
            style={{ animation: "fadeInUp 0.5s ease-out forwards" }}
          >
            {/* typography: off-scale — emoji hero sized via text-3xl */}
            { }
            <span className="text-3xl" role="img" aria-label="wave">
              &#x1F44B;
            </span>
          </div>
          <h2 className="mt-8 text-title-medium text-[var(--content-default)]">
            Assistant retired
          </h2>
          <p className="mt-3 max-w-md text-center text-body-medium-lighter text-[var(--content-tertiary)]">
            Your assistant has been successfully retired. You can hatch a new one whenever
            you&apos;re ready.
          </p>
          <button
            onClick={() => push(routes.onboarding.privacy)}
            className="mt-6 flex items-center gap-2 rounded-lg bg-[var(--primary-base)] px-6 py-3 text-body-medium-default text-[var(--content-inset)] transition-colors hover:bg-[var(--primary-hover)]"
          >
            Hatch New Assistant
          </button>
        </div>
      </AssistantShell>
    );
  }

  if (assistantState.kind === "error") {
    return (
      <AssistantShell>
        <div className="flex w-full flex-col items-center justify-center px-4 py-16">
          <Notice tone="error">{assistantState.message}</Notice>
          <button
            onClick={retryAssistant}
            className="mt-6 flex items-center gap-2 rounded-lg bg-[var(--primary-base)] px-6 py-3 text-body-medium-default text-[var(--content-inset)] transition-colors hover:bg-[var(--primary-hover)]"
          >
            Try again
          </button>
        </div>
      </AssistantShell>
    );
  }

  return (
    <ChatProvider
      messages={messages}
      activeConversationKey={activeConversationKey}
      assistantId={assistantId}
      sendMessage={sendMessage}
      dispatchTurn={dispatchTurn}
      dispatchInteraction={dispatchInteraction}
    >
    <AssistantShell
      onOpenHome={homePageEnabled ? () => {
        haptic.light();
        navPush({ type: "home" });
        dispatchViewer({ type: "SET_MAIN_VIEW", view: "home" });
      } : undefined}
      isHomeActive={mainView === "home"}
      sideMenu={({ collapsed, variant, onClose, onSearch }: AssistantShellSideMenuArgs) => (
        <AssistantSideMenu
          assistantId={assistantId ?? ""}
          assistantName={assistantIdentity?.name}
          collapsed={collapsed}
          variant={variant}
          conversations={conversations}
          activeConversationKey={mainView === "chat" || mainView === "subagent-detail" ? (activeConversationKey ?? undefined) : undefined}
          onSelectConversation={(key) => {
            haptic.light();
            navPush({ type: "conversation", key });
            switchConversation(key);
          }}
          isIntelligenceActive={mainView === "intelligence"}
          onOpenIntelligence={() => {
            haptic.light();
            navPush({ type: "intelligence" });
            dispatchViewer({ type: "SET_MAIN_VIEW", view: "intelligence" });
          }}
          isLibraryActive={mainView === "library"}
          onOpenLibrary={() => {
            haptic.light();
            navPush({ type: "library" });
            dispatchViewer({ type: "SET_MAIN_VIEW", view: "library" });
          }}
          onOpenApp={handleOpenApp}
          activeAppId={mainView === "app" || mainView === "app-editing" ? (activeAppId ?? undefined) : undefined}
          onStartNewConversation={startNewConversation}
          onArchiveConversation={handleArchiveConversation}
          onUnarchiveConversation={handleUnarchiveConversation}
          onMarkConversationUnread={handleMarkConversationUnread}
          onMarkConversationRead={handleMarkConversationRead}
          onAnalyze={analyzeConversationEnabled ? handleAnalyzeConversation : undefined}
          onOpenInNewWindow={handleOpenInNewWindow}
          onShareFeedback={handleShareFeedback}
          onInspect={handleInspectConversation}
          onPinConversation={handleTogglePinConversation}
          onRenameConversation={handleRenameConversation}
          conversationGroups={conversationGroups}
          onMoveToGroup={handleMoveToGroup}
          onRemoveFromGroup={handleRemoveFromGroup}
          onCreateGroup={handleCreateGroup}
          onRenameGroup={handleRenameGroup}
          onDeleteGroup={handleDeleteGroup}
          processingConversationKeys={processingKeys}
          attentionConversationKeys={attentionKeys}
          activeConversationProcessing={isSending(turnState)}
          footerBanner={
            isOnNudgePlatform && nudge.sidebarEntryVisible ? (
              isOnIOS ? (
                <IOSAppSidebarEntry onDownload={nudge.handleDownload} onDismiss={nudge.handleSidebarDismiss} />
              ) : (
                <MacOSAppSidebarEntry onDownload={nudge.handleDownload} onDismiss={nudge.handleSidebarDismiss} />
              )
            ) : showGitHubSidebar ? (
              <GitHubNudgeSidebarEntry
                onStar={githubNudge.handleStar}
                onDismiss={githubNudge.handleSidebarDismiss}
              />
            ) : showDiscordSidebar ? (
              <DiscordNudgeSidebarEntry
                onJoin={discordNudge.handleJoin}
                onDismiss={discordNudge.handleSidebarDismiss}
              />
            ) : null
          }
          footerAction={<PreferencesMenu assistantId={assistantId} assistantVersion={assistantIdentity?.version} />}
          onClose={onClose}
          onSearchClick={onSearch}
        />
      )}
      topBarRightSlot={
        mainView === "intelligence" || mainView === "library" || mainView === "home" ? undefined
          : activeConversation && assistantId && activeConversation.conversationKey ? (
            <ConversationAssetsPill
              assistantId={assistantId}
              conversationId={activeConversation.conversationKey}
              refreshKey={assetsRefreshKey}
              onOpenApp={loadApp}
              onOpenDocument={loadDocument}
            />
          ) : undefined
      }
      topBarCenter={
        mainView === "intelligence" || mainView === "library" || mainView === "home" ? undefined : activeConversation ? (
          <ConversationActionsMenu
            variant="header"
            isPinned={isConversationPinned(activeConversation)}
            isArchived={activeConversation.archivedAt != null}
            isReadonly={isChannelReadonly}
            onPinToggle={() =>
              handleTogglePinConversation(activeConversation)
            }
            onRename={() => handleRenameConversation(activeConversation)}
            onArchive={() => handleArchiveConversation(activeConversation)}
            onUnarchive={() =>
              handleUnarchiveConversation(activeConversation)
            }
            onAnalyze={
              analyzeConversationEnabled &&
              activeConversation.conversationKey != null &&
              !isChannelReadonly
                ? () => handleAnalyzeConversation(activeConversation)
                : undefined
            }
            onForkConversation={
              !isChannelReadonly && hasPersistedMessage
                ? handleForkConversationFromMenu
                : undefined
            }
            onOpenInNewWindow={
              activeConversation.conversationKey != null
                ? () => handleOpenInNewWindow(activeConversation)
                : undefined
            }
            onInspect={
              activeConversation.conversationKey != null
                ? () => handleInspectConversation(activeConversation)
                : undefined
            }
            onCopyConversation={
              hasNonEmptyMessage
                ? handleCopyConversation
                : undefined
            }
            onRefresh={
              activeConversation.conversationKey != null
                ? refreshLatestMessages
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
                // `min-w-0` lets the button shrink within the
                // `min-w-0 flex-1` center slot in `AssistantShellHeader`.
                // Without it, flex items default to `min-width: auto` and
                // overflow long titles (e.g. "Lisbon Furniture Shopping
                // Guide") into the trailing icon-button cluster.
                className="min-w-0"
              >
                <span className="min-w-0 max-w-[240px] truncate">
                  {activeConversation.archivedAt != null && (
                    <span className="mr-1 text-[var(--content-tertiary)]">
                      [Archived]
                    </span>
                  )}
                  {activeConversation.title ?? "Untitled"}
                </span>
              </Button>
            }
          />
        ) : assistantId ? (
          <Typography
            variant="title-small"
            className="text-[var(--content-default)]"
          >
            New conversation
          </Typography>
        ) : undefined
      }
      onStartNewConversation={undefined}
      canGoBack={navCanGoBack}
      canGoForward={navCanGoForward}
      onGoBack={handleGoBack}
      onGoForward={handleGoForward}
      onToggleCommandPalette={commandPalette.toggle}
      viewportOverlays={
        isMobile ? (
          <>
            <MobileAppOverlay
              openedAppState={mainView === "app" ? openedAppState : null}
              isAppMinimized={isAppMinimized}
              assistantId={assistantId}
              onToggleMinimized={handleToggleAppMinimized}
              onClose={handleCloseApp}
              onShare={handleShareApp}
              isSharing={isSharing}
              onDeploy={deployToVercel ? handleDeployApp : undefined}
              isDeploying={isDeploying}
              route={
                openedAppState &&
                (openedAppState.appId === deepLinkAppId.current ||
                  openedAppState.dirName === deepLinkAppId.current)
                  ? deepLinkRoute.current
                  : undefined
              }
            />
            <MobileDocumentOverlay
              openedDocumentState={
                mainView === "document" ? openedDocumentState : null
              }
              assistantId={assistantId}
              onClose={handleCloseDocument}
            />
            <MobileSubagentDetailOverlay
              entry={
                mainView === "subagent-detail" && activeSubagentId
                  ? subagentState.byId[activeSubagentId] ?? null
                  : null
              }
              onClose={handleCloseSubagentDetail}
              onStop={handleStopSubagent}
              onRequestDetail={handleRequestSubagentDetail}
            />
          </>
        ) : null
      }
    >
      <div className="flex h-full w-full max-w-full overflow-hidden">

        {/* Main content area. When the mobile app overlay is minimized to a
            bottom strip, leave room (`--app-strip-h`) at the bottom so the
            chat composer doesn't sit behind it. */}
        <div
          className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
          style={
            isMobile && isAppMinimized
              ? { paddingBottom: "var(--app-strip-h, 56px)" }
              : undefined
          }
        >

          {mainView === "home" && assistantId ? (
            <HomePage
              assistantId={assistantId}
              onStartNewChat={startNewConversation}
              onOpenConversation={(id) => {
                switchConversation(id);
                dispatchViewer({ type: "SET_MAIN_VIEW", view: "chat" });
              }}
              onSuggestionSelected={(prompt) => {
                startNewConversation({ initialMessage: prompt });
              }}
            />
          ) : mainView === "intelligence" ? (
            <div className="flex min-h-0 flex-1 flex-col rounded-lg border border-[var(--border-base)] bg-[var(--surface-overlay)] px-6 py-5">
              <h1
                className="mb-4 shrink-0 text-title-large text-[var(--content-default)]"
              >
                About {assistantIdentity?.name || "Assistant"}
              </h1>

              <Tabs.Root
                value={intelligenceTab}
                onValueChange={(v) => {
                  haptic.light();
                  dispatchViewer({ type: "SET_INTELLIGENCE_TAB", tab: v as typeof intelligenceTab });
                }}
                className="flex min-h-0 flex-1 flex-col"
              >
                <Tabs.List className="mb-4 shrink-0 overflow-x-auto" style={{ scrollbarWidth: "none", WebkitOverflowScrolling: "touch" }}>
                  <Tabs.Trigger value="identity">Identity</Tabs.Trigger>
                  <Tabs.Trigger value="skills">Skills</Tabs.Trigger>
                  <Tabs.Trigger value="workspace">Workspace</Tabs.Trigger>
                  <Tabs.Trigger value="contacts">Contacts</Tabs.Trigger>
                </Tabs.List>

                {[
                  { value: "identity", panel: assistantId ? <IdentityTab assistantId={assistantId} onOpenThread={handleOpenThreadWithMessage} /> : null },
                  { value: "skills", panel: assistantId ? <SkillsTab assistantId={assistantId} initialSkillId={deepLinkSkillId.current} /> : null },
                  { value: "workspace", panel: assistantId ? <WorkspaceBrowser assistantId={assistantId} /> : null },
                  { value: "contacts", panel: assistantId ? <ContactsTab assistantId={assistantId} onStartSetupConversation={handleOpenThreadWithMessage} initialContactId={initialContactId.current} onContactSelected={handleContactSelected} /> : null },
                ].map(({ value, panel }) => (
                  <Tabs.Panel key={value} value={value} className="min-h-0 flex-1 overflow-y-auto">
                    {panel ?? (
                      <div className="flex items-center justify-center py-16">
                        <p className="text-body-medium-lighter text-[var(--content-tertiary)]">
                          No assistant connected
                        </p>
                      </div>
                    )}
                  </Tabs.Panel>
                ))}
              </Tabs.Root>
            </div>
          ) : mainView === "library" ? (
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-[var(--border-base)] bg-[var(--surface-overlay)]">
              <LibraryView
                assistantId={assistantId ?? ""}
                assistantName={assistantIdentity?.name}
                onNewConversation={(initialMessage) => startNewConversation({ initialMessage })}
                onOpenDocument={handleOpenDocument}
                onEditApp={handleEditAppFromDetached}
              />
            </div>
          ) : mainView === "app" && openedAppState && !isMobile ? (
            <AppViewerContainer
              appId={openedAppState.appId}
              appName={openedAppState.name}
              html={openedAppState.html}
              assistantId={assistantId ?? ""}
              onClose={handleCloseApp}
              onEdit={handleEditApp}
              onShare={handleShareApp}
              isSharing={isSharing}
              onDeploy={deployToVercel ? handleDeployApp : undefined}
              isDeploying={isDeploying}
              route={openedAppState.appId === initialDeepLinkAppId || openedAppState.dirName === initialDeepLinkAppId ? initialDeepLinkRoute : undefined}
            />
          ) : mainView === "app" && !isMobile ? (
            <div className="flex flex-1 items-center justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-[var(--content-tertiary)]" />
            </div>
          ) : (
            <ChatRouteContent
              assistantId={assistantId}
              assistantState={assistantState}
              assistantIdentity={assistantIdentity}
              chatPullToRefresh={chatPullToRefresh}
              deployToVercel={deployToVercel}
              doctor={doctor}
              isMobile={isMobile}
              isKeyboardOpen={isKeyboardOpen}
              messages={messages}
              setMessages={setMessages}
              turnState={turnState}
              dispatchTurn={dispatchTurn}
              input={input}
              setInput={setInput}
              error={error}
              setError={setError}
              isLoadingHistory={isLoadingHistory}
              interactionState={interactionState}
              dispatchInteraction={dispatchInteraction}
              conversations={conversations}
              activeConversationKey={activeConversationKey}
              activeConversation={activeConversation}
              processingKeys={processingKeys}
              mainView={mainView}
              viewerState={viewerState}
              openedAppState={openedAppState}
              openedDocumentState={openedDocumentState}
              editingConversationKey={editingConversationKey}
              restoredDraftConversationKey={restoredDraftConversationKey}
              setRestoredDraftConversationKey={setRestoredDraftConversationKey}
              avatar={{
                avatarComponents,
                avatarTraits,
                avatarImageUrl,
              }}
              conversationStarters={conversationStarters}
              contextWindowUsage={contextWindowUsage}
              compactionCircuitOpenUntil={compactionCircuitOpenUntil}
              setCompactionCircuitOpenUntil={setCompactionCircuitOpenUntil}
              suggestion={suggestion}
              setSuggestion={setSuggestion}
              transcriptPagination={transcriptPagination}
              setTranscriptPagination={setTranscriptPagination}
              setShowAddCreditsModal={setShowAddCreditsModal}
              diskPressure={{
                status: diskPressureStatus,
                mode: diskPressureMode,
                diskPressureMonitorEnabled,
                hasResolvedDiskPressureStatus,
                isAcknowledgingDiskPressure,
                diskPressureAcknowledgeError,
                acknowledgeDiskPressure,
              }}
              handleReviewDiskUsage={handleReviewDiskUsage}
              nudges={{
                isOnIOS,
                showBanner,
                nudge,
                githubNudge,
                showGitHubBanner,
                discordNudge,
                showDiscordBanner,
              }}
              attachments={{
                chatAttachments,
                attachmentsUploadingCount,
                attachmentUploadedIds,
                attachmentLastError,
                addChatAttachmentFiles,
                removeChatAttachment,
                resetChatAttachments,
                dismissChatAttachmentError,
              }}
              voice={{
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
              }}
              send={{
                sendMessage,
                handleStopGenerating,
                queuedMessages,
                handleCancelQueuedMessage,
                handleCancelAllQueued,
                handleEditQueueTail,
              }}
              interactionActions={{
                handleSecretSubmit,
                handleSecretCancel,
                handleContactPromptSubmit,
                handleContactPromptCancel,
                handleConfirmationSubmit,
                handleAllowAndCreateRule,
                handleOpenRuleEditorForToolCall,
                handleQuestionResponse,
                handleSurfaceAction,
                unknownNudgeToolCallIds,
                setUnknownNudgeToolCallIds,
              }}
              handleOpenApp={handleOpenApp}
              handleOpenDocument={handleOpenDocument}
              handleCloseDocument={handleCloseDocument}
              handleCloseApp={handleCloseApp}
              handleCloseEditPanel={handleCloseEditPanel}
              handleShareApp={handleShareApp}
              handleDeployApp={deployToVercel ? handleDeployApp : undefined}
              handleForkConversation={handleForkConversation}
              subagentEntries={subagentEntries}
              subagentState={subagentState}
              activeSubagentId={activeSubagentId}
              onSubagentClick={handleSubagentClick}
              onCloseSubagentDetail={handleCloseSubagentDetail}
              onStopSubagent={handleStopSubagent}
              onRequestSubagentDetail={handleRequestSubagentDetail}
              pushToAiSettings={pushToAiSettings}
              checkAssistant={checkAssistant}
              setRefreshEpoch={setRefreshEpoch}
              streamRetryNonce={streamRetryNonce}
              refs={{
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
                turnStateRef,
                interactionStateRef,
                reconcileAfterNextStreamOpenRef,
              }}
              isChannelReadonly={isChannelReadonly}
            />
          )}
        </div>
      </div>
      <ConnectingToAssistant
        state={reachability.state}
        onRetry={() => reachability.probe()}
        onDismiss={() => reachability.reset()}
      />
      {showRuleEditor && ruleEditorContext && (
        <RuleEditorModal
          toolName={ruleEditorContext.toolName}
          commandText={ruleEditorContext.commandText}
          commandDescription={ruleEditorContext.commandDescription}
          riskLevel={ruleEditorContext.riskLevel}
          allowlistOptions={ruleEditorContext.allowlistOptions}
          scopeOptions={ruleEditorContext.scopeOptions}
          directoryScopeOptions={ruleEditorContext.directoryScopeOptions}
          onSave={handleSaveRule}
          onDismiss={dismissRuleEditor}
        />
      )}
      <MicPermissionPrimer
        open={showPrimer}
        onContinue={handlePrimerContinue}
        onCancel={handlePrimerCancel}
      />
      <VercelTokenDialog
        open={showTokenDialog}
        onOpenChange={(open) => dispatchViewer(open ? { type: "SHOW_TOKEN_DIALOG", pendingAppId: pendingDeployAppId ?? "" } : { type: "HIDE_TOKEN_DIALOG" })}
        assistantId={assistantId ?? ""}
        onTokenSaved={handleDeployTokenSaved}
      />
      <ConfirmDialog
        open={complexDeployApp !== null}
        title="This app needs a full deploy"
        message={`"${complexDeployApp?.name ?? ""}" uses backend services that won't work on a static Vercel page. ${assistantIdentity?.name ?? "Your assistant"} can deploy it properly with serverless functions.`}
        confirmLabel={`Let ${assistantIdentity?.name ?? "assistant"} handle it`}
        onConfirm={() => {
          const appName = complexDeployApp?.name ?? "this app";
          dispatchViewer({ type: "SET_COMPLEX_DEPLOY_APP", app: null });
          startNewConversation({
            initialMessage: `Deploy my app "${appName}" to Vercel. It uses backend services that need serverless functions — please use the deploy-fullstack-vercel skill to handle it properly.`,
          });
        }}
        onCancel={() => dispatchViewer({ type: "SET_COMPLEX_DEPLOY_APP", app: null })}
      />
      <AddCreditsModal
        open={showAddCreditsModal}
        onOpenChange={setShowAddCreditsModal}
      />
      <ShareFeedbackModal
        open={feedbackOpen}
        onClose={() => setFeedbackOpen(false)}
        assistantId={assistantId}
        assistantVersion={assistantIdentity?.version}
        activeConversationKey={activeConversationKey}
        getDiagnosticsSnapshot={getFeedbackDiagnosticsSnapshot}
      />
      <CommandPalette
        isOpen={commandPalette.isOpen}
        onClose={commandPalette.close}
        query={commandPalette.query}
        onQueryChange={commandPalette.setQuery}
        selectedIndex={commandPalette.selectedIndex}
        sections={mergedCommandPaletteSections}
        isSearching={commandPalette.isSearching}
        onItemSelect={handleCommandPaletteItemSelect}
        onKeyDown={commandPalette.handleKeyDown}
      />
    </AssistantShell>
    </ChatProvider>
  );
}
