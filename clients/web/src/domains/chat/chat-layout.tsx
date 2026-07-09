import {
  lazy,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Outlet,
  useLocation,
  useNavigate,
  useNavigationType,
} from "react-router";

import { useAssistantLifecycleStore } from "@/assistant/lifecycle-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { MOBILE_MEDIA_QUERY, useIsMobile } from "@/hooks/use-is-mobile";
import {
  getLocalBool,
  getLocalNumber,
  setLocalBool,
  setLocalNumber,
} from "@/utils/local-settings";
import {
  isAboutAssistantPath,
  isConversationPath,
  routes,
} from "@/utils/routes";

import { useChatLayoutSlotsStore } from "@/components/layout/chat-layout-slots-store";
import { useElectronDockSync } from "@/domains/chat/hooks/use-electron-dock-sync";
import {
  chooseSidebarOpenAppDestination,
  useOpenAppFromChat,
} from "@/domains/chat/hooks/use-open-app-from-chat";
import { useHomeUnreadBadge } from "@/hooks/use-home-unread-badge";
import {
  DRAWER_SLIDE_MS,
  useEdgeSwipeDrawer,
} from "@/hooks/use-edge-swipe-drawer";
import { useCommandPaletteStore } from "@/stores/command-palette-store";
import { useEdgeSwipeArbiterStore } from "@/stores/edge-swipe-arbiter-store";

import { useActiveConversation } from "@/domains/chat/hooks/use-active-conversation";
import { useAttentionTracking } from "@/domains/chat/hooks/use-attention-tracking";
import { useChatLayoutDrawer } from "@/domains/chat/hooks/use-chat-layout-drawer";
import { useChatLayoutShortcuts } from "@/domains/chat/hooks/use-chat-layout-shortcuts";
import { useConversationActions } from "@/domains/chat/hooks/use-conversation-actions";
import { useConversationGroupActions } from "@/domains/chat/hooks/use-conversation-group-actions";
import { useCanUseLlmInspector } from "@/domains/chat/inspector/access";
import {
  navigateToConversation,
  navigateToNewConversation,
} from "@/utils/conversation-navigation";
import { haptic } from "@/utils/haptics";

import {
  useConversationGroupsQuery,
  useConversationListQuery,
} from "@/hooks/conversation-queries";
import { openCommandPaletteWindow } from "@/runtime/command-palette-window";
import { isElectron } from "@/runtime/is-electron";
import { useIsNativePlatform } from "@/runtime/native-auth";
import { isPopoutWindow, openPopoutWindow } from "@/runtime/popout-window";
import { useVellumCommands } from "@/runtime/vellum-commands";
import { useConversationStore } from "@/stores/conversation-store";
import { useOnboardingFocusStore } from "@/stores/onboarding-focus-store";
import { useViewerStore } from "@/stores/viewer-store";
import type { Conversation } from "@/types/conversation-types";
import { requestComposerFocus } from "./composer-focus";

import { LazyBoundary } from "@/components/lazy-boundary";
import { RuntimeUpgradeBanner } from "@/components/runtime-upgrade-banner";
import { StatusBanner } from "@/components/status-banner";
import { AssistantSideMenu } from "@/domains/chat/components/assistant-side-menu";
import { PreferencesMenu } from "@/domains/chat/components/preferences-menu";
import { useCommandPaletteOrchestrator } from "@/domains/chat/hooks/use-command-palette-orchestrator";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { ResearchResultsOverlay } from "@/domains/chat/onboarding-research/research-results-overlay";
import { OnboardingCheckinOverlay } from "@/components/onboarding-checkin-overlay";
import { OnboardingAvatarApplier } from "@/components/onboarding-avatar-applier";
import { VoiceSessionPillHost } from "@/domains/chat/components/voice-session-pill-host";
import { useLiveVoiceSessionController } from "@/domains/chat/voice/live-voice/use-live-voice-session-controller";
import { useSeedLiveVoiceSnapshot } from "@/domains/chat/voice/live-voice/use-seed-live-voice-snapshot";
import { VoiceRoom } from "@/domains/chat/voice/voice-room/voice-room";
import { useIsVoiceRoomVisible } from "@/domains/chat/voice/voice-room/use-is-voice-room-visible";
import { ChatConversationHeader } from "./chat-conversation-header";
import { ChatLayoutHeader } from "./chat-layout-header";
import { RenameDialogFromStore } from "./rename-dialog-from-store";

const CommandPalette = lazy(() =>
  import("@/components/command-palette/command-palette").then((m) => ({
    default: m.CommandPalette,
  })),
);

const SIDEBAR_COLLAPSED_STORAGE_KEY = "vellum:sidebar:collapsed";
const SIDEBAR_WIDTH_STORAGE_KEY = "vellum:sidebar:width";
const DEFAULT_SIDEBAR_WIDTH = 230;
const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 400;

function readPersistedCollapsed(): boolean {
  return getLocalBool(SIDEBAR_COLLAPSED_STORAGE_KEY, false);
}

function readPersistedWidth(): number {
  const raw = getLocalNumber(SIDEBAR_WIDTH_STORAGE_KEY, DEFAULT_SIDEBAR_WIDTH);
  if (raw > 0) {
    return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, raw));
  }
  return DEFAULT_SIDEBAR_WIDTH;
}

type SideMenuVariant = "rail" | "overlay";

interface SideMenuRenderArgs {
  collapsed: boolean;
  variant: SideMenuVariant;
  width?: number;
  onWidthChange?: (width: number) => void;
  onClose?: () => void;
}

/**
 * Chat-specific layout route providing sidebar rail, mobile drawer,
 * keyboard shortcuts (Ctrl+\, Ctrl+[/], Ctrl+K), and the chat header
 * bar. Reads the resolved assistant from `useResolvedAssistantsStore`,
 * the lifecycle phase from `useAssistantLifecycleStore`, and header
 * slot content from `useChatLayoutSlotsStore` (which child routes
 * write to from their own effects).
 *
 * @see https://reactrouter.com/start/data/routing
 */
export function ChatLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const navigationType = useNavigationType();

  // Capture pop-out mode once at mount so it persists across in-window
  // navigations (e.g. conversation switching via Cmd+Up/Down). ChatLayout is a
  // persistent layout route — it stays mounted when child routes change, so
  // this initial value remains stable for the window's lifetime.
  const [isPopout] = useState(() => isPopoutWindow(location.search));

  // SPIKE — research-onboarding focused presentation. When set, a full-viewport
  // overlay (rendered below, on top of this layout) covers the chrome so the
  // handoff chat reads as a focused step. Kept as an overlay rather than a
  // separate render branch so `ActiveChatView` never remounts when focus
  // toggles — otherwise a suggestion click's navigate + `?prompt=` auto-send
  // gets raced by the remount and the message is lost.
  const isFocused = useOnboardingFocusStore.use.focused();
  const sidebarCollapseRequested =
    useOnboardingFocusStore.use.sidebarCollapseRequested();
  const consumeSidebarCollapse =
    useOnboardingFocusStore.use.consumeSidebarCollapse();

  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const assistantStateKind = useAssistantLifecycleStore(
    (s) => s.assistantState.kind,
  );
  const isAssistantActive = assistantStateKind === "active";

  // Live-voice session controller. Owned at layout scope — not by the
  // composer — so a session survives every chat-side navigation (thread
  // switch, Home/Library, the fullscreen app viewer) with the title-bar
  // pill as its control surface. The composer starts/stops sessions
  // through the seams this registers in `useLiveVoiceStore`.
  useLiveVoiceSessionController();
  // Fold a live-voice turn into the transcript on a fresh/empty chat, where the
  // unseeded draft snapshot would otherwise drop the turn's echo (JARVIS-1265).
  useSeedLiveVoiceSnapshot();

  // Subscribe to the sidebar conversation list at the layout level so every
  // chat-layout child route (home, library, contacts, identity, chat)
  // inherits a populated sidebar on direct navigation — not just /assistant.
  // TanStack Query handles dedup with any other consumer using the same key.
  const { conversations } = useConversationListQuery(
    assistantId,
    isAssistantActive,
  );
  const { conversationGroups } = useConversationGroupsQuery(
    assistantId,
    isAssistantActive,
  );

  // Track processing/attention indicators for every conversation in
  // the sidebar, on every chat-layout child route. Mounted at layout
  // scope so the bus-driven `interaction_resolved` subscriber and the
  // post-reconnect reconcile sweep stay live across home, library,
  // contacts, identity, and chat — not only inside `/assistant`.
  useAttentionTracking({
    assistantId,
    assistantStateKind,
  });

  // Group CRUD handlers live at the layout level since the sidebar's
  // create/rename/delete affordances are rendered here, not in ChatPage.
  // The hook is self-sufficient (cache invalidation handles rollback), so
  // it can live wherever the sidebar lives.
  const { handleRenameGroup, handleDeleteGroup } = useConversationGroupActions({
    assistantId,
    conversationGroups,
  });

  // Home page unread indicator — drives the red dot on the Home button in
  // the layout header.
  const { hasUnreadHome } = useHomeUnreadBadge(assistantId);

  // Mirror the unread count + signed-in flag into the Electron Dock
  // (no-op off Electron). Uses the conversation list this layout
  // already subscribes to, so there's no extra query — see
  // `./hooks/use-electron-dock-sync.ts`.
  useElectronDockSync(conversations);

  // Header slots come from a module-level store so gated routes
  // (which see `ActiveAssistantGate`'s `<Outlet />` as their
  // nearest outlet) can register content without the lost-Provider
  // problem outlet context has across intermediate routes.
  //
  // ChatPage writes `headerSupplements` to signal it's active. When
  // supplements are present and no explicit `topBarCenter` override
  // exists, ChatLayout renders ChatConversationHeader with conversation
  // actions from the shared useConversationActions instance.
  // Non-chat routes (e.g. HomePageRoute) write `null` to topBarCenter
  // and never set supplements, so they get an empty center as before.
  const topBarCenterSlot = useChatLayoutSlotsStore.use.topBarCenter();
  const headerSupplements = useChatLayoutSlotsStore.use.headerSupplements();
  const topBarRightSlot = useChatLayoutSlotsStore.use.topBarRightSlot();
  const showLlmInspector = useCanUseLlmInspector();
  const isNative = useIsNativePlatform();
  const electron = isElectron();

  // --- Assistant identity from store (written by ChatPage) ---
  const assistantName = useAssistantIdentityStore.use.name();
  const assistantVersion = useAssistantIdentityStore.use.version();

  // --- History tracking for back/forward nav ---
  // These are state (not refs) because they influence rendering
  // (canGoBack / canGoForward gate button enabled states).
  const [historyIndex, setHistoryIndex] = useState(0);
  const [maxHistoryIndex, setMaxHistoryIndex] = useState(0);
  const [prevLocation, setPrevLocation] = useState(location);

  if (prevLocation !== location) {
    const idx = (window.history.state?.idx as number) ?? 0;
    setPrevLocation(location);
    setHistoryIndex(idx);
    // Only PUSH clears forward entries (pushState). REPLACE (replaceState)
    // and POP preserve them, so max must not reset.
    setMaxHistoryIndex(
      navigationType === "PUSH" ? idx : (prev) => Math.max(prev, idx),
    );
  }

  const canGoBack = historyIndex > 0;
  const canGoForward = historyIndex < maxHistoryIndex;

  const handleOpenHome = useCallback(() => {
    navigate(routes.home);
  }, [navigate]);

  const handleOpenIdentity = useCallback(() => {
    navigate(routes.identity);
  }, [navigate]);

  const handleGoBack = useCallback(() => {
    navigate(-1);
  }, [navigate]);

  const handleGoForward = useCallback(() => {
    navigate(1);
  }, [navigate]);

  const isHomeActive =
    location.pathname === routes.home ||
    location.pathname === routes.schedules.root ||
    location.pathname.startsWith(`${routes.schedules.root}/`);
  const isIdentityActive = isAboutAssistantPath(location.pathname);

  // --- Sidebar collapsed / drawer state ---
  const [collapsed, setCollapsed] = useState<boolean>(readPersistedCollapsed);
  const [sidebarWidth, setSidebarWidth] = useState<number>(readPersistedWidth);

  useEffect(() => {
    setLocalBool(SIDEBAR_COLLAPSED_STORAGE_KEY, collapsed);
  }, [collapsed]);

  const handleSidebarWidthChange = useCallback((width: number) => {
    setSidebarWidth(width);
    setLocalNumber(SIDEBAR_WIDTH_STORAGE_KEY, Math.round(width));
  }, []);

  const isMobile = useIsMobile();
  const [drawerOpen, setDrawerOpen] = useState<boolean>(false);
  // True while a left-edge swipe is dragging the drawer in from off-screen but
  // has not yet committed open; keeps the panel mounted so its transform can
  // track the finger before `drawerOpen` flips.
  const [drawerDragging, setDrawerDragging] = useState<boolean>(false);

  useEffect(() => {
    if (!isMobile) {
      setDrawerOpen(false);
      setDrawerDragging(false);
    }
  }, [isMobile]);

  // Close the drawer on any navigation, covering sources that don't manage
  // drawer state themselves (e.g. command palette results). `location.key`
  // changes on every navigation — including query-only changes and same-URL
  // history moves that `pathname` misses. Opening the drawer never navigates,
  // so this can't fight it.
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.key]);

  useEffect(() => {
    if (!sidebarCollapseRequested) {
      return;
    }
    // One-shot: research-onboarding asked us to open with the side panel
    // collapsed across the whole web experience (not just desktop). Collapse
    // the desktop sidebar — `setCollapsed(true)` flows through the persistence
    // effect above, so this intentionally sets the user's persisted collapsed
    // preference — AND close the mobile drawer, then clear the signal.
    setCollapsed(true);
    setDrawerOpen(false);
    consumeSidebarCollapse();
  }, [sidebarCollapseRequested, consumeSidebarCollapse]);

  // The full-screen voice room takes over the viewport, so the sidebar reads as
  // collapsed and the chat body blurs while it is visible. This override is
  // EPHEMERAL — it is OR'd into the rendered collapsed value (`sideMenuCollapsed`
  // below) rather than routed through `setCollapsed`, so it never touches the
  // persistence effect above. Keeping it out of the persisted `collapsed` state
  // means a reload / tab-close while the room is open cannot write the forced
  // value to `localStorage`: on exit the override drops and the sidebar returns
  // to exactly the user's persisted value.
  const voiceRoomVisible = useIsVoiceRoomVisible();
  const sideMenuCollapsed = collapsed || voiceRoomVisible;

  const drawerVisible = isMobile && drawerOpen;

  const toggleSidebar = useCallback(() => {
    haptic.light();
    if (window.matchMedia(MOBILE_MEDIA_QUERY).matches) {
      setDrawerOpen((value) => !value);
    } else {
      setCollapsed((value) => !value);
    }
  }, []);

  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  const startNewConversation = useCallback(
    (opts?: { silent?: boolean }) => {
      navigateToNewConversation(navigate, opts);
    },
    [navigate],
  );

  useChatLayoutShortcuts({
    toggleSidebar,
    onGoBack: handleGoBack,
    onGoForward: handleGoForward,
    onNewConversation: startNewConversation,
  });

  const drawerRef = useChatLayoutDrawer({
    visible: drawerVisible,
    onClose: closeDrawer,
  });

  // Swipe-to-open-menu: track the drawer in from the left edge, committing open
  // past threshold. Suppressed whenever a back-swipe owner is active (a pushed
  // page under this layout) so a single left-edge swipe resolves to exactly one
  // action — back-navigation on detail pages, open-menu at the stack root.
  const backSwipeOwnerCount = useEdgeSwipeArbiterStore.use.backOwnerCount();
  useEdgeSwipeDrawer({
    panelRef: drawerRef,
    enabled: isMobile && !drawerOpen && backSwipeOwnerCount === 0,
    onDragStart: () => setDrawerDragging(true),
    onOpen: () => {
      setDrawerOpen(true);
      setDrawerDragging(false);
    },
    onSettle: () => setDrawerDragging(false),
  });

  const activeConversationId = useConversationStore.use.activeConversationId();
  const processingConversationIds =
    useConversationStore.use.processingConversationIds();
  const attentionConversationIds =
    useConversationStore.use.attentionConversationIds();

  const handleSelectConversation = useCallback(
    (key: string) => {
      navigateToConversation(navigate, key);
      setDrawerOpen(false);
    },
    [navigate],
  );

  // --- Sidebar conversation actions (pin / rename / archive / mark / move) ---
  //
  // The sidebar's hover-revealed "…" menu reads its items from these
  // handlers; without them the popover renders empty (every menu item
  // resolves to `null`). The CRUD hook lives at the layout level so the
  // sidebar's action wiring stays live on every chat-layout child route
  // (home, library, contacts, identity) — not only inside a conversation
  // where ChatPage is mounted.
  const prePinGroupIdsRef = useRef<Map<string, string | undefined>>(new Map());

  const {
    handleArchiveConversation,
    handleUnarchiveConversation,
    handleMarkConversationUnread,
    handleMarkConversationRead,
    handleTogglePinConversation,
    handleRenameConversation,
    handleReorderConversations,
    handleMarkAllReadInGroup,
    handleArchiveAllInGroup,
  } = useConversationActions({
    assistantId: assistantId,
    activeConversationId,
    conversations,
    switchConversation: handleSelectConversation,
    startNewConversation,
    prePinGroupIdsRef,
  });

  // Resolve the active row from whichever list cache holds it (foreground,
  // background, or scheduled), fetching the single row when an open
  // background/scheduled thread is in none. The foreground `conversations`
  // list deliberately excludes background jobs, so a directly-opened
  // background conversation — e.g. a memory retrospective ("… (Retrospective)")
  // — is absent from it and the header would otherwise fall back to "New
  // conversation". `ActiveChatView` resolves its copy through the same hook.
  const activeConversation =
    useActiveConversation(
      assistantId,
      activeConversationId,
      isAssistantActive,
    ) ?? null;

  const topBarCenter =
    topBarCenterSlot ??
    (headerSupplements ? (
      <ChatConversationHeader
        assistantId={assistantId}
        activeConversation={activeConversation}
        headerSupplements={headerSupplements}
        showLlmInspector={showLlmInspector}
        onArchive={handleArchiveConversation}
        onUnarchive={handleUnarchiveConversation}
        onMarkUnread={handleMarkConversationUnread}
        onMarkRead={handleMarkConversationRead}
        onPinToggle={handleTogglePinConversation}
        onRename={handleRenameConversation}
      />
    ) : null);

  // -------------------------------------------------------------------------
  // Command palette — sections, item dispatch
  // -------------------------------------------------------------------------
  const { commandPalette, mergedSections, handleItemSelect } =
    useCommandPaletteOrchestrator({
      assistantId,
      assistantName: assistantName ?? undefined,
      conversations,
      activeConversationId: activeConversationId ?? undefined,
      startNewConversation,
      switchConversation: handleSelectConversation,
    });

  // Electron host commands (File menu / global hotkeys). The hook is a
  // no-op on the web host. Handlers close over the latest state via an
  // internal ref, so we don't need to memoize them. Composer focus is
  // routed via `requestComposerFocus` (see `./composer-focus.ts`) so it
  // works whether ChatPage is already mounted (event listener) or the
  // command comes from another `/assistant/*` route (pending flag drained
  // on the next ChatPage mount).
  useVellumCommands({
    newConversation: () => {
      startNewConversation();
    },
    currentConversation: () => {
      if (!activeConversationId) {
        return;
      }
      const target = routes.conversation(activeConversationId);
      if (location.pathname !== target) {
        void navigate(target);
      }
      requestComposerFocus();
    },
    markCurrentUnread: () => {
      if (!activeConversationId) {
        return;
      }
      const conversation = conversations.find(
        (c) => c.conversationId === activeConversationId,
      );
      if (conversation) {
        handleMarkConversationUnread(conversation);
      }
    },
    markAllRead: () => {
      void handleMarkAllReadInGroup(conversations);
    },
    find: () => {
      useCommandPaletteStore.getState().toggle();
    },
    sidebarToggle: () => {
      toggleSidebar();
    },
    home: () => {
      void navigate(routes.home);
    },
    commandPalette: () => {
      void openCommandPaletteWindow()
        .then((opened) => {
          if (!opened) {
            useCommandPaletteStore.getState().toggle();
          }
        })
        .catch(() => {
          useCommandPaletteStore.getState().toggle();
        });
    },
    previousConversation: () => {
      if (!activeConversationId || conversations.length === 0) {
        return;
      }
      const idx = conversations.findIndex(
        (c) => c.conversationId === activeConversationId,
      );
      const prev = conversations[idx - 1];
      if (prev) {
        handleSelectConversation(prev.conversationId);
      }
    },
    nextConversation: () => {
      if (!activeConversationId || conversations.length === 0) {
        return;
      }
      const idx = conversations.findIndex(
        (c) => c.conversationId === activeConversationId,
      );
      const next = conversations[idx + 1];
      if (next) {
        handleSelectConversation(next.conversationId);
      }
    },
    openConversation: (command) => {
      if (command.kind === "openConversation") {
        handleSelectConversation(command.conversationId);
      }
    },
    openLibrary: () => {
      void navigate(routes.library.root);
    },
    openIdentity: () => {
      void navigate(routes.identity);
    },
    navigateBack: () => {
      navigate(-1);
    },
    navigateForward: () => {
      navigate(1);
    },
    zoomIn: () => {
      document.body.style.zoom = String(
        parseFloat(document.body.style.zoom || "1") + 0.1,
      );
    },
    zoomOut: () => {
      document.body.style.zoom = String(
        Math.max(0.5, parseFloat(document.body.style.zoom || "1") - 0.1),
      );
    },
    actualSize: () => {
      document.body.style.zoom = "1";
    },
    popOut: () => {
      if (!activeConversationId) {
        return;
      }
      void openPopoutWindow(activeConversationId);
    },
  });

  const handleOpenLibrary = useCallback(() => {
    navigate(routes.library.root);
  }, [navigate]);

  const isLibraryActive = location.pathname.startsWith(routes.library.root);

  // Only highlight a conversation row in the sidebar when the user is
  // actually viewing it. On non-conversation routes (Identity, Library,
  // Home, etc.) no conversation row should appear active. The store value
  // is intentionally left intact — many other consumers (SSE streams,
  // attention tracking, message reconciliation) rely on it persisting
  // across route changes.
  const isOnConversationRoute = isConversationPath(location.pathname);
  const sidebarActiveConversationId = isOnConversationRoute
    ? (activeConversationId ?? undefined)
    : undefined;

  // Sidebar pinned-app open. The viewer panel only renders under ChatPage
  // (mounted at `/assistant` index + `/assistant/conversations/:id`), so a
  // pinned-app click from home / library / identity / inspector etc. would
  // mutate the viewer store with no surface to display against. Navigate
  // to a chat route first when off-chat, then run the shared open flow.
  //
  // See `use-open-app-from-chat.ts` for the loadApp → enterAppEditing flow
  // shared with the transcript / assets-pill open path.
  const openAppFromChat = useOpenAppFromChat();
  const activeAppId = useViewerStore.use.activeAppId();
  const handleOpenAppFromSidebar = useCallback(
    async (appId: string) => {
      const dest = chooseSidebarOpenAppDestination(
        location.pathname,
        activeConversationId,
      );
      if (dest) {
        void navigate(dest);
      }
      await openAppFromChat(appId);
    },
    [location.pathname, navigate, activeConversationId, openAppFromChat],
  );

  // Inspector affordance for the sidebar context menu. The topbar variant
  // (in `chat-page.tsx`) uses `useConversationSecondaryActions` so it can
  // enrich the URL with the latest assistant `messageId` from the active
  // transcript. The sidebar doesn't hold transcript state, so we navigate
  // with just the conversation path and let `InspectPage` resolve the
  // latest assistant message via `ResolveLatestMessage`.
  const handleInspectConversation = useCallback(
    (conversation: Conversation) => {
      void navigate(routes.inspect(conversation.conversationId));
    },
    [navigate],
  );

  const handleOpenInNewWindow = useCallback(
    (conversation: Conversation) => {
      if (electron) {
        void openPopoutWindow(conversation.conversationId);
      } else {
        window.open(routes.conversation(conversation.conversationId), "_blank");
      }
    },
    [electron],
  );

  const renderSideMenu = (args: SideMenuRenderArgs): ReactNode => (
    <AssistantSideMenu
      assistantId={assistantId ?? ""}
      assistantName={assistantName}
      collapsed={args.collapsed}
      variant={args.variant}
      width={args.width}
      onWidthChange={args.onWidthChange}
      conversations={conversations}
      conversationGroups={conversationGroups}
      activeConversationId={sidebarActiveConversationId}
      processingConversationIds={processingConversationIds}
      attentionConversationIds={attentionConversationIds}
      onSelectConversation={handleSelectConversation}
      onStartNewConversation={startNewConversation}
      isIntelligenceActive={isIdentityActive}
      onOpenIntelligence={handleOpenIdentity}
      isLibraryActive={isLibraryActive}
      onOpenLibrary={handleOpenLibrary}
      isHomeActive={isHomeActive}
      onOpenHome={handleOpenHome}
      hasUnreadHome={hasUnreadHome}
      activeAppId={activeAppId ?? undefined}
      onOpenApp={handleOpenAppFromSidebar}
      onPinConversation={handleTogglePinConversation}
      onReorderConversations={handleReorderConversations}
      onRenameConversation={handleRenameConversation}
      onArchiveConversation={handleArchiveConversation}
      onUnarchiveConversation={handleUnarchiveConversation}
      onMarkConversationUnread={handleMarkConversationUnread}
      onMarkConversationRead={handleMarkConversationRead}
      onRenameGroup={handleRenameGroup}
      onDeleteGroup={handleDeleteGroup}
      onMarkAllReadInGroup={handleMarkAllReadInGroup}
      onArchiveAllInGroup={handleArchiveAllInGroup}
      onOpenInNewWindow={isNative ? undefined : handleOpenInNewWindow}
      onInspect={showLlmInspector ? handleInspectConversation : undefined}
      footerAction={
        <PreferencesMenu
          assistantId={assistantId}
          assistantVersion={assistantVersion}
          activeConversationId={activeConversationId}
          triggerVariant={args.variant === "overlay" ? "pill" : "item"}
        />
      }
      onClose={args.onClose}
    />
  );

  // Blur + freeze the chat body under the voice room. The room is an opaque
  // overlay, so this mainly matters for the header strip peeking around it and
  // to stop stray interaction with the covered chat.
  const mainRoomClass = voiceRoomVisible
    ? "pointer-events-none blur-sm opacity-40 transition-[filter,opacity]"
    : "";

  return (
    <>
      {!isPopout && (
        <ChatLayoutHeader
          isMobile={isMobile}
          drawerOpen={drawerOpen}
          collapsed={sideMenuCollapsed}
          sidebarWidth={sidebarWidth}
          toggleSidebar={toggleSidebar}
          topBarCenter={topBarCenter}
          // The voice-session pill is composed here — NOT registered through
          // useChatLayoutSlotsStore — because slot registration is owned by
          // per-route hooks that unmount on navigation, exactly when the pill
          // must persist. The host renders null when no session is active (or
          // while viewing the owning thread's composer), so the header is
          // unaffected otherwise.
          topBarRightSlot={
            <>
              {topBarRightSlot}
              <VoiceSessionPillHost />
            </>
          }
          canGoBack={canGoBack}
          canGoForward={canGoForward}
          onGoBack={handleGoBack}
          onGoForward={handleGoForward}
        />
      )}

      {!isPopout && electron ? (
        <div className="flex shrink-0 flex-col gap-2 empty:hidden">
          <StatusBanner placement="electron" />
          <RuntimeUpgradeBanner
            assistantId={assistantId}
            currentVersion={assistantVersion}
            placement="electron"
          />
        </div>
      ) : null}

      {isMobile ? (
        <main
          className={`relative flex min-w-0 flex-1 min-h-0 flex-col overflow-hidden ${mainRoomClass}`}
        >
          <Outlet />
          {/* A popout narrowed below the mobile breakpoint lands in this
              branch — still headerless, so it still needs the floating
              session surface (see the desktop popout branch below). */}
          {isPopout ? <VoiceSessionPillHost variant="standalone" /> : null}
          {drawerVisible || drawerDragging ? (
            <div
              ref={drawerRef}
              className="fixed inset-0"
              style={{
                zIndex: 40,
                transform: drawerOpen ? "translateX(0)" : "translateX(-100%)",
                transition: `transform ${DRAWER_SLIDE_MS}ms ease-out`,
              }}
              role="dialog"
              aria-modal="true"
              aria-label="Navigation"
            >
              <aside
                id="chat-side-menu"
                className="relative flex h-full w-full flex-col shadow-xl"
                style={{
                  background: "var(--surface-lift)",
                  borderRight: "1px solid var(--border-base)",
                  zIndex: 50,
                  paddingTop:
                    "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))",
                  paddingBottom:
                    "var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))",
                  paddingLeft:
                    "var(--safe-area-inset-left, env(safe-area-inset-left, 0px))",
                }}
              >
                <StatusBanner />
                {renderSideMenu({
                  collapsed: false,
                  variant: "overlay",
                  onClose: closeDrawer,
                })}
              </aside>
            </div>
          ) : null}
        </main>
      ) : isPopout ? (
        <main
          className={`relative flex min-w-0 flex-1 min-h-0 flex-col overflow-hidden p-4 ${mainRoomClass}`}
        >
          <Outlet />
          {/* Pop-outs render no header, but they DO support in-window
              conversation switching (Cmd+Up/Down) — so a live session started
              here can lose its owning composer exactly like in the main
              window. The standalone variant floats the pill (or the failed
              chip) over the top-right corner; it renders nothing while the
              on-screen composer owns the session. */}
          <VoiceSessionPillHost variant="standalone" />
        </main>
      ) : (
        <div className="flex min-w-0 flex-1 gap-4 p-4 min-h-0 overflow-hidden flex-col md:flex-row">
          <aside
            id="chat-side-menu"
            className="shrink-0"
            aria-label="Navigation"
          >
            {renderSideMenu({
              collapsed: sideMenuCollapsed,
              variant: "rail",
              width: sidebarWidth,
              onWidthChange: handleSidebarWidthChange,
            })}
          </aside>
          <main
            className={`flex min-w-0 flex-1 min-h-0 flex-col overflow-hidden ${mainRoomClass}`}
          >
            <Outlet />
          </main>
        </div>
      )}

      {/* Focused research-onboarding results — a full-viewport layer ON TOP of
          the normal layout (not a separate render branch), so `ActiveChatView`
          stays continuously mounted. Toggling focus only adds/removes this
          overlay; it never remounts the chat, so a suggestion click's
          navigate + `?prompt=` auto-send isn't raced by a remount. */}
      {isFocused ? <ResearchResultsOverlay /> : null}
      {/* Full-screen live-voice room — a purely additive overlay mounted at
          layout scope, next to the other full-viewport overlays. Self-gates on
          `useIsVoiceRoomVisible()` (the exact complement of the title-bar
          session pill); the composer's voice bar and transcript render
          underneath, hidden by it. */}
      <VoiceRoom />
      {/* First step of the focused flow: the gcal "Let's chat tomorrow" page,
          shown over the streaming research output until connect/skip. Self-gates
          on `checkinPending`; top-level so it can compose the onboarding screen. */}
      <OnboardingCheckinOverlay />
      {/* Applies the research-onboarding picker's avatar once the assistant is
          hatched (avatar isn't part of the pre-chat handoff context). */}
      <OnboardingAvatarApplier />

      <RenameDialogFromStore assistantId={assistantId} />
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
    </>
  );
}
