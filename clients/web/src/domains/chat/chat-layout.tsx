import {
  lazy,
  useCallback,
  useEffect,
  useLayoutEffect,
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
import { SIDE_MENU_TILE_SIZE } from "@vellumai/design-library";

import { useAssistantLifecycleStore } from "@/assistant/lifecycle-store";
import {
  selectChatFocusActive,
  selectHeaderCenterHidden,
  selectHeaderControlsHidden,
  selectTourActive,
  useInChatOnboardingStore,
} from "@/stores/in-chat-onboarding-store";
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
  isConversationChatPath,
  isConversationPath,
  routes,
} from "@/utils/routes";

import { useChatLayoutSlotsStore } from "@/components/layout/chat-layout-slots-store";
import { useElectronDockSync } from "@/domains/chat/hooks/use-electron-dock-sync";
import { useNativeRecentChatsSync } from "@/domains/chat/hooks/use-native-recent-chats-sync";
import { useNativeWidgetSnapshotSync } from "@/domains/chat/hooks/use-native-widget-snapshot-sync";
import { useOpenAppFromChat } from "@/domains/chat/hooks/use-open-app-from-chat";
import { DRAWER_SURFACE_BACKGROUND } from "@/domains/chat/utils/drawer-surface";
import {
  EDGE_SWIPE_EASING,
  EDGE_SWIPE_SLIDE_MS,
} from "@/hooks/edge-swipe-motion";
import { useSoftKeyboardOpen } from "@/hooks/use-keyboard-open";
import { useSwipeDownDismissKeyboard } from "@/hooks/use-swipe-down-dismiss-keyboard";
import { useCommandPaletteStore } from "@/stores/command-palette-store";
import { useMobileDrawerStore } from "@/stores/mobile-drawer-store";

import { useActiveConversation } from "@/domains/chat/hooks/use-active-conversation";
import { useAttentionTracking } from "@/domains/chat/hooks/use-attention-tracking";
import { isTranscriptOnScreen } from "@/domains/chat/utils/transcript-visibility";
import { useChatLayoutDrawer } from "@/domains/chat/hooks/use-chat-layout-drawer";
import { useChatLayoutDrawerGestures } from "@/domains/chat/hooks/use-chat-layout-drawer-gestures";
import { useChatLayoutShortcuts } from "@/domains/chat/hooks/use-chat-layout-shortcuts";
import { useConversationActions } from "@/domains/chat/hooks/use-conversation-actions";
import { useConversationGroupActions } from "@/domains/chat/hooks/use-conversation-group-actions";
import { useConversationListDeepLink } from "@/domains/chat/hooks/use-conversation-list-deep-link";
import { useMaterializedDraftReconcile } from "@/domains/chat/hooks/use-materialized-draft-reconcile";
import { useGroupNameRequestStore } from "@/domains/chat/group-name-request-store";
import { useCanUseInternalThreadActions } from "@/lib/auth/internal-thread-actions";
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
import { SidebarTipCard } from "@/components/tips/sidebar-tip-card";
import { ensureTipsFirstSeenAt } from "@/utils/tips-storage";
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
import {
  ArchiveAllConfirmDialog,
  useArchiveAllConfirmation,
} from "./components/archive-all-confirm-dialog";
import {
  DeleteConversationConfirmDialog,
  useDeleteConversationConfirmation,
} from "./components/delete-conversation-confirm-dialog";
import { GroupNameDialogFromStore } from "./group-name-dialog-from-store";
import { RenameDialogFromStore } from "./rename-dialog-from-store";
import { useTranslation } from "@/i18n";

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
export function ChatLayout({
  topBarAccessory,
}: {
  /**
   * Persistent element for the header's top-right, after the per-route
   * slot content (currently the notifications bell). Injected by
   * `routes.tsx` because its implementation lives in another domain,
   * which this layout must not import directly.
   */
  topBarAccessory?: ReactNode;
} = {}) {
  const { t } = useTranslation("chat");
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
  // `isLoading` (first fetch actually in flight), not `isPending`: the query
  // is gated on `isAssistantActive`, and a gated query is pending without
  // fetching, which would leave the sidebar under placeholders for as long as
  // the assistant took to come up (or forever, if it never did).
  //
  // `isAssistantActive` is the assistant record: does this assistant exist and
  // is it provisioned. Whether its pod is reachable is a separate question,
  // answered inside the query hook itself, since these keys are shared with
  // call sites that pass no gate of their own.
  const {
    conversations,
    isLoading: isLoadingConversations,
    isPending: isConversationListPending,
    isError: conversationsFailed,
    refetch: retryConversations,
  } = useConversationListQuery(assistantId, isAssistantActive);
  const {
    conversationGroups,
    isPending: isGroupsPending,
    isError: groupsFailed,
  } = useConversationGroupsQuery(assistantId, isAssistantActive);

  // A client-minted conversation key stops being a draft once the server's own
  // list carries a row for it. Mounted against the list this layout already
  // subscribes to, so it costs no request. See
  // `./hooks/use-materialized-draft-reconcile.ts`.
  useMaterializedDraftReconcile(conversations);

  // Whether the transcript is on screen, resolved here because this is where
  // the route, the viewer and the viewport are all in hand. One owner, so
  // consumers cannot disagree about it.
  const isMobile = useIsMobile();
  const viewerMainView = useViewerStore.use.mainView();
  const viewerAppMinimized = useViewerStore.use.isAppMinimized();
  const transcriptOnScreen = isTranscriptOnScreen({
    pathname: location.pathname,
    mainView: viewerMainView,
    isAppMinimized: viewerAppMinimized,
    isNarrow: isMobile,
  });

  // Track processing/attention indicators for every conversation in
  // the sidebar, on every chat-layout child route. Mounted at layout
  // scope so the bus-driven `interaction_resolved` subscriber and the
  // post-reconnect reconcile sweep stay live across home, library,
  // contacts, identity, and chat — not only inside `/assistant`.
  useAttentionTracking({
    assistantId,
    assistantStateKind,
    isTranscriptOnScreen: transcriptOnScreen,
  });

  // Group CRUD handlers live at the layout level since the sidebar's
  // create/rename/delete affordances are rendered here, not in ChatPage.
  // The hook is self-sufficient (cache invalidation handles rollback), so
  // it can live wherever the sidebar lives.
  const { createGroup, renameGroup, handleDeleteGroup } =
    useConversationGroupActions({
      assistantId,
      conversationGroups,
    });

  // Mirror the unread count into the Electron Dock (no-op off Electron).
  // Prefers the server-side unread count, falling back to counting the
  // conversation list this layout already subscribes to; see
  // `./hooks/use-electron-dock-sync.ts`.
  useElectronDockSync(assistantId, conversations, isAssistantActive);

  // Mirror the same list into the iOS shell's recent-chats cache, which backs
  // the Shortcuts app's chat picker ("Send Message to Chat"). No-op off
  // Capacitor iOS. Resolved means the query has actually SUCCEEDED: pending
  // (loading, or gated on the assistant/pod) and error both serve the `[]`
  // fallback, and either would wipe the last-known-good native cache. The
  // error case is live, not theoretical: a pod that is waking 503s the list
  // through its whole retry budget into a terminal error (#40621).
  useNativeRecentChatsSync(
    conversations,
    !isConversationListPending && !conversationsFailed,
  );

  // And into the iOS shell's widget snapshot, which backs the Home Screen
  // widgets (unread and in-progress counts, the three most recent chats).
  // No-op off Capacitor iOS, and resolved carries the same meaning it does
  // for the recent-chats sync above: an unresolved `[]` would blank the
  // widgets for as long as the list failed to load. It covers BOTH queries
  // here, because the widget snapshot carries group subtitles as well as the
  // rows, and the groups query serves its own `[]` fallback while pending,
  // gated, or errored: either input resolving alone would overwrite a valid
  // snapshot with one whose subtitles are all missing.
  useNativeWidgetSnapshotSync(
    assistantId,
    conversations,
    conversationGroups,
    isAssistantActive,
    !isConversationListPending &&
      !conversationsFailed &&
      !isGroupsPending &&
      !groupsFailed,
  );

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
  const showInternalActions = useCanUseInternalThreadActions();
  const isNative = useIsNativePlatform();
  const electron = isElectron();
  // In-chat onboarding prototype: the tour's opening beats hide the sidebar
  // and header controls; the tour reveals them itself as it walks.
  const chatFocusActive = useInChatOnboardingStore(selectChatFocusActive);
  const headerControlsHidden = useInChatOnboardingStore(
    selectHeaderControlsHidden,
  );
  const headerCenterHidden = useInChatOnboardingStore(selectHeaderCenterHidden);
  const navTourActive = useInChatOnboardingStore.use.navTourActive();
  const tourActive = useInChatOnboardingStore(selectTourActive);

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

  const handleOpenIdentity = useCallback(() => {
    navigate(routes.identity);
  }, [navigate]);

  const handleGoBack = useCallback(() => {
    navigate(-1);
  }, [navigate]);

  const handleGoForward = useCallback(() => {
    navigate(1);
  }, [navigate]);

  // Schedules paths count as About Assistant (via isAboutAssistantPath) —
  // the Schedules surface is a drill-down section under the overview.
  const isIdentityActive = isAboutAssistantPath(location.pathname);

  // --- Sidebar collapsed / drawer state ---
  const [collapsed, setCollapsed] = useState<boolean>(readPersistedCollapsed);
  const [sidebarWidth, setSidebarWidth] = useState<number>(readPersistedWidth);
  // The tour walks the sidebar's rows, which the collapsed rail doesn't
  // show — so the tour's whole run forces the rail expanded. Derived (not
  // written through setCollapsed) so the user's persisted preference is
  // untouched and the rail collapses back on its own when the tour ends.
  const effectiveCollapsed = collapsed && !tourActive;

  useEffect(() => {
    setLocalBool(SIDEBAR_COLLAPSED_STORAGE_KEY, collapsed);
  }, [collapsed]);

  const handleSidebarWidthChange = useCallback((width: number) => {
    setSidebarWidth(width);
    setLocalNumber(SIDEBAR_WIDTH_STORAGE_KEY, Math.round(width));
  }, []);

  // The tour's focused stage slides the whole rail away and bounces it back
  // on reveal. Driven with the Web Animations API rather than a standing
  // inline width + transition on the rail's wrapper: React only learns new
  // widths when a drag commits on pointer-up, so a standing wrapper width
  // lags the SideMenu nav's live drag-resize and, with the wrapper's
  // overflow clip, pins the visible edge at the stale width whenever the
  // nav is dragged wider.
  // The node lives in state (callback ref) so the effect re-runs when the
  // desktop aside leaves and re-enters the tree (mobile layout swaps), not
  // only when the focus flag flips.
  const [sideMenuAside, setSideMenuAside] = useState<HTMLElement | null>(null);
  const railFocusAnimationsRef = useRef<Animation[]>([]);
  const prevChatFocusRef = useRef(chatFocusActive);
  useEffect(() => {
    // Snapshot before the null check: focus flips that land while the aside
    // is absent must still be recorded, so a later remount settles into the
    // current state instead of replaying the missed transition.
    const prev = prevChatFocusRef.current;
    prevChatFocusRef.current = chatFocusActive;
    if (!sideMenuAside) {
      // Drop animations that target the departed node so a remount
      // reinitializes from scratch.
      for (const animation of railFocusAnimationsRef.current) {
        animation.cancel();
      }
      railFocusAnimationsRef.current = [];
      return;
    }
    const aside = sideMenuAside;
    if (prev === chatFocusActive) {
      if (chatFocusActive && railFocusAnimationsRef.current.length === 0) {
        // Mounted (or remounted) while already focused: hold the hidden
        // state, no motion.
        railFocusAnimationsRef.current = [
          aside.animate(
            { width: "0px", opacity: "0", marginRight: "-16px" },
            { duration: 0, fill: "forwards" },
          ),
        ];
      }
      return;
    }
    // Sample mid-flight values before cancelling so a reversal starts from
    // where the rail visually is.
    const style = getComputedStyle(aside);
    const fromWidth = style.width;
    const fromMargin = style.marginRight;
    const fromOpacity = style.opacity;
    for (const animation of railFocusAnimationsRef.current) {
      animation.cancel();
    }
    if (chatFocusActive) {
      // Hide: ease away smoothly and hold width 0 while focused. The
      // negative margin cancels the row gap so the chat goes full-width.
      railFocusAnimationsRef.current = [
        aside.animate(
          [
            { width: fromWidth, marginRight: fromMargin },
            { width: "0px", marginRight: "-16px" },
          ],
          { duration: 500, easing: "ease-in-out", fill: "forwards" },
        ),
        aside.animate([{ opacity: fromOpacity }, { opacity: "0" }], {
          duration: 300,
          easing: "ease-in-out",
          fill: "forwards",
        }),
      ];
    } else {
      // Reveal: a back-ease so the rail lands with a slight bounce. The
      // landing width comes from state, not DOM measurement: skipping the
      // tour un-forces a collapsed rail in this same commit, so the nav's
      // measured width still reads expanded while it is already collapsing
      // to the rail width. No fill, so the wrapper returns to shrink-wrapping
      // the nav the moment the animation ends.
      //
      // A collapsed rail is one tile wide here: this layout renders the nav
      // without the design library's own padding and border (the page draws
      // that chrome), and the collapsed rail sizes its tile as content, so
      // nothing is added around it.
      const targetWidth = effectiveCollapsed
        ? SIDE_MENU_TILE_SIZE
        : sidebarWidth;
      railFocusAnimationsRef.current = [
        aside.animate(
          [
            { width: fromWidth, marginRight: fromMargin },
            { width: `${targetWidth}px`, marginRight: "0px" },
          ],
          { duration: 550, easing: "cubic-bezier(0.34, 1.56, 0.64, 1)" },
        ),
        aside.animate([{ opacity: fromOpacity }, { opacity: "1" }], {
          duration: 250,
          easing: "ease-out",
        }),
      ];
    }
  }, [chatFocusActive, sideMenuAside, effectiveCollapsed, sidebarWidth]);

  const [drawerOpen, setDrawerOpen] = useState<boolean>(false);

  // The two shapes the conversation list takes, as callbacks the deep-link
  // drain below can hold. Blurring first is what the toggle and the swipe do:
  // without it iOS keeps the soft keyboard up and the drawer slides in behind
  // it looking stuck.
  const openDrawerForDeepLink = useCallback(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    setDrawerOpen(true);
  }, []);
  // Uncollapsing writes the persisted preference, same as the toggle: the user
  // asked to see the list, and reverting it a moment later would be the
  // surprise.
  const expandSidebarForDeepLink = useCallback(() => setCollapsed(false), []);

  useEffect(() => {
    if (!isMobile) {
      setDrawerOpen(false);
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

  // The Home Screen widgets' unread chip and unread line
  // (`deeplink.openConversations`), drained after the close-on-navigation
  // effect above so an open it grants on the same commit is not undone by it.
  useConversationListDeepLink({
    isMobile,
    openDrawer: openDrawerForDeepLink,
    expandSidebar: expandSidebarForDeepLink,
  });

  // The tips new-user grace clock anchors to first app use. Stamping here
  // (not only in the tip hook) covers mobile, where the drawer-gated tip
  // card may not mount for days.
  useEffect(() => {
    ensureTipsFirstSeenAt();
  }, []);

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

  // Voice-room visibility. The room is a full-viewport takeover on every
  // platform (mounted at layout scope below): it covers the header and
  // sidebar until the session ends or the room is minimized (the session
  // then continues behind the composer voice bar / title-bar pill).
  const voiceRoomVisible = useIsVoiceRoomVisible();

  const drawerVisible = isMobile && drawerOpen;

  const toggleSidebar = useCallback(() => {
    // The tour forces the rail expanded; a toggle would only flip the
    // persisted preference invisibly (Ctrl+\ still fires under the tour's
    // click-blocking overlay), so ignore it for the tour's duration.
    if (selectTourActive(useInChatOnboardingStore.getState())) {
      return;
    }
    haptic.light();
    if (window.matchMedia(MOBILE_MEDIA_QUERY).matches) {
      setDrawerOpen((value) => {
        // Opening the drawer over a focused composer: drop focus so iOS
        // dismisses the soft keyboard. Left up, the keyboard stays raised and
        // the drawer appears wedged behind it. Only blur on open — closing
        // should not steal focus from whatever the user tapped into next.
        if (!value) {
          (document.activeElement as HTMLElement | null)?.blur();
        }
        return !value;
      });
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

  // Swipe-to-open from the left edge and swipe-to-close on the panel, plus the
  // presence the closing slide needs. See the hook for where each gesture
  // yields and why the panel outlives `drawerOpen`.
  const drawerGestures = useChatLayoutDrawerGestures({
    panelRef: drawerRef,
    isMobile,
    open: drawerOpen,
    onOpen: () => {
      // Same as the button path: swiping the drawer in over a focused
      // composer must blur it so iOS dismisses the soft keyboard, otherwise
      // the drawer slides in behind a raised keyboard and looks stuck.
      (document.activeElement as HTMLElement | null)?.blur();
      setDrawerOpen(true);
    },
    onClose: closeDrawer,
  });

  // Publish for surfaces that render outside this tree and would otherwise
  // paint over the drawer; see `mobile-drawer-store`. Mirrors the same
  // condition the drawer itself mounts on, so the two can't disagree: the
  // panel is still on screen through its closing slide, so the peek stays
  // parked until the slide ends.
  //
  // Layout effect, not passive: a passive effect runs after the browser can
  // paint, so the drawer's first frame would go up with the store still
  // reporting false and the peek still portaled over it. Publishing before
  // paint means the two never disagree on screen.
  const drawerPresented = isMobile && drawerGestures.present;
  const setDrawerPresented = useMobileDrawerStore.use.setPresented();
  useLayoutEffect(() => {
    setDrawerPresented(drawerPresented);
    return () => {
      setDrawerPresented(false);
    };
  }, [drawerPresented, setDrawerPresented]);

  // Swipe-down-to-dismiss-keyboard. Armed only while the soft keyboard is up,
  // so it costs nothing the rest of the time and cannot shadow the drawer
  // gestures above. It listens on `document` rather than on a container
  // because the whole surface over the keyboard should answer to it: the
  // thread, the banners, the composer chrome and the header alike, not just
  // the one scrollable strip a drag happens to land in.
  //
  // Gated on the keyboard alone, not on `useKeyboardOpen()`'s phone-width
  // variant: an iPad in landscape sits far above the mobile breakpoint and
  // still raises a soft keyboard. The hook's own coarse-pointer check is what
  // keeps the gesture off pointer devices.
  useSwipeDownDismissKeyboard({ enabled: useSoftKeyboardOpen() });

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

  // --- Sidebar conversation actions (pin / rename / archive / delete / mark / move) ---
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
    handleDeleteConversation,
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

  // The sidebar's "Archive All…" routes through this confirmation gate; the
  // ArchiveAllConfirmDialog mounted below (with the other sidebar dialogs)
  // runs the archive on confirm (LUM-3036).
  const {
    pending: pendingArchiveAll,
    requestArchiveAll,
    confirmArchiveAll,
    cancelArchiveAll,
  } = useArchiveAllConfirmation({
    assistantId,
    archiveAllInGroup: handleArchiveAllInGroup,
  });

  const {
    pending: pendingDeleteConversation,
    requestDelete,
    confirmDelete,
    cancelDelete,
  } = useDeleteConversationConfirmation({
    assistantId,
    deleteConversation: handleDeleteConversation,
  });

  // The move-to-group menu's "New group…" item and the group actions menu's
  // "Rename" open the shared NameInputDialog through the request store; the
  // GroupNameDialogFromStore connector (mounted below) performs the
  // create-then-move / rename on submit. Two entry points reach it: a
  // conversation's "New group…" (creates the group, then files that
  // conversation into it) and the sidebar's own right-click "New group…"
  // (creates an empty one).
  const handleRequestCreateGroup = useCallback(
    (conversation: Conversation) =>
      useGroupNameRequestStore.getState().requestCreateGroup(conversation),
    [],
  );
  const handleRequestCreateEmptyGroup = useCallback(
    () => useGroupNameRequestStore.getState().requestCreateGroup(),
    [],
  );
  const handleRequestRenameGroup = useCallback(
    (groupId: string) => {
      const group = conversationGroups.find((g) => g.id === groupId);
      useGroupNameRequestStore
        .getState()
        .requestRenameGroup(groupId, group?.name ?? "", group?.icon ?? null);
    },
    [conversationGroups],
  );

  // A pending group-name request captures a specific conversation ("New
  // group…") or group ("Rename"); if the active assistant changes before the
  // user submits, that target belongs to the previous assistant while the
  // create/move/rename would run against the new one. Clear it on assistant
  // change so we never act across a mismatched assistant.
  useEffect(() => {
    useGroupNameRequestStore.getState().clearGroupNameRequest();
  }, [assistantId]);

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
        showInternalActions={showInternalActions}
        onArchive={handleArchiveConversation}
        onUnarchive={handleUnarchiveConversation}
        onDelete={requestDelete}
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

  // Mount the palette on its first open and keep it mounted so the
  // AnimatePresence exit inside CommandPalette has a host; CommandPalette
  // renders nothing while closed on surfaces that have no exit. Items that
  // navigate outside this layout (Settings) unmount the subtree in the same
  // commit as the close, so those selections skip the exit.
  const [paletteEverOpened, setPaletteEverOpened] = useState(false);
  useEffect(() => {
    if (commandPalette.isOpen && !paletteEverOpened) {
      setPaletteEverOpened(true);
    }
  }, [commandPalette.isOpen, paletteEverOpened]);

  // Menu commands that act on the open conversation take the row from
  // `activeConversation`, which resolves background, scheduled, and archived
  // threads the foreground `conversations` list deliberately omits. They
  // no-op while no conversation is open.
  const withActiveConversation =
    (action: (conversation: Conversation) => void) => () => {
      if (activeConversation) {
        action(activeConversation);
      }
    };

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
    markCurrentUnread: withActiveConversation(handleMarkConversationUnread),
    togglePinConversation: withActiveConversation(handleTogglePinConversation),
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
  // See `use-open-app-from-chat.ts` for the full-width loadApp flow shared
  // with the transcript / assets-pill open path.
  const openAppFromChat = useOpenAppFromChat();
  const activeAppId = useViewerStore.use.activeAppId();
  const handleOpenAppFromSidebar = useCallback(
    async (appId: string) => {
      // Off a chat route the viewer panel has no surface to render against, so
      // we must land on one before opening the app. Routing to `/assistant`
      // isn't neutral: the chat index auto-bootstraps to the last active /
      // latest conversation (`use-conversation-loader`), which resurfaces the
      // stale conversation behind the app and once it's closed (LUM-2691) —
      // `activeConversationId` persists across route changes for SSE /
      // attention consumers, so it doesn't reflect the user's intent. Opening
      // over a fresh silent draft hands the loader an explicit id it won't
      // override and leaves a clean new-chat surface on close.
      if (!isConversationChatPath(location.pathname)) {
        navigateToNewConversation(navigate, { silent: true });
      }
      await openAppFromChat(appId);
    },
    [location.pathname, navigate, openAppFromChat],
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
      isLoadingConversations={isLoadingConversations}
      conversationsFailed={conversationsFailed}
      onRetryConversations={retryConversations}
      conversationGroups={conversationGroups}
      activeConversationId={sidebarActiveConversationId}
      processingConversationIds={processingConversationIds}
      attentionConversationIds={attentionConversationIds}
      onSelectConversation={handleSelectConversation}
      onStartNewConversation={startNewConversation}
      isIntelligenceActive={isIdentityActive}
      onOpenIntelligence={handleOpenIdentity}
      activeAppId={activeAppId ?? undefined}
      onOpenApp={handleOpenAppFromSidebar}
      onPinConversation={handleTogglePinConversation}
      onRenameConversation={handleRenameConversation}
      onArchiveConversation={handleArchiveConversation}
      onUnarchiveConversation={handleUnarchiveConversation}
      onDeleteConversation={requestDelete}
      onMarkConversationUnread={handleMarkConversationUnread}
      onMarkConversationRead={handleMarkConversationRead}
      onCreateGroup={handleRequestCreateEmptyGroup}
      onRenameGroup={handleRequestRenameGroup}
      onDeleteGroup={handleDeleteGroup}
      onMarkAllReadInGroup={handleMarkAllReadInGroup}
      onArchiveAllInGroup={requestArchiveAll}
      onOpenInNewWindow={isNative ? undefined : handleOpenInNewWindow}
      onInspect={showInternalActions ? handleInspectConversation : undefined}
      showInternalActions={showInternalActions}
      onMoveToGroup={handleMoveToGroup}
      onCreateGroupInto={handleRequestCreateGroup}
      onRemoveFromGroup={handleRemoveFromGroup}
      /* The same injected control the header carries, restated in the
         drawer's glyph row where the mock puts it. Sourced from the prop
         rather than imported, because it lives in another domain. */
      notificationsAction={
        args.variant === "overlay" ? topBarAccessory : undefined
      }
      footerAction={
        <PreferencesMenu
          assistantId={assistantId}
          assistantVersion={assistantVersion}
          activeConversationId={activeConversationId}
          triggerVariant={args.variant === "overlay" ? "pill" : "item"}
        />
      }
      // The overlay subtree mounts mid edge-swipe while still off-screen;
      // mounting the tip card there stamps an impression for a tip never
      // seen, so the overlay only gets it once the drawer settles open.
      // Hidden during the avatar tour for the same reason (plus noise) —
      // the tour owns the sidebar's attention.
      tipCard={
        (args.variant === "overlay" && !drawerOpen) ||
        navTourActive ? undefined : (
          <SidebarTipCard />
        )
      }
      onClose={args.onClose}
    />
  );

  // Blur the chat body under the MOBILE voice room, which is a full-viewport
  // takeover mounted outside `<main>`. The room is an opaque overlay, so this
  // mainly matters for the fade transition. Desktop is deliberately excluded:
  // its room is an inset panel mounted INSIDE `<main>`, so blurring `<main>`
  // would blur the room along with the chat behind it. Reachability is handled
  // by `chatContent` below on both platforms, not here.
  const mainRoomClass =
    voiceRoomVisible && isMobile
      ? "blur-sm opacity-40 transition-[filter,opacity]"
      : "";

  // The route content, held inert while the voice room covers it.
  //
  // The room paints over the chat but does not remove it from the page, so
  // without this the composer, transcript and their controls stay tabbable and
  // screen-reader reachable behind an opaque panel. `inert` takes the whole
  // subtree out of the tab order and the accessibility tree at once, which
  // neither the blur nor `aria-modal` does: the desktop room is deliberately
  // non-modal so the header and sidenav stay usable, and scoping the gate to
  // this wrapper is what keeps that chrome reachable while the content under
  // the panel is not.
  //
  // The wrapper carries `<main>`'s own flex classes so the route content sees
  // the same flex parent it would without it.
  const chatContent = (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      inert={voiceRoomVisible}
    >
      <Outlet />
    </div>
  );

  return (
    <>
      {/* An off-conversation session on a phone rides above the thread header
          as its own full-width row, in flow: it pushes the page down instead of
          overlaying it, so nothing is ever hidden behind a live session. The
          host renders null when there is no session to show. */}
      {!isPopout && isMobile ? <VoiceSessionPillHost variant="row" /> : null}

      {!isPopout && (
        <ChatLayoutHeader
          isMobile={isMobile}
          drawerOpen={drawerOpen}
          collapsed={effectiveCollapsed}
          sidebarWidth={sidebarWidth}
          toggleSidebar={toggleSidebar}
          controlsHidden={headerControlsHidden}
          centerHidden={headerCenterHidden}
          // The tour dims the header's clusters for its whole run — no
          // beat ever focuses them. (Center-hidden is true exactly while
          // the tour runs, so it doubles as the dim signal.)
          controlsDimmed={headerCenterHidden}
          topBarCenter={topBarCenter}
          // The voice-session pill is composed here — NOT registered through
          // useChatLayoutSlotsStore — because slot registration is owned by
          // per-route hooks that unmount on navigation, exactly when the pill
          // must persist. The host renders null when no session is active (or
          // while viewing the owning thread's composer), so the header is
          // unaffected otherwise. It leads the cluster rather than sitting
          // between search and the notification bell.
          //
          // Desktop only: a phone-width header cannot seat a pill next to the
          // centre title, so there the session takes the row above instead.
          topBarRightLeading={isMobile ? null : <VoiceSessionPillHost />}
          topBarRightSlot={
            <>
              {topBarRightSlot}
              {topBarAccessory}
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
        <>
          <main
            className={`relative flex min-w-0 flex-1 min-h-0 flex-col overflow-hidden ${mainRoomClass}`}
          >
            {chatContent}
            {/* A popout narrowed below the mobile breakpoint lands in this
                branch, still headerless, so it still needs the floating
                session surface (see the desktop popout branch below). */}
            {isPopout ? <VoiceSessionPillHost variant="standalone" /> : null}
          </main>
          {/* The drawer is a sibling of `<main>`, not a child of it, even
              though it is the chat body's own navigation. `mainRoomClass`
              puts a `filter` + `opacity` on `<main>` while the voice room is
              up, and both make it a stacking context AND (for the filter) the
              containing block for `position: fixed` descendants. Nested,
              the drawer would come up blurred at 40% opacity, offset to
              `<main>`'s box instead of the viewport, and sealed below the
              room by its parent's tier: the menu button read as dead. Out
              here its z-40 sorts against the room directly. */}
          {drawerGestures.present ? (
            <div
              ref={drawerRef}
              className="fixed inset-0"
              style={{
                zIndex: 40,
                // The close drag rides on the open resting transform, so the
                // panel tracks the finger from where it sits. Releasing short
                // returns it here under the standard transition; releasing past
                // the threshold flips `drawerOpen`, and the same transition
                // carries it the rest of the way out while the panel stays
                // mounted for the slide.
                transform: drawerOpen
                  ? `translateX(${drawerGestures.dragOffset}px)`
                  : "translateX(-100%)",
                transition: drawerGestures.isDragging
                  ? "none"
                  : `transform ${EDGE_SWIPE_SLIDE_MS}ms ${EDGE_SWIPE_EASING}`,
                // Vertical panning stays native for the menu's scrollport while
                // the horizontal axis belongs to this gesture.
                touchAction: "pan-y",
                // A panel on its way out still covers the viewport for the
                // length of the slide. Let taps through to the page it is
                // uncovering rather than swallowing them.
                pointerEvents: drawerGestures.exiting ? "none" : undefined,
              }}
              onTouchStart={drawerGestures.onTouchStart}
              onTouchMove={drawerGestures.onTouchMove}
              onTouchEnd={drawerGestures.onTouchEnd}
              onTouchCancel={drawerGestures.onTouchCancel}
              role="dialog"
              aria-modal="true"
              aria-label={t("chatLayout.navigationAria")}
              data-state={drawerOpen ? "open" : "closed"}
            >
              {/* The aside is the drawer's only painted surface: the menu it
                  hosts is transparent, so this one fill covers both the menu
                  and the safe-area padding ring around it, which is what
                  keeps tinted strips off the notch / home-indicator edges on
                  iOS. The fill is fully opaque (Figma 7842-83305), so the
                  chat never bleeds through the sheet. Painting it here
                  rather than on the menu keeps one owner of the surface
                  color; a second fill on the menu would composite over this
                  one and shift the drawn color off its token. No border:
                  the sheet covers the full screen, so there is no edge to draw.
                  No bottom padding either: the SideMenu root clips its
                  children (`overflow-hidden`), so a bottom inset places the
                  clip boundary at the home-indicator line and guillotines
                  the floating action pills' drop shadows into a visible
                  hard edge in light mode. The menu runs full-bleed to the
                  physical bottom edge and the pills offset themselves by
                  the safe-area inset instead. */}
              <aside
                id="chat-side-menu"
                className="relative flex h-full w-full flex-col shadow-xl"
                style={{
                  background: DRAWER_SURFACE_BACKGROUND,
                  zIndex: 50,
                  paddingTop:
                    "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))",
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
        </>
      ) : isPopout ? (
        <main
          className={`relative flex min-w-0 flex-1 min-h-0 flex-col overflow-hidden p-4 ${mainRoomClass}`}
        >
          {chatContent}
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
            ref={setSideMenuAside}
            // No width of its own: the wrapper shrink-wraps the SideMenu
            // nav, which owns the rail width (drag-resize mutates it outside
            // React until pointer-up). The tour's slide-away effect animates
            // this element imperatively; overflow-hidden clips the nav
            // mid-slide.
            className="w-fit shrink-0 overflow-hidden"
            aria-label={t("chatLayout.navigationAria")}
          >
            {renderSideMenu({
              collapsed: effectiveCollapsed,
              variant: "rail",
              width: sidebarWidth,
              onWidthChange: handleSidebarWidthChange,
            })}
          </aside>
          <main
            className={`relative flex min-w-0 flex-1 min-h-0 flex-col overflow-hidden ${mainRoomClass}`}
          >
            {chatContent}
            {/* Live-voice room, desktop: an inset panel scoped to the content
                area, so the title bar above and the sidenav beside it stay
                visible and interactive. Self-gates on
                `useIsVoiceRoomVisible()`; the composer's voice bar and
                transcript render underneath, hidden by it. */}
            <VoiceRoom variant="content" />
          </main>
        </div>
      )}

      {/* Focused research-onboarding results — a full-viewport layer ON TOP of
          the normal layout (not a separate render branch), so `ActiveChatView`
          stays continuously mounted. Toggling focus only adds/removes this
          overlay; it never remounts the chat, so a suggestion click's
          navigate + `?prompt=` auto-send isn't raced by a remount. */}
      {isFocused ? <ResearchResultsOverlay /> : null}
      {/* Live-voice room, mobile: a bottom sheet that slides up and rests below
          the thread header, the mobile counterpart of the desktop inset panel.
          It portals out of the layout, so it mounts here rather than inside
          `<main>`. The desktop room is the inset panel mounted inside `<main>`
          above; the two mounts are mutually exclusive, so the room never
          double-mounts. */}
      {isMobile ? <VoiceRoom variant="sheet" /> : null}
      {/* First step of the focused flow: the gcal "Let's chat tomorrow" page,
          shown over the streaming research output until connect/skip. Self-gates
          on `checkinPending`; top-level so it can compose the onboarding screen. */}
      <OnboardingCheckinOverlay />
      {/* Applies the research-onboarding picker's avatar once the assistant is
          hatched (avatar isn't part of the pre-chat handoff context). */}
      <OnboardingAvatarApplier />

      <RenameDialogFromStore assistantId={assistantId} />
      <ArchiveAllConfirmDialog
        pending={pendingArchiveAll}
        onConfirm={confirmArchiveAll}
        onCancel={cancelArchiveAll}
      />
      <DeleteConversationConfirmDialog
        pending={pendingDeleteConversation}
        onConfirm={confirmDelete}
        onCancel={cancelDelete}
      />
      <GroupNameDialogFromStore
        createGroup={createGroup}
        renameGroup={renameGroup}
        moveToGroup={handleMoveToGroup}
      />
      {commandPalette.isOpen || paletteEverOpened ? (
        <LazyBoundary>
          <CommandPalette
            isOpen={commandPalette.isOpen}
            onClose={commandPalette.close}
            query={commandPalette.query}
            onQueryChange={commandPalette.setQuery}
            highlightTokens={commandPalette.searchTokens}
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
