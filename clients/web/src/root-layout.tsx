import { lazy, useEffect, useRef, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router";

import { LazyBoundary } from "@/components/lazy-boundary";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useEventBusInit } from "@/hooks/use-event-bus-init";
import { useOpenUrlDirectives } from "@/hooks/use-open-url-directives";
import { useGuardianRepairRoute } from "@/hooks/use-guardian-repair-route";
import { useGlobalDeepLinkConsumer } from "@/hooks/use-global-deep-link-consumer";
import { useKeyboardOpen } from "@/hooks/use-keyboard-open";
import { useVisibleViewport } from "@/hooks/use-visible-viewport";
import { useAssistantLifecycle } from "@/assistant/use-lifecycle";
import { useAssistantLifecycleStore } from "@/assistant/lifecycle-store";
import { useChannelSetupCloseNotify } from "@/domains/chat/hooks/use-channel-setup-close-notify";
import {
  endLiveVoiceSession,
  isLiveVoiceSessionActive,
  useLiveVoiceStore,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import { startVoiceFromSurface } from "@/domains/chat/voice/live-voice/start-voice-request";
import {
  clearWatchRetro,
  useWatchRetroStore,
} from "@/domains/chat/watch/watch-retro";
import {
  useAuthStore,
  useIsSessionInitializing,
  useHasPlatformSession,
} from "@/stores/auth-store";
import { handleLogout } from "@/lib/auth/handle-logout";
import {
  getLockfileAssistant,
  getSelectedAssistant,
  isLocalClient,
} from "@/lib/local-mode";
import { useOnboardingLogin } from "@/hooks/use-onboarding-login";
import { setMenuPlatformSession } from "@/runtime/menu";
import { useVellumCommands } from "@/runtime/vellum-commands";
import { handleToggleWatchCommand } from "@/runtime/watch-command";

import { navigateToConversation } from "@/utils/conversation-navigation";
import { routes } from "@/utils/routes";
import { shouldSuppressRootStatusBanner } from "@/utils/status-banner-visibility";
import { useAssistantIdentityInit } from "@/hooks/use-assistant-identity-init";
import { useAssistantResourceSync } from "@/hooks/use-assistant-resource-sync";
import { useDocumentEditorSync } from "@/hooks/use-document-editor-sync";
import { useBookmarksSync } from "@/hooks/use-bookmarks-sync";
import { useNotificationIntentSync } from "@/hooks/use-notification-intent-sync";
import { useWatchRetroSync } from "@/hooks/use-watch-retro-sync";
import { useNotificationTapNavigation } from "@/hooks/use-notification-tap-navigation";
import { usePushRegistration } from "@/hooks/use-push-registration";
import { useWebPresenceReport } from "@/hooks/use-web-presence-report";
import { useSoundEffects } from "@/hooks/use-sound-effects";
import { useOnboardingWindowSize } from "@/hooks/use-onboarding-window-size";
import { useConversationSync } from "@/hooks/use-conversation-sync";
import { useFeatureFlagBusSync } from "@/hooks/use-feature-flag-bus-sync";
import { useWorkspaceTheme } from "@/hooks/use-workspace-theme";
import { useClientFeatureFlagSync } from "@/hooks/use-client-feature-flag-sync";
import { useAssistantFeatureFlagSync } from "@/hooks/use-assistant-feature-flag-sync";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { useConversationStore } from "@/stores/conversation-store";
import { createDraftConversationId } from "@/domains/chat/utils/conversation-selection";
import { useViewerStore } from "@/stores/viewer-store";
import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";
import { useAvatarAccentVar } from "@/hooks/use-avatar-accent-var";
import { useDynamicFavicon } from "@/hooks/use-dynamic-favicon";
import { useCompanionMirror } from "@/domains/chat/hooks/use-companion-mirror";
import { useElectronIconSync } from "@/hooks/use-electron-icon-sync";
import { useIslandAvatarSource } from "@/hooks/use-island-avatar-source";
import { useElectronIdentitySync } from "@/hooks/use-electron-identity-sync";
import { useLockfileIdentitySync } from "@/hooks/use-lockfile-identity-sync";
import { useElectronStatusSync } from "@/hooks/use-electron-status-sync";
import { useElectronFeatureFlagBridge } from "@/runtime/electron-feature-flags";
import { subscribeAndroidBackButtonSource } from "@/runtime/event-sources/android-back-button";
import { isElectron } from "@/runtime/is-electron";
import { isNativeMobile } from "@/runtime/platform-detection";
import {
  resolveShellBackground,
  resolveShellTransition,
  usePageSurfaceStore,
} from "@/stores/page-surface-store";
import { isPopoutWindow } from "@/runtime/popout-window";
import { GlobalPushToTalkBridge } from "@/domains/chat/voice/global-push-to-talk-bridge";
import { TimezoneSync } from "@/components/timezone-sync";
import { StatusBanner } from "@/components/status-banner";
import { UpdateToast } from "@/components/update-toast";
import { retireAssistant } from "@/assistant/retire-service";
import {
  removePairedAssistant,
  switchToAssistant,
} from "@/assistant/switch-service";
import { CreateAssistantDialog } from "@/components/create-assistant-dialog";
import { RemoveFromDeviceDialog } from "@/components/remove-from-device-dialog";
import { RetireConfirmDialog } from "@/components/retire-confirm-dialog";
import { toast } from "@vellumai/design-library/components/toast";

const ShareFeedbackModal = lazy(() =>
  import("@/components/share-feedback-modal").then((m) => ({
    default: m.ShareFeedbackModal,
  })),
);

/**
 * App-level layout route. Owns four cross-route concerns:
 *
 * 1. Safe-area insets and iOS visual-viewport keyboard tracking.
 * 2. The single assistant lifecycle (`useAssistantLifecycle`). Mounted
 *    here as a side effect — the hook publishes `assistantState` and
 *    stable imperative callbacks into `useAssistantLifecycleStore`,
 *    and the active assistant id into `useResolvedAssistantsStore`.
 *    Mounting once at the app root means every layout / route can
 *    read the current assistant via store selectors without each
 *    running a duplicate polling state machine.
 * 3. The event-bus owner (`useEventBusInit`). Bus producers (SSE
 *    connection, visibility / online / offline listeners, Capacitor
 *    app-state) need to be alive on every authenticated route — not
 *    just chat — so cross-tab sync invalidations keep firing while the
 *    user is on settings, logs, etc.
 * 4. Android system Back routing. The active UI layer gets first refusal,
 *    followed by WebView history and app minimization at the root.
 *
 * References:
 * - React Router layout routes: https://reactrouter.com/start/data/routing
 * - env() safe-area-inset: https://developer.mozilla.org/en-US/docs/Web/CSS/env
 * - Visual Viewport API: https://developer.mozilla.org/en-US/docs/Web/API/Visual_Viewport_API
 */
export function RootLayout() {
  useAppTheme();
  const keyboardOpen = useKeyboardOpen();
  const visibleViewport = useVisibleViewport();

  const location = useLocation();
  const navigate = useNavigate();
  const sessionStatus = useAuthStore.use.sessionStatus();
  const isSessionInitializing = useIsSessionInitializing();
  const hasPlatformSession = useHasPlatformSession();
  // Publish platform-session state to the Electron app menu from this
  // always-mounted layer so the menu's Log In/Log Out toggle stays correct
  // on non-chat routes (e.g. Settings) where ChatLayout isn't mounted.
  useEffect(() => {
    void setMenuPlatformSession(hasPlatformSession);
  }, [hasPlatformSession]);
  useAssistantLifecycle({
    sessionStatus,
    hasPlatformSession,
  });
  useGuardianRepairRoute();
  // Channel-setup close auto-notify watcher. Mounted at this always-mounted
  // layer (not the chat layout) so a wizard-visibility transition triggered
  // from any route — including setMainView("chat") calls made while the chat
  // layout is unmounted — still sends the close signal.
  useChannelSetupCloseNotify();

  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const assistantVersion = useAssistantIdentityStore.use.version();
  const activeConversationId = useConversationStore.use.activeConversationId();
  const assistantStateKind = useAssistantLifecycleStore(
    (s) => s.assistantState.kind,
  );
  const isAssistantActive = assistantStateKind === "active";
  useClientFeatureFlagSync(!isSessionInitializing, isAssistantActive);
  // Hydrate the assistant identity store (name + version) at the app root so
  // the name is ready on every authenticated route — chat, settings, logs —
  // and the Electron window title / tray / About panel (published below by
  // useElectronIdentitySync) track it everywhere, not only on chat routes.
  // No-ops until an assistant id resolves in a fetchable lifecycle state.
  useAssistantIdentityInit({ assistantId, assistantStateKind });
  useAssistantFeatureFlagSync(assistantId);
  useAssistantResourceSync(assistantId, isAssistantActive);
  useConversationSync(assistantId, isAssistantActive);
  useFeatureFlagBusSync(assistantId, isAssistantActive);
  useWorkspaceTheme(assistantId, isAssistantActive);
  useNotificationIntentSync(assistantId);
  useWebPresenceReport(assistantId);
  usePushRegistration(assistantId);
  useNotificationTapNavigation();
  useSoundEffects(assistantId, isAssistantActive);
  useDocumentEditorSync();
  useBookmarksSync();
  // The end of a watch session's summary, which arrives on the assistant's
  // event stream because the session's own socket is gone by the time the
  // retrospective runs. Mounted here rather than in the chat layout: the
  // announcement names a background conversation, and the user is by definition
  // working somewhere else when a session ends.
  useWatchRetroSync();

  // Keep the browser favicon in sync with the assistant's avatar across
  // every authenticated route (chat, settings, logs, etc.). Mounted here
  // so the favicon persists when navigating between sibling layouts.
  const avatar = useAssistantAvatar(assistantId);
  useDynamicFavicon(avatar.customImageUrl, avatar.components, avatar.traits);
  // Publish the avatar accent as `--avatar-accent` so chat loading shimmers
  // (and any future accent-tinted UI) can read it from plain CSS.
  useAvatarAccentVar(avatar.components, avatar.traits, avatar.customImageUrl);
  // Publish the same avatar for the iOS Live Activity, which cannot fetch an
  // image at render time and needs the bytes to travel with the activity.
  useIslandAvatarSource(
    avatar.customImageUrl,
    avatar.components,
    avatar.traits,
  );

  // Feed the same avatar to the Electron Dock + menu-bar icons, and publish
  // the live connection status to the menu-bar dot. Both no-op off Electron.
  useElectronIconSync(avatar.customImageUrl, avatar.components, avatar.traits);
  useElectronStatusSync();
  useElectronIdentitySync();
  useLockfileIdentitySync();
  useElectronFeatureFlagBridge();

  // Size the Electron main window to the onboarding layout (440×630
  // default) while on an onboarding step, and back to the main-app size
  // elsewhere. No-op off Electron. Mounted at the app root so it tracks
  // navigation across the whole onboarding flow.
  useOnboardingWindowSize();

  useEventBusInit({ assistantId, isAssistantActive });
  useEffect(() => subscribeAndroidBackButtonSource(), []);
  // Inbound deep-link navigation + window activation. Mounted here
  // (not in `ChatPage`) so a `vellum://thread/...` arriving while
  // the user is on `/assistant/settings`, `/logs`, etc. still
  // navigates. The composer-pre-fill half lives in `ChatPage`'s
  // `useDeepLinkConsumer` because it owns `setInput`; the two
  // hand off via `pending-deep-link-store`.
  useGlobalDeepLinkConsumer();
  // Conversationless `open_url` directives (CLI OAuth hand-offs). Mounted
  // here so the browser opens even when no chat stream consumer exists —
  // Settings/Logs routes, or a draft conversation that isn't persisted yet.
  useOpenUrlDirectives();
  // The assistant's name and the tail of the open conversation, mirrored onto
  // the macOS companion surface so a message sent from its composer can be
  // answered there. Mounted here rather than in the chat layout because the
  // surface is on screen for as long as the app is, including on routes with no
  // transcript rendered.
  useCompanionMirror();

  const [feedbackOpen, setFeedbackOpen] = useState(false);
  // Id of the assistant a tray "Retire <assistant>…" command targets. The tray
  // dispatches by id; the destructive confirmation lives here in the layout so
  // the retire can run without first routing the user to settings.
  const [retireId, setRetireId] = useState<string | null>(null);
  const [retirePending, setRetirePending] = useState(false);
  // Id of the paired assistant a tray "Remove from this Mac…" command targets.
  const [removePairedId, setRemovePairedId] = useState<string | null>(null);
  const [removePairedPending, setRemovePairedPending] = useState(false);
  // Whether the tray "New Assistant…" name-prompt dialog is open.
  const [createOpen, setCreateOpen] = useState(false);
  // The conversation the companion surface's open composer is talking to,
  // minted by its first message. Held here because the surface never learns the
  // id: it says only whether it is starting or continuing, and this is the side
  // that mints one.
  const companionConversationRef = useRef<string | null>(null);

  const { login } = useOnboardingLogin();

  useVellumCommands({
    openSettings: () => {
      void navigate(routes.settings.root);
    },
    login: () => {
      void login();
    },
    logout: () => {
      void handleLogout(navigate);
    },
    rePair: () => {
      const id = getSelectedAssistant()?.assistantId;
      if (id) {
        // connectLocalAssistant rethrows (e.g. GuardianTokenError) so callers
        // can offer recovery; route to the chooser, whose connect path owns
        // the recovery dialog, instead of dead-ending on a silent rejection.
        useAuthStore
          .getState()
          .connectLocalAssistant(id)
          .catch((err: unknown) => {
            console.error("rePair.connectLocalAssistant failed", err);
            toast.error("Failed to connect to the assistant.");
            void navigate(routes.selectAssistant);
          });
      }
    },
    shareFeedback: () => setFeedbackOpen(true),
    selectAssistant: (command) => {
      if (command.kind === "selectAssistant") {
        // Paired-aware switch: paired entries connect through
        // connectPairedAssistant, managed ones through the platform
        // selection path (see switch-service).
        void switchToAssistant(command.assistantId).then((outcome) => {
          if (!outcome.ok) {
            toast.error(outcome.error);
            void navigate(routes.selectAssistant);
          }
        });
      }
    },
    chooseAssistant: () => {
      // The chooser route is local-only — navigation-resolver redirects
      // platform users away — so platform sessions switch via the Switch
      // Assistant picker on the settings page instead.
      if (isLocalClient()) {
        void navigate(`${routes.selectAssistant}?noAutoSkip=1`);
      } else {
        void navigate(routes.settings.general);
      }
    },
    createAssistant: () => {
      setCreateOpen(true);
    },
    retireAssistant: (command) => {
      if (command.kind === "retireAssistant") {
        setRetireId(command.assistantId);
      }
    },
    removePairedAssistant: (command) => {
      if (command.kind === "removePairedAssistant") {
        setRemovePairedId(command.assistantId);
      }
    },
    quickInputSubmit: (command) => {
      if (command.kind !== "quickInputSubmit") {
        return;
      }
      const draftId = createDraftConversationId();
      useConversationStore.getState().setActiveConversationId(draftId);
      useViewerStore.getState().setMainView("chat");
      void navigate(
        `${routes.conversation(draftId)}?prompt=${encodeURIComponent(command.message)}`,
      );
    },
    startVoice: () => {
      // See `startVoiceFromSurface` for the three steps and why the window
      // stays where it is.
      startVoiceFromSurface(navigate);
    },
    toggleVoice: () => {
      // The global Talk shortcut. Starting is Talk's own behaviour; ending is
      // the part a key needs and a button does not, since the surface drawing
      // the button also draws a way to stop and a keyboard user working in
      // another app may have nothing else in reach.
      if (isLiveVoiceSessionActive(useLiveVoiceStore.getState().state)) {
        endLiveVoiceSession();
        return;
      }
      startVoiceFromSurface(navigate);
    },
    answerWatchRetro: (command) => {
      if (command.kind !== "answerWatchRetro") {
        return;
      }
      // Read before the state is cleared, since clearing is what takes the
      // conversation with it.
      const retro = useWatchRetroStore.getState().retro;
      clearWatchRetro();
      // **A yes is only honoured on a summary that is actually ready.** The
      // surface draws the two answers only in that state, but a press can
      // outlive it: the give-up timer and a fresh session both clear the
      // question, and navigating to a conversation the runtime never reported a
      // report in would open an empty thread.
      if (!command.open || retro?.phase !== "ready") {
        return;
      }
      // **And only on the assistant that wrote it.** Switching away clears the
      // question (`watch/watch-retro.ts` binds it to its owner), so this should
      // never be false; it is checked anyway because the failure it prevents is
      // silent. Every request this app makes is scoped to the active assistant,
      // so opening another assistant's conversation id lands on a thread that
      // does not exist rather than on the report.
      if (
        retro.assistantId !==
        useResolvedAssistantsStore.getState().activeAssistantId
      ) {
        return;
      }
      // The full navigation rather than a bare route push. The report is a
      // conversation like any other, and arriving at it with the previous
      // thread's subagent and workflow state still standing is what
      // `navigateToConversation` exists to prevent.
      navigateToConversation(navigate, retro.conversationId);
    },
    // The flag gate and the toggle both live in `watch-command.ts`. This is the
    // one command registered here that can start reading the user's screen, so
    // its refusal is worth being able to test, and a module is what makes that
    // possible. It takes no arguments, which the handler signature allows.
    toggleWatch: handleToggleWatchCommand,
    companionSubmit: (command) => {
      if (command.kind !== "companionSubmit") {
        return;
      }
      // **The surface's own thread.** Opening its composer starts a
      // conversation rather than sending into whatever the app has selected:
      // the user reached past the app to a floating avatar, so they are
      // starting something, not adding to a thread they cannot see. Every
      // follow-up continues that one.
      //
      // Which is the remembered id, not the active conversation, because the
      // two come apart: pressing the avatar brings the app forward with the
      // card still open, and picking a different thread there leaves the app's
      // selection somewhere the card's conversation is not. A follow-up
      // resolved against the selection would land in the thread the user
      // happened to open rather than the one they were typing to.
      //
      // The fallback covers the composer outliving this window's memory of it,
      // which a reload does: the active conversation is the best guess left.
      const conversations = useConversationStore.getState();
      const conversationId = command.startsConversation
        ? createDraftConversationId()
        : (companionConversationRef.current ??
          conversations.activeConversationId ??
          createDraftConversationId());
      companionConversationRef.current = conversationId;
      conversations.setActiveConversationId(conversationId);
      // The `?prompt=` auto-send pathway (`use-auto-send-effects`), with a
      // relay token so sending the same words twice sends twice instead of
      // deduping to one. Navigating is also what mounts the chat layout the
      // send needs, which is why this routes rather than calling a sender.
      //
      // The layout is left alone and the window is deliberately not raised,
      // as with `startVoice`: this command comes from a surface the user
      // reached for precisely because they are working somewhere else.
      void navigate(
        routes.conversationWithPrompt(
          conversationId,
          command.message,
          crypto.randomUUID(),
        ),
      );
    },
    replayOnboarding: () => {
      void navigate(`${routes.onboarding.privacy}?preview=true`);
    },
    replayHatchFailure: () => {
      void navigate(`${routes.onboarding.hatching}?preview=true&fail=1`);
    },
  });

  const handleConfirmRemovePaired = async () => {
    if (!removePairedId) {
      return;
    }
    setRemovePairedPending(true);
    const outcome = await removePairedAssistant(removePairedId);
    setRemovePairedPending(false);
    setRemovePairedId(null);
    if (!outcome.ok) {
      toast.error(outcome.error);
      return;
    }
    if (outcome.nextRoute) {
      void navigate(outcome.nextRoute, { replace: true });
    }
  };

  const handleConfirmRetire = async () => {
    if (!retireId) {
      return;
    }
    setRetirePending(true);
    const outcome = await retireAssistant(retireId);
    if (outcome.ok) {
      setRetireId(null);
      setRetirePending(false);
      navigate(outcome.nextRoute, { replace: true });
      return;
    }
    toast.error(outcome.error);
    setRetirePending(false);
    setRetireId(null);
  };

  // When the iOS keyboard opens, the system scrolls the layout viewport
  // down by `offsetTop` to keep the focused input visible. Size the outer
  // container to `height + offsetTop` and add matching `paddingTop` so the
  // content area stays exactly `visualViewport.height` (border-box) while
  // the container's background fills the entire visible region. This
  // replaces the previous `translate3d(0, offsetTop, 0)` approach which
  // positioned the content correctly but left the bottom `offsetTop` pixels
  // outside the container's background, exposing the body's default
  // background as a visible gap above the keyboard.
  const keyboardOffsetTop =
    keyboardOpen && visibleViewport ? visibleViewport.offsetTop : 0;
  const electron = isElectron();
  const isPopout = isPopoutWindow(location.search);
  const suppressStatusBanner = shouldSuppressRootStatusBanner(
    location.pathname,
    location.search,
  );
  // The app shell owns the top safe-area inset for the primary web/mobile
  // surface: whatever renders topmost — the status banner when present, else
  // the active route's own header — sits directly below the notch. Electron,
  // popouts, and onboarding manage their own top inset, so the shell defers to
  // them. This keeps a single owner of the top inset per context and avoids
  // the banner and a route header both reserving it (a doubled gap).
  const appShellOwnsTopInset = !electron && !isPopout && !suppressStatusBanner;
  // The notch inset and the keyboard scroll compensation are independent top
  // offsets: the status bar is always present regardless of the keyboard, so
  // when the shell owns the inset it must be reserved in both states and
  // stacked on top of the keyboard offset when the keyboard is open.
  const topSafeAreaInset =
    "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))";
  // This element owns the safe-area padding, so its background is what fills
  // the strips beside the notch and the home indicator. A route that renders on
  // a themed surface can publish that color and have it run edge to edge rather
  // than stopping at its content's rounded corner. Native mobile only: on
  // desktop the neutral canvas is what makes a page read as a card on a page.
  const pageSurface = usePageSurfaceStore.use.surface();
  const shellBackground = resolveShellBackground(pageSurface, isNativeMobile());
  // A page whose canvas animates hands over its timing too, so the strips move
  // with it instead of snapping to the destination color a second early.
  const pageSurfaceTransition = usePageSurfaceStore.use.transition();
  const shellTransition = resolveShellTransition(
    pageSurfaceTransition,
    isNativeMobile(),
  );
  const shellPaddingTop =
    keyboardOffsetTop > 0
      ? appShellOwnsTopInset
        ? `calc(${keyboardOffsetTop}px + ${topSafeAreaInset})`
        : `${keyboardOffsetTop}px`
      : appShellOwnsTopInset
        ? topSafeAreaInset
        : undefined;

  return (
    <div
      data-slot="root-layout"
      className="app-shell"
      style={{
        background: shellBackground,
        transition: shellTransition,
        height:
          keyboardOpen && visibleViewport
            ? `${visibleViewport.height + keyboardOffsetTop}px`
            : "100dvh",
        paddingTop: shellPaddingTop,
        paddingBottom: keyboardOpen
          ? "0px"
          : "var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))",
        paddingLeft:
          "var(--safe-area-inset-left, env(safe-area-inset-left, 0px))",
        paddingRight:
          "var(--safe-area-inset-right, env(safe-area-inset-right, 0px))",
        isolation: "isolate",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <UpdateToast />
      {appShellOwnsTopInset ? <StatusBanner placement="web" /> : null}
      <div
        className="flex min-w-0 flex-col overflow-hidden w-full"
        style={{ flex: "1 1 0%", minHeight: 0 }}
      >
        <Outlet />
      </div>

      {/* Portal target for mobile overlays that use `position: fixed`. */}
      <div id="viewport-overlays" />

      {/* Headless: keeps daemon config.ui.detectedTimezone fresh on
          focus/zone change. No-ops until an assistant id resolves. */}
      <TimezoneSync />
      <GlobalPushToTalkBridge assistantId={assistantId} />

      {feedbackOpen ? (
        <LazyBoundary>
          <ShareFeedbackModal
            open={feedbackOpen}
            onClose={() => setFeedbackOpen(false)}
            assistantId={assistantId}
            assistantVersion={assistantVersion}
            activeConversationId={activeConversationId}
          />
        </LazyBoundary>
      ) : null}

      {/* Destructive confirmation for the tray "Retire <assistant>…" command.
          Mirrors the settings RetireAssistant dialog so a retire triggered from
          the menu bar carries the same irreversible-action warning. */}
      <RetireConfirmDialog
        open={retireId !== null}
        isPending={retirePending}
        onConfirm={handleConfirmRetire}
        onCancel={() => setRetireId(null)}
      />

      {/* Confirmation for the tray "Remove from this Mac…" command. Shares
          the chooser's remove dialog: forgetting the pairing on this device
          never touches the assistant on its host machine. */}
      <RemoveFromDeviceDialog
        open={removePairedId !== null}
        kind="paired"
        assistantName={
          (removePairedId && getLockfileAssistant(removePairedId)?.name) ||
          "the assistant"
        }
        isPending={removePairedPending}
        onConfirm={() => void handleConfirmRemovePaired()}
        onCancel={() => setRemovePairedId(null)}
      />

      {/* Name-prompt for the tray "New Assistant…" command — hatches an
          additional managed assistant and switches to it. */}
      <CreateAssistantDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
      />
    </div>
  );
}
