import {
    lazy,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode,
} from "react";
import { Outlet, useLocation, useNavigate, useNavigationType } from "react-router";

import { useAssistantLifecycleStore } from "@/assistant/lifecycle-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useAssistantIdentityInit } from "@/hooks/use-assistant-identity-init";
import { MOBILE_MEDIA_QUERY, useIsMobile } from "@/hooks/use-is-mobile";
import { getLocalBool, getLocalNumber, setLocalBool, setLocalNumber } from "@/utils/local-settings";
import { routes } from "@/utils/routes";

import { useChatLayoutSlotsStore } from "@/components/layout/chat-layout-slots-store";
import { useElectronDockSync } from "@/domains/chat/hooks/use-electron-dock-sync";
import {
    chooseSidebarOpenAppDestination,
    useOpenAppFromChat,
} from "@/domains/chat/hooks/use-open-app-from-chat";
import { useHomeUnreadBadge } from "@/hooks/use-home-unread-badge";
import { useCommandPaletteStore } from "@/stores/command-palette-store";

import { useAttentionTracking } from "@/domains/chat/hooks/use-attention-tracking";
import { useChatLayoutDrawer } from "@/domains/chat/hooks/use-chat-layout-drawer";
import { useChatLayoutShortcuts } from "@/domains/chat/hooks/use-chat-layout-shortcuts";
import { useConversationActions } from "@/domains/chat/hooks/use-conversation-actions";
import { useConversationGroupActions } from "@/domains/chat/hooks/use-conversation-group-actions";
import { useCanUseLlmInspector } from "@/domains/chat/inspector/access";
import {
    navigateToConversation,
    navigateToNewConversation,
} from "@/domains/chat/utils/conversation-navigation";
import { haptic } from "@/utils/haptics";

import {
    useConversationGroupsQuery,
    useConversationListQuery,
} from "@/hooks/conversation-queries";
import { openCommandPaletteWindow } from "@/runtime/command-palette-window";
import { isElectron } from "@/runtime/is-electron";
import { useIsNativePlatform } from "@/runtime/native-auth";
import { openPopoutWindow } from "@/runtime/popout-window";
import { useVellumCommands } from "@/runtime/vellum-commands";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { useConversationStore } from "@/stores/conversation-store";
import { useViewerStore } from "@/stores/viewer-store";
import type { Conversation } from "@/types/conversation-types";
import { requestComposerFocus } from "./composer-focus";

import { LazyBoundary } from "@/components/lazy-boundary";
import { StatusBanner } from "@/components/status-banner";
import { AssistantSideMenu } from "@/domains/chat/components/assistant-side-menu";
import { PreferencesMenu } from "@/domains/chat/components/preferences-menu";
import { useCommandPaletteOrchestrator } from "@/domains/chat/hooks/use-command-palette-orchestrator";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
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
  const [isPopout] = useState(() => location.search.includes("popout=1"));

  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const assistantStateKind = useAssistantLifecycleStore(
    (s) => s.assistantState.kind,
  );
  const isAssistantActive = assistantStateKind === "active";

  // Subscribe to the sidebar conversation list at the layout level so every
  // chat-layout child route (home, library, contacts, identity, chat)
  // inherits a populated sidebar on direct navigation — not just /assistant.
  // TanStack Query handles dedup with any other consumer using the same key.
  const conversationGroupsUI = useAssistantFeatureFlagStore.use.conversationGroupsUI();
  const { conversations } = useConversationListQuery(
    assistantId,
    isAssistantActive,
  );
  const { conversationGroups } = useConversationGroupsQuery(
    assistantId,
    isAssistantActive && conversationGroupsUI,
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
  const { handleRenameGroup, handleDeleteGroup } =
    useConversationGroupActions({
      assistantId,
      conversationGroups,
    });

  // Hydrate the sidebar assistant name at the layout level so the
  // sidebar header shows the correct name on every chat-layout child
  // route — not only inside a conversation where ChatPage owns the
  // fetch.
  useAssistantIdentityInit({
    assistantId,
    assistantStateKind,
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
    setMaxHistoryIndex(navigationType === "PUSH" ? idx : (prev) => Math.max(prev, idx));
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

  const isHomeActive = location.pathname === routes.home;
  const isIdentityActive =
    location.pathname === routes.identity ||
    location.pathname === routes.skills ||
    location.pathname === routes.workspace ||
    location.pathname.startsWith(routes.contacts.root);

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

  useEffect(() => {
    if (!isMobile) setDrawerOpen(false);
  }, [isMobile]);

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

  useChatLayoutShortcuts({
    toggleSidebar,
    onGoBack: handleGoBack,
    onGoForward: handleGoForward,
  });

  const drawerRef = useChatLayoutDrawer({
    visible: drawerVisible,
    onClose: closeDrawer,
  });

  const activeConversationId = useConversationStore.use.activeConversationId();
  const processingConversationIds = useConversationStore.use.processingConversationIds();
  const attentionConversationIds = useConversationStore.use.attentionConversationIds();

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

  const startNewConversation = useCallback(
    (opts?: { silent?: boolean }) => {
      navigateToNewConversation(navigate, opts);
    },
    [navigate],
  );

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

  const activeConversation = useMemo(
    () => conversations.find((c) => c.conversationId === activeConversationId) ?? null,
    [conversations, activeConversationId],
  );

  const topBarCenter = topBarCenterSlot ?? (headerSupplements ? (
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
          if (!opened) useCommandPaletteStore.getState().toggle();
        })
        .catch(() => {
          useCommandPaletteStore.getState().toggle();
        });
    },
    previousConversation: () => {
      if (!activeConversationId || conversations.length === 0) return;
      const idx = conversations.findIndex(
        (c) => c.conversationId === activeConversationId,
      );
      const prev = conversations[idx - 1];
      if (prev) handleSelectConversation(prev.conversationId);
    },
    nextConversation: () => {
      if (!activeConversationId || conversations.length === 0) return;
      const idx = conversations.findIndex(
        (c) => c.conversationId === activeConversationId,
      );
      const next = conversations[idx + 1];
      if (next) handleSelectConversation(next.conversationId);
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
  const isOnConversationRoute =
    location.pathname === routes.assistant ||
    location.pathname === `${routes.assistant}/` ||
    location.pathname.startsWith(`${routes.conversations}/`);
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
      if (dest) void navigate(dest);
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
      if (isElectron()) {
        void openPopoutWindow(conversation.conversationId);
      } else {
        window.open(routes.conversation(conversation.conversationId), "_blank");
      }
    },
    [],
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
        />
      }
      onClose={args.onClose}
    />
  );

  return (
    <>
      {!isPopout && (
        <ChatLayoutHeader
          isMobile={isMobile}
          drawerOpen={drawerOpen}
          collapsed={collapsed}
          sidebarWidth={sidebarWidth}
          toggleSidebar={toggleSidebar}
          topBarCenter={topBarCenter}
          topBarRightSlot={topBarRightSlot}
          canGoBack={canGoBack}
          canGoForward={canGoForward}
          onGoBack={handleGoBack}
          onGoForward={handleGoForward}
          onOpenHome={handleOpenHome}
          isHomeActive={isHomeActive}
          hasUnreadHome={hasUnreadHome}
        />
      )}

      {!isPopout && <StatusBanner />}

      {isMobile ? (
        <main className="relative flex min-w-0 flex-1 min-h-0 flex-col overflow-hidden">
          <Outlet  />
          {drawerVisible ? (
            <div
              ref={drawerRef}
              className="fixed inset-0"
              style={{ zIndex: 40 }}
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
        <main className="flex min-w-0 flex-1 min-h-0 flex-col overflow-hidden p-4">
          <Outlet />
        </main>
      ) : (
        <div className="flex min-w-0 flex-1 gap-4 p-4 min-h-0 overflow-hidden flex-col md:flex-row">
          <aside
            id="chat-side-menu"
            className="shrink-0"
            aria-label="Navigation"
          >
            {renderSideMenu({ collapsed, variant: "rail", width: sidebarWidth, onWidthChange: handleSidebarWidthChange })}
          </aside>
          <main className="flex min-w-0 flex-1 min-h-0 flex-col overflow-hidden">
            <Outlet />
          </main>
        </div>
      )}

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
