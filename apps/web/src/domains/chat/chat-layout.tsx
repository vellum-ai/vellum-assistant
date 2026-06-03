import { captureError } from "@/lib/sentry/capture-error";
import {
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Outlet, useLocation, useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";

import { ChevronDown } from "lucide-react";
import { Button } from "@vellum/design-library";

import { haptic } from "@/utils/haptics";
import { getLocalBool, setLocalBool, getLocalNumber, setLocalNumber } from "@/utils/local-settings";
import { routes } from "@/utils/routes";
import { MOBILE_MEDIA_QUERY, useIsMobile } from "@/hooks/use-is-mobile";
import { useAssistantLifecycleStore } from "@/assistant/lifecycle-store";
import { useAssistantSelectionStore } from "@/assistant/selection-store";
import { useAssistantIdentityInit } from "@/hooks/use-assistant-identity-init";

import { useHomeUnreadBadge } from "@/hooks/use-home-unread-badge";
import { useElectronDockSync } from "@/domains/chat/hooks/use-electron-dock-sync";
import {
  chooseSidebarOpenAppDestination,
  useOpenAppFromChat,
} from "@/domains/chat/hooks/use-open-app-from-chat";
import { useChatLayoutSlotsStore } from "@/components/layout/chat-layout-slots-store";
import { useCommandPaletteStore } from "@/stores/command-palette-store";

import { useVellumCommands } from "@/runtime/vellum-commands";
import { useConversationStore } from "@/stores/conversation-store";
import { requestComposerFocus } from "./composer-focus";
import {
  useConversationGroupsQuery,
  useConversationListQuery,
} from "@/hooks/conversation-queries";
import { patchConversation } from "@/utils/conversation-cache";
import { useAttentionTracking } from "@/domains/chat/hooks/use-attention-tracking";
import { useConversationActions } from "@/domains/chat/hooks/use-conversation-actions";
import { useConversationGroupActions } from "@/domains/chat/hooks/use-conversation-group-actions";
import { RenameConversationDialog } from "@/domains/chat/components/rename-conversation-dialog";
import { useRenameRequestStore } from "@/domains/chat/rename-request-store";
import { conversationsByIdNamePatch } from "@/generated/daemon/sdk.gen";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { useViewerStore } from "@/stores/viewer-store";
import { useSubagentStore } from "@/domains/chat/subagent-store";
import { useAuthStore } from "@/stores/auth-store";
import { canUseLlmInspector } from "@/domains/chat/inspector/access";
import type { Conversation } from "@/types/conversation-types";

import { OfflineBanner } from "@/components/offline-banner";
import { AssistantSideMenu } from "@/domains/chat/components/assistant-side-menu";
import { PreferencesMenu } from "@/domains/chat/components/preferences-menu";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { createDraftConversationId } from "@/domains/chat/utils/conversation-selection";
import { ConversationActionsMenu } from "@/domains/chat/components/conversation-actions-menu";
import { buildMoveToGroupTargets } from "@/domains/chat/utils/group-conversations";
import { isChannelConversation } from "@/domains/chat/utils/conversation-channel";
import { ChatLayoutHeader } from "./chat-layout-header";
import { LazyBoundary } from "@/components/lazy-boundary";
import { useCommandPaletteOrchestrator } from "@/domains/chat/hooks/use-command-palette-orchestrator";

const CommandPalette = lazy(() =>
  import("@/components/command-palette/command-palette").then((m) => ({
    default: m.CommandPalette,
  })),
);

/**
 * LocalStorage key used to persist the collapsed state of the sidebar rail
 * across reloads.
 */
export const SIDEBAR_COLLAPSED_STORAGE_KEY = "vellum:sidebar:collapsed";
export const SIDEBAR_WIDTH_STORAGE_KEY = "vellum:sidebar:width";
const DEFAULT_SIDEBAR_WIDTH = 230;

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function readPersistedCollapsed(): boolean {
  return getLocalBool(SIDEBAR_COLLAPSED_STORAGE_KEY, false);
}

const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 400;

export function readPersistedWidth(): number {
  const raw = getLocalNumber(SIDEBAR_WIDTH_STORAGE_KEY, DEFAULT_SIDEBAR_WIDTH);
  if (raw > 0) {
    return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, raw));
  }
  return DEFAULT_SIDEBAR_WIDTH;
}

export function shouldCloseDrawerOnViewportChange(isMobile: boolean): boolean {
  return !isMobile;
}

/**
 * Returns `true` when the keyboard event matches Ctrl/Cmd + one of the given
 * keys and the active element is not an input surface.
 */
export function shouldHandleShortcut(
  event: Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "key">,
  activeElement: Element | null,
  key: string | string[],
): boolean {
  const modifierPressed = event.metaKey || event.ctrlKey;
  if (!modifierPressed) {
    return false;
  }
  const keys = Array.isArray(key) ? key : [key];
  if (!keys.includes(event.key)) {
    return false;
  }
  if (!activeElement) {
    return true;
  }
  const tag = activeElement.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
    return false;
  }
  if (activeElement.getAttribute("contenteditable") === "true") {
    return false;
  }
  return true;
}

export type SideMenuVariant = "rail" | "overlay";

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
 * bar. Reads the resolved assistant from `useAssistantSelectionStore`,
 * the lifecycle phase from `useAssistantLifecycleStore`, and header
 * slot content from `useChatLayoutSlotsStore` (which child routes
 * write to from their own effects).
 *
 * @see https://reactrouter.com/start/data/routing
 */
export function ChatLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const assistantId = useAssistantSelectionStore.use.activeAssistantId();
  const assistantStateKind = useAssistantLifecycleStore(
    (s) => s.assistantState.kind,
  );
  const isAssistantActive = assistantStateKind === "active";

  // Subscribe to the sidebar conversation list at the layout level so every
  // chat-layout child route (home, library, contacts, identity, chat)
  // inherits a populated sidebar on direct navigation — not just /assistant.
  // TanStack Query handles dedup with any other consumer using the same key.
  const conversationGroupsUI = useAssistantFeatureFlagStore.use.conversationGroupsUI();
  const homePageEnabled = useClientFeatureFlagStore.use.homePage();
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
  // the layout header. Gated on the homePage feature flag so the hook
  // doesn't fire its query when the home route is disabled.
  const { hasUnreadHome } = useHomeUnreadBadge(
    homePageEnabled ? assistantId : null,
  );

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
  // exists, ChatLayout renders the self-contained ChatConversationHeader.
  // Non-chat routes (e.g. HomePageRoute) write `null` to topBarCenter
  // and never set supplements, so they get an empty center as before.
  const topBarCenterSlot = useChatLayoutSlotsStore.use.topBarCenter();
  const headerSupplements = useChatLayoutSlotsStore.use.headerSupplements();
  const topBarCenter = topBarCenterSlot ?? (headerSupplements ? <ChatConversationHeader /> : null);
  const topBarRightSlot = useChatLayoutSlotsStore.use.topBarRightSlot();

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
    setMaxHistoryIndex((prev) => Math.max(prev, idx));
  }

  const canGoBack = historyIndex > 0;
  const canGoForward = historyIndex < maxHistoryIndex;

  const handleStartNewConversation = useCallback(() => {
    haptic.light();
    useViewerStore.getState().setMainView("chat");
    const draftConversationId = createDraftConversationId();
    useConversationStore.getState().setActiveConversationId(draftConversationId);
    void navigate(routes.conversation(draftConversationId));
    requestComposerFocus();
  }, [navigate]);

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
    if (shouldCloseDrawerOnViewportChange(isMobile)) {
      setDrawerOpen(false);
    }
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

  // Ctrl/Cmd+\ shortcut to toggle sidebar
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!shouldHandleShortcut(event, document.activeElement, "\\")) {
        return;
      }
      event.preventDefault();
      toggleSidebar();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [toggleSidebar]);

  // Ctrl/Cmd+K shortcut for command palette
  useEffect(() => {
    const toggle = useCommandPaletteStore.getState().toggle;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!shouldHandleShortcut(event, document.activeElement, "k")) return;
      event.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => { window.removeEventListener("keydown", onKeyDown); };
  }, []);

  // Ctrl/Cmd+[ and Ctrl/Cmd+] shortcuts for back/forward navigation
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!shouldHandleShortcut(event, document.activeElement, ["[", "]"])) {
        return;
      }
      event.preventDefault();
      if (event.key === "[") {
        handleGoBack();
      } else if (event.key === "]") {
        handleGoForward();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [handleGoBack, handleGoForward]);

  // Mobile drawer — focus trap, ESC to close, body-scroll-lock
  const drawerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!drawerVisible) {
      return;
    }

    drawerRef.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)?.focus();

    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKeyDown = (event: KeyboardEvent) => {
      if (
        drawerRef.current &&
        !drawerRef.current.contains(document.activeElement)
      ) {
        return;
      }

      if (event.key === "Escape") {
        setDrawerOpen(false);
        return;
      }
      if (event.key !== "Tab" || !drawerRef.current) {
        return;
      }
      const focusable =
        drawerRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) {
        event.preventDefault();
        return;
      }
      const active = document.activeElement as HTMLElement | null;
      const isInDrawer = drawerRef.current.contains(active);

      if (event.shiftKey) {
        if (!isInDrawer || active === first) {
          event.preventDefault();
          last.focus();
        }
      } else if (!isInDrawer || active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousBodyOverflow;
    };
  }, [drawerVisible]);

  const activeConversationId = useConversationStore.use.activeConversationId();
  const processingConversationIds = useConversationStore.use.processingConversationIds();
  const attentionConversationIds = useConversationStore.use.attentionConversationIds();
  const setActiveConversationId = useConversationStore.use.setActiveConversationId();

  const handleSelectConversation = useCallback(
    (key: string) => {
      haptic.light();
      useViewerStore.getState().setMainView("chat");
      useSubagentStore.getState().reset();
      setActiveConversationId(key);
      navigate(routes.conversation(key));
      setDrawerOpen(false);
    },
    [setActiveConversationId, navigate],
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

  // `useConversationActions.handleArchiveConversation` calls
  // `startNewConversation({ silent: true })` when the active conversation
  // is archived. Mirror the existing `handleStartNewConversation` shape but
  // accept the silent opt so the haptic doesn't fire on a side-effect path.
  const startNewConversation = useCallback(
    ({ silent }: { silent?: boolean } = {}) => {
      if (!silent) haptic.light();
      useViewerStore.getState().setMainView("chat");
      const draftConversationId = createDraftConversationId();
      useConversationStore.getState().setActiveConversationId(draftConversationId);
      void navigate(routes.conversation(draftConversationId));
      requestComposerFocus();
    },
    [navigate],
  );

  const {
    handleArchiveConversation,
    handleUnarchiveConversation,
    handleMarkConversationUnread,
    handleMarkConversationRead,
    handleTogglePinConversation,
    handleMoveToGroup,
    handleRemoveFromGroup,
    handleRenameConversation,
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

  // -------------------------------------------------------------------------
  // Command palette — sections, item dispatch
  // -------------------------------------------------------------------------
  const { commandPalette, mergedSections, handleItemSelect } =
    useCommandPaletteOrchestrator({
      assistantId,
      assistantName: assistantName ?? undefined,
      conversations,
      activeConversationId: activeConversationId ?? undefined,
      startNewConversation: () => startNewConversation(),
      switchConversation: handleSelectConversation,
    });

  // Electron host commands (File menu / future global hotkeys). The hook
  // is a no-op on the web host. Handlers close over the latest state via
  // an internal ref, so we don't need to memoize them. Composer focus is
  // routed via `requestComposerFocus` (see `./composer-focus.ts`) so it
  // works whether ChatPage is already mounted (event listener) or the
  // command comes from another `/assistant/*` route (pending flag drained
  // on the next ChatPage mount).
  useVellumCommands({
    newConversation: () => {
      startNewConversation();
    },
    currentConversation: () => {
      if (!activeConversationId) return;
      const target = routes.conversation(activeConversationId);
      if (location.pathname !== target) {
        void navigate(target);
      }
      requestComposerFocus();
    },
    markCurrentUnread: () => {
      if (!activeConversationId) return;
      const conversation = conversations.find(
        (c) => c.conversationId === activeConversationId,
      );
      if (conversation) handleMarkConversationUnread(conversation);
    },
  });

  const handleOpenLibrary = useCallback(() => {
    navigate(routes.library.root);
  }, [navigate]);

  const isLibraryActive = location.pathname.startsWith("/assistant/library");

  // Only highlight a conversation row in the sidebar when the user is
  // actually viewing it. On non-conversation routes (Identity, Library,
  // Home, etc.) no conversation row should appear active. The store value
  // is intentionally left intact — many other consumers (SSE streams,
  // attention tracking, message reconciliation) rely on it persisting
  // across route changes.
  const isOnConversationRoute =
    location.pathname === routes.assistant ||
    location.pathname === `${routes.assistant}/` ||
    location.pathname.startsWith("/assistant/conversations/");
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
  const authUser = useAuthStore.use.user();
  const showLlmInspector = canUseLlmInspector(authUser);
  const handleInspectConversation = useCallback(
    (conversation: Conversation) => {
      void navigate(routes.inspect(conversation.conversationId));
    },
    [navigate],
  );

  const renderSideMenu = useCallback(
    (args: SideMenuRenderArgs): ReactNode => (
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
        onStartNewConversation={handleStartNewConversation}
        isIntelligenceActive={isIdentityActive}
        onOpenIntelligence={handleOpenIdentity}
        isLibraryActive={isLibraryActive}
        onOpenLibrary={handleOpenLibrary}
        activeAppId={activeAppId ?? undefined}
        onOpenApp={handleOpenAppFromSidebar}
        onPinConversation={handleTogglePinConversation}
        onRenameConversation={handleRenameConversation}
        onArchiveConversation={handleArchiveConversation}
        onUnarchiveConversation={handleUnarchiveConversation}
        onMarkConversationUnread={handleMarkConversationUnread}
        onMarkConversationRead={handleMarkConversationRead}
        onMoveToGroup={handleMoveToGroup}
        onRemoveFromGroup={handleRemoveFromGroup}
        onRenameGroup={handleRenameGroup}
        onDeleteGroup={handleDeleteGroup}
        onMarkAllReadInGroup={handleMarkAllReadInGroup}
        onArchiveAllInGroup={handleArchiveAllInGroup}
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
    ),
    [
      assistantId,
      assistantName,
      assistantVersion,
      conversations,
      conversationGroups,
      sidebarActiveConversationId,
      processingConversationIds,
      attentionConversationIds,
      handleSelectConversation,
      handleStartNewConversation,
      handleTogglePinConversation,
      handleRenameConversation,
      handleArchiveConversation,
      handleUnarchiveConversation,
      handleMarkConversationUnread,
      handleMarkConversationRead,
      handleMoveToGroup,
      handleRemoveFromGroup,
      handleRenameGroup,
      handleDeleteGroup,
      handleMarkAllReadInGroup,
      handleArchiveAllInGroup,
      isIdentityActive,
      handleOpenIdentity,
      isLibraryActive,
      handleOpenLibrary,
      activeAppId,
      handleOpenAppFromSidebar,
      showLlmInspector,
      handleInspectConversation,
    ],
  );

  return (
    <>
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

      <OfflineBanner />

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
                  onClose: () => setDrawerOpen(false),
                })}
              </aside>
            </div>
          ) : null}
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
            <Outlet  />
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

// ---------------------------------------------------------------------------
// Rename dialog — reads shared store, submits via the daemon SDK.
// Extracted as a sub-component so the optimistic-update logic lives
// alongside the dialog rather than threading callbacks through the
// parent's 60-item dependency tree.
// ---------------------------------------------------------------------------

function RenameDialogFromStore({ assistantId }: { assistantId: string | null }) {
  const renameRequest = useRenameRequestStore.use.renameRequest();
  const clearRename = useRenameRequestStore.use.clearRename();
  const queryClient = useQueryClient();

  const handleSubmit = useCallback(
    async (newTitle: string) => {
      if (!renameRequest || !assistantId) return;
      const { conversationId, currentTitle } = renameRequest;
      clearRename();

      const trimmed = newTitle.trim();
      if (!trimmed || trimmed === currentTitle) return;

      patchConversation(queryClient, assistantId, conversationId, {
        title: trimmed,
      });

      try {
        await conversationsByIdNamePatch({
          path: { assistant_id: assistantId, id: conversationId },
          body: { name: trimmed },
          throwOnError: true,
        });
      } catch (err) {
        patchConversation(queryClient, assistantId, conversationId, {
          title: currentTitle,
        });
        captureError(err, { context: "renameConversation" });
      }
    },
    [assistantId, queryClient, renameRequest, clearRename],
  );

  return (
    <RenameConversationDialog
      open={renameRequest !== null}
      currentTitle={renameRequest?.currentTitle ?? ""}
      onSubmit={handleSubmit}
      onCancel={clearRename}
    />
  );
}

// ---------------------------------------------------------------------------
// ChatConversationHeader — self-contained header center content.
//
// Renders "New conversation" when no conversation is active, or the
// ConversationActionsMenu dropdown with the conversation title trigger.
//
// Primary actions (archive, pin, rename, mark-read) come from
// useConversationActions, which this component calls directly —
// eliminating the duplicate call that previously lived in ChatPage.
// Secondary actions (fork, analyze, inspect) come from the
// headerSupplements that ChatPage writes to the slot store.
// ---------------------------------------------------------------------------

function ChatConversationHeader() {
  const assistantId = useAssistantSelectionStore.use.activeAssistantId();
  const activeConversationId = useConversationStore.use.activeConversationId();
  const assistantState = useAssistantLifecycleStore.use.assistantState();
  const selfHostedChatEnabled = useClientFeatureFlagStore.use.selfHostedAssistant();
  const conversationGroupsUI = useAssistantFeatureFlagStore.use.conversationGroupsUI();
  const authUser = useAuthStore.use.user();
  const showLlmInspector = canUseLlmInspector(authUser);
  const navigate = useNavigate();

  const shouldRenderChat =
    assistantState.kind === "active" ||
    (assistantState.kind === "self_hosted" && selfHostedChatEnabled);

  const { conversations } = useConversationListQuery(assistantId, shouldRenderChat);
  const { conversationGroups } = useConversationGroupsQuery(
    assistantId,
    shouldRenderChat && conversationGroupsUI,
  );

  const activeConversation = useMemo(
    () => conversations.find((c) => c.conversationId === activeConversationId) ?? null,
    [conversations, activeConversationId],
  );

  const headerSupplements = useChatLayoutSlotsStore.use.headerSupplements();

  const switchConversation = useCallback(
    (key: string) => {
      useSubagentStore.getState().reset();
      void navigate(routes.conversation(key));
    },
    [navigate],
  );

  const startNewConversation = useCallback(
    ({ silent }: { silent?: boolean } = {}) => {
      if (!silent) haptic.light();
      useViewerStore.getState().setMainView("chat");
      useSubagentStore.getState().reset();
      const draftId = createDraftConversationId();
      useConversationStore.getState().setActiveConversationId(draftId);
      void navigate(routes.conversation(draftId));
      requestComposerFocus();
    },
    [navigate],
  );

  const prePinGroupIdsRef = useRef<Map<string, string | undefined>>(new Map());

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
    activeConversationId,
    conversations,
    switchConversation,
    startNewConversation,
    prePinGroupIdsRef,
  });

  if (!activeConversation) {
    if (!assistantId) return null;
    return (
      <span className="text-sm font-medium text-[var(--content-default)]">
        New conversation
      </span>
    );
  }

  const isReadonly = isChannelConversation(activeConversation);
  const moveToGroups = buildMoveToGroupTargets(activeConversation, conversationGroups);
  const isPinned = activeConversation.isPinned || activeConversation.groupId === "system:pinned";
  const isArchived = activeConversation.archivedAt != null;

  return (
    <ConversationActionsMenu
      variant="header"
      isPinned={isPinned}
      isArchived={isArchived}
      isReadonly={isReadonly}
      onPinToggle={() => handleTogglePinConversation(activeConversation)}
      onRename={() => handleRenameConversation(activeConversation)}
      onArchive={() => handleArchiveConversation(activeConversation)}
      onUnarchive={() => handleUnarchiveConversation(activeConversation)}
      onAnalyze={
        !isReadonly && headerSupplements?.onAnalyze && activeConversation.conversationId
          ? () => headerSupplements.onAnalyze!(activeConversation)
          : undefined
      }
      onForkConversation={
        !isReadonly && headerSupplements?.hasPersistedMessage && headerSupplements?.onForkConversation
          ? headerSupplements.onForkConversation
          : undefined
      }
      onOpenInNewWindow={
        headerSupplements?.onOpenInNewWindow && activeConversation.conversationId
          ? () => headerSupplements.onOpenInNewWindow!(activeConversation)
          : undefined
      }
      onInspect={
        showLlmInspector && headerSupplements?.onInspect && activeConversation.conversationId
          ? () => headerSupplements.onInspect!(activeConversation)
          : undefined
      }
      onCopyConversation={headerSupplements?.onCopyConversation ?? undefined}
      onRefresh={
        headerSupplements?.onRefresh && activeConversation.conversationId != null
          ? headerSupplements.onRefresh
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
        !isReadonly && activeConversation.hasUnseenLatestAssistantMessage === false
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
          <span className="flex min-w-0 items-center gap-1.5">
            {headerSupplements?.slackHeaderLabel ? (
              <img
                src="/images/integrations/slack.svg"
                alt=""
                aria-hidden="true"
                className="h-3.5 w-3.5 shrink-0"
              />
            ) : null}
            <span className="min-w-0 max-w-[220px] truncate leading-6">
              {isArchived && (
                <span className="mr-1 text-[var(--content-tertiary)]">
                  [Archived]
                </span>
              )}
              {activeConversation.title ?? "Untitled"}
            </span>
            {headerSupplements?.slackHeaderLabel ? (
              <span className="hidden max-w-[160px] shrink truncate leading-6 text-[var(--content-tertiary)] sm:inline">
                ({headerSupplements.slackHeaderLabel})
              </span>
            ) : null}
          </span>
        </Button>
      }
    />
  );
}
