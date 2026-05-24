import * as Sentry from "@sentry/react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Outlet, useLocation, useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";

import { haptic } from "@/utils/haptics.js";
import { routes } from "@/utils/routes.js";
import { MOBILE_MEDIA_QUERY, useIsMobile } from "@/hooks/use-is-mobile.js";
import { useAssistantSyncStream } from "@/domains/chat/hooks/use-assistant-sync-stream.js";
import { useRootOutletContext } from "@/root-layout.js";
import { useAssistantIdentityInit } from "@/hooks/use-assistant-identity-init.js";
import { useAssistantAvatar } from "@/domains/avatar/use-assistant-avatar.js";
import { useDynamicFavicon } from "@/domains/avatar/use-dynamic-favicon.js";
import { useHomeUnreadBadge } from "@/hooks/use-home-unread-badge.js";
import type { AssistantContextValue } from "@/components/layout/assistant-context.js";

import { useConversationStore } from "@/domains/conversations/conversation-store.js";
import {
  chatContextQueryKey,
  useConversationGroupsQuery,
  useConversationListQuery,
} from "@/domains/conversations/conversation-queries.js";
import { useAttentionTracking } from "@/domains/conversations/use-attention-tracking.js";
import { useConversationActions } from "@/domains/conversations/use-conversation-actions.js";
import { useConversationGroupActions } from "@/domains/conversations/use-conversation-group-actions.js";
import { useClientFeatureFlagStore } from "@/lib/feature-flags/client-feature-flag-store.js";
import { useAssistantFeatureFlagStore } from "@/lib/feature-flags/assistant-feature-flag-store.js";
import { useViewerStore } from "@/stores/viewer-store.js";
import { useSubagentStore } from "@/domains/subagents/subagent-store.js";
import { useAuthStore } from "@/stores/auth-store.js";
import { canUseLlmInspector } from "@/domains/chat/inspector/access.js";
import type { Conversation } from "@/domains/chat/api/conversations.js";

import { OfflineBanner } from "@/components/offline-banner.js";
import { AssistantSideMenu } from "@/domains/chat/components/assistant-side-menu.js";
import { PreferencesMenu } from "@/domains/chat/components/preferences-menu.js";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store.js";
import { createDraftConversationId } from "@/domains/chat/utils/conversation-selection.js";
import { ChatLayoutHeader } from "./chat-layout-header.js";

/**
 * LocalStorage key used to persist the collapsed state of the sidebar rail
 * across reloads.
 */
export const SIDEBAR_COLLAPSED_STORAGE_KEY = "assistantSidebarCollapsed";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function readPersistedCollapsed(): boolean {
  try {
    return (
      window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "true"
    );
  } catch {
    return false;
  }
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
  onClose?: () => void;
  onSearch?: () => void;
}

/**
 * Chat-specific layout route providing sidebar rail, mobile drawer, keyboard
 * shortcuts (Ctrl+\, Ctrl+K, Ctrl+[/]), and the chat header bar. Owns the
 * assistant lifecycle and passes the resolved state to child routes via
 * outlet context.
 *
 * References:
 * - React Router nested layouts: https://reactrouter.com/start/data/routing
 * - React Router outlet context: https://reactrouter.com/start/framework/outlet
 */
export function ChatLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { lifecycle } = useRootOutletContext();

  // Subscribe to the sidebar conversation list at the layout level so every
  // chat-layout child route (home, library, contacts, identity, chat)
  // inherits a populated sidebar on direct navigation — not just /assistant.
  // TanStack Query handles dedup with any other consumer using the same key.
  const conversationGroupsUI = useAssistantFeatureFlagStore.use.conversationGroupsUI();
  const homePageEnabled = useClientFeatureFlagStore.use.homePage();
  const isAssistantActive = lifecycle.assistantState.kind === "active";
  const { conversations } = useConversationListQuery(
    lifecycle.assistantId,
    isAssistantActive,
  );
  const { conversationGroups } = useConversationGroupsQuery(
    lifecycle.assistantId,
    isAssistantActive && conversationGroupsUI,
  );

  // Track processing/attention indicators for every conversation in
  // the sidebar, on every chat-layout child route. Mounted at layout
  // scope so the bus-driven `interaction_resolved` subscriber and the
  // post-reconnect reconcile sweep stay live across home, library,
  // contacts, identity, and chat — not only inside `/assistant`.
  useAttentionTracking({
    assistantId: lifecycle.assistantId,
    assistantStateKind: lifecycle.assistantState.kind,
  });

  // Group CRUD handlers live at the layout level since the sidebar's
  // create/rename/delete affordances are rendered here, not in ChatPage.
  // The hook is self-sufficient (cache invalidation handles rollback), so
  // it can live wherever the sidebar lives.
  const { handleRenameGroup, handleDeleteGroup } =
    useConversationGroupActions({
      assistantId: lifecycle.assistantId,
      conversationGroups,
    });

  // Hydrate the sidebar assistant name at the layout level so the
  // sidebar header shows the correct name on every chat-layout child
  // route — not only inside a conversation where ChatPage owns the
  // fetch.
  useAssistantIdentityInit({
    assistantId: lifecycle.assistantId,
    assistantStateKind: lifecycle.assistantState.kind,
  });

  // Sync the browser favicon to the assistant's avatar across every
  // chat-layout child route — not just ChatPage. Mounting this in the
  // layout keeps the favicon live while the user is on identity,
  // library, workspace, contacts, or home (where ChatPage isn't
  // mounted). The hook is a no-op when assistantId is null.
  const layoutAvatar = useAssistantAvatar(lifecycle.assistantId);
  useDynamicFavicon(
    layoutAvatar.customImageUrl,
    layoutAvatar.components,
    layoutAvatar.traits,
  );

  // Routes assistant-global sync events from `bus.sse.event` into the
  // avatar / identity / config / sounds / schedules / conversation
  // list query caches so the sidebar stays live on every chat-layout
  // child route.
  useAssistantSyncStream(lifecycle.assistantId, isAssistantActive);

  // Home page unread indicator — drives the red dot on the Home button in
  // the layout header. Gated on the homePage feature flag so the hook
  // doesn't fire its query when the home route is disabled.
  const { hasUnreadHome } = useHomeUnreadBadge(
    homePageEnabled ? lifecycle.assistantId : null,
  );

  // --- Layout slot state for child route content ---
  const [topBarCenter, setTopBarCenter] = useState<ReactNode>(null);
  const [topBarRightSlot, setTopBarRightSlot] = useState<ReactNode>(null);
  const [footerBanner, setFooterBanner] = useState<ReactNode>(null);
  const onSearchClickRef = useRef<(() => void) | null>(null);
  const setOnSearchClick = useCallback((cb: (() => void) | null) => {
    onSearchClickRef.current = cb;
  }, []);

  // --- Assistant identity from store (written by ChatPage) ---
  const assistantName = useAssistantIdentityStore.use.name();
  const assistantVersion = useAssistantIdentityStore.use.version();

  const assistantContext = useMemo<AssistantContextValue>(
    () => ({
      assistantId: lifecycle.assistantId,
      assistantState: lifecycle.assistantState,
      checkAssistant: lifecycle.checkAssistant,
      retryAssistant: lifecycle.retryAssistant,
      hatchVersion: lifecycle.hatchVersion,
      setAssistantId: lifecycle.setAssistantId,
      autoGreetRef: lifecycle.autoGreetRef,
      setTopBarCenter,
      setTopBarRightSlot,
      setOnSearchClick,
      setFooterBanner,
    }),
    [
      lifecycle.assistantId,
      lifecycle.assistantState,
      lifecycle.checkAssistant,
      lifecycle.retryAssistant,
      lifecycle.hatchVersion,
      lifecycle.setAssistantId,
      lifecycle.autoGreetRef,
      setOnSearchClick,
      setFooterBanner,
    ],
  );

  // --- History tracking for back/forward nav ---
  const historyIndexRef = useRef(0);
  const maxHistoryIndexRef = useRef(0);

  const prevLocationRef = useRef(location);
  if (prevLocationRef.current !== location) {
    historyIndexRef.current = window.history.state?.idx ?? 0;
    maxHistoryIndexRef.current = Math.max(
      maxHistoryIndexRef.current,
      historyIndexRef.current,
    );
    prevLocationRef.current = location;
  }

  const canGoBack = historyIndexRef.current > 0;
  const canGoForward = historyIndexRef.current < maxHistoryIndexRef.current;

  const handleStartNewConversation = useCallback(() => {
    haptic.light();
    useViewerStore.getState().setMainView("chat");
    const draftConversationId = createDraftConversationId();
    useConversationStore.getState().setActiveConversationId(draftConversationId);
    void navigate(routes.conversation(draftConversationId));
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

  useEffect(() => {
    try {
      window.localStorage.setItem(
        SIDEBAR_COLLAPSED_STORAGE_KEY,
        String(collapsed),
      );
    } catch {
      // Storage unavailable (private mode, quota, etc.)
    }
  }, [collapsed]);

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
  const queryClient = useQueryClient();
  const prePinGroupIdsRef = useRef<Map<string, string | undefined>>(new Map());

  const refreshConversations = useCallback(async () => {
    if (!lifecycle.assistantId) return;
    try {
      await queryClient.invalidateQueries({
        queryKey: chatContextQueryKey(lifecycle.assistantId),
      });
    } catch (err) {
      Sentry.captureException(err, {
        tags: { context: "refresh_conversations" },
      });
    }
  }, [lifecycle.assistantId, queryClient]);

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
  } = useConversationActions({
    assistantId: lifecycle.assistantId,
    activeConversationId,
    conversations,
    refreshConversations,
    switchConversation: handleSelectConversation,
    startNewConversation,
    prePinGroupIdsRef,
  });

  const handleOpenLibrary = useCallback(() => {
    navigate(routes.library.root);
  }, [navigate]);

  const isLibraryActive = location.pathname.startsWith("/assistant/library");

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
        assistantId={lifecycle.assistantId ?? ""}
        assistantName={assistantName}
        collapsed={args.collapsed}
        variant={args.variant}
        conversations={conversations}
        conversationGroups={conversationGroups}
        activeConversationId={activeConversationId ?? undefined}
        processingConversationIds={processingConversationIds}
        attentionConversationIds={attentionConversationIds}
        onSelectConversation={handleSelectConversation}
        onStartNewConversation={handleStartNewConversation}
        isIntelligenceActive={isIdentityActive}
        onOpenIntelligence={handleOpenIdentity}
        isLibraryActive={isLibraryActive}
        onOpenLibrary={handleOpenLibrary}
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
        onInspect={showLlmInspector ? handleInspectConversation : undefined}
        footerBanner={footerBanner}
        footerAction={
          <PreferencesMenu
            assistantId={lifecycle.assistantId}
            assistantVersion={assistantVersion}
            activeConversationId={activeConversationId}
          />
        }
        onClose={args.onClose}
        onSearchClick={args.onSearch}
      />
    ),
    [
      lifecycle.assistantId,
      assistantName,
      assistantVersion,
      conversations,
      conversationGroups,
      activeConversationId,
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
      isIdentityActive,
      handleOpenIdentity,
      isLibraryActive,
      handleOpenLibrary,
      showLlmInspector,
      handleInspectConversation,
      footerBanner,
    ],
  );

  return (
    <>
      <ChatLayoutHeader
        isMobile={isMobile}
        drawerOpen={drawerOpen}
        collapsed={collapsed}
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
        onSearchClick={() => onSearchClickRef.current?.()}
      />

      <OfflineBanner />

      {isMobile ? (
        <main className="relative flex min-w-0 flex-1 min-h-0 flex-col overflow-hidden">
          <Outlet context={assistantContext} />
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
                  onSearch: () => onSearchClickRef.current?.(),
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
            {renderSideMenu({ collapsed, variant: "rail", onSearch: () => onSearchClickRef.current?.() })}
          </aside>
          <main className="flex min-w-0 flex-1 min-h-0 flex-col overflow-hidden">
            <Outlet context={assistantContext} />
          </main>
        </div>
      )}
    </>
  );
}
