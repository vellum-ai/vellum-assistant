import { lazy, useEffect, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router";

import { LazyBoundary } from "@/components/lazy-boundary";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useEventBusInit } from "@/hooks/use-event-bus-init";
import { useGlobalDeepLinkConsumer } from "@/hooks/use-global-deep-link-consumer";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useVisibleViewport } from "@/hooks/use-visible-viewport";
import { useAssistantLifecycle } from "@/assistant/use-lifecycle";
import { useAssistantLifecycleStore } from "@/assistant/lifecycle-store";
import {
  useAuthStore,
  useIsSessionInitializing,
  useHasPlatformSession,
} from "@/stores/auth-store";
import { handleLogout } from "@/lib/auth/handle-logout";
import { getSelectedAssistant, isLocalMode } from "@/lib/local-mode";
import { useOnboardingLogin } from "@/hooks/use-onboarding-login";
import { setMenuPlatformSession } from "@/runtime/menu";
import { useVellumCommands } from "@/runtime/vellum-commands";

import { routes } from "@/utils/routes";
import { shouldSuppressRootStatusBanner } from "@/utils/status-banner-visibility";
import { useAssistantIdentityInit } from "@/hooks/use-assistant-identity-init";
import { useAssistantResourceSync } from "@/hooks/use-assistant-resource-sync";
import { useDocumentEditorSync } from "@/hooks/use-document-editor-sync";
import { useBookmarksSync } from "@/hooks/use-bookmarks-sync";
import { useNotificationIntentSync } from "@/hooks/use-notification-intent-sync";
import { usePushRegistration } from "@/hooks/use-push-registration";
import { useSoundEffects } from "@/hooks/use-sound-effects";
import { useOnboardingWindowSize } from "@/hooks/use-onboarding-window-size";
import { useConversationSync } from "@/hooks/use-conversation-sync";
import { useFeatureFlagBusSync } from "@/hooks/use-feature-flag-bus-sync";
import { useClientFeatureFlagSync } from "@/hooks/use-client-feature-flag-sync";
import { useAssistantFeatureFlagSync } from "@/hooks/use-assistant-feature-flag-sync";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { useConversationStore } from "@/stores/conversation-store";
import { createDraftConversationId } from "@/domains/chat/utils/conversation-selection";
import { useViewerStore } from "@/stores/viewer-store";
import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";
import { useDynamicFavicon } from "@/hooks/use-dynamic-favicon";
import { useElectronIconSync } from "@/hooks/use-electron-icon-sync";
import { useElectronIdentitySync } from "@/hooks/use-electron-identity-sync";
import { useElectronStatusSync } from "@/hooks/use-electron-status-sync";
import { useElectronFeatureFlagBridge } from "@/runtime/electron-feature-flags";
import { isElectron } from "@/runtime/is-electron";
import { GlobalPushToTalkBridge } from "@/domains/chat/voice/global-push-to-talk-bridge";
import { TimezoneSync } from "@/components/timezone-sync";
import { StatusBanner } from "@/components/status-banner";
import { UpdateToast } from "@/components/update-toast";
import { retireAssistant } from "@/assistant/retire-service";
import { setSelectedAssistant } from "@/assistant/selection";
import { CreateAssistantDialog } from "@/components/create-assistant-dialog";
import { RetireConfirmDialog } from "@/components/retire-confirm-dialog";
import { toast } from "@vellumai/design-library/components/toast";

const ShareFeedbackModal = lazy(() =>
  import("@/components/share-feedback-modal").then((m) => ({
    default: m.ShareFeedbackModal,
  })),
);

/**
 * Threshold (in px) below which a `innerHeight − visualViewport.height` delta
 * is treated as the soft keyboard opening. Below this we assume incidental
 * drift from browser chrome / pinch-zoom and leave the layout alone.
 */
const KEYBOARD_OPEN_THRESHOLD_PX = 100;

/**
 * App-level layout route. Owns three cross-route concerns:
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
 *
 * References:
 * - React Router layout routes: https://reactrouter.com/start/data/routing
 * - env() safe-area-inset: https://developer.mozilla.org/en-US/docs/Web/CSS/env
 * - Visual Viewport API: https://developer.mozilla.org/en-US/docs/Web/API/Visual_Viewport_API
 */
export function RootLayout() {
  useAppTheme();
  const isMobile = useIsMobile();
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
  useClientFeatureFlagSync(!isSessionInitializing);
  useAssistantLifecycle({
    sessionStatus,
    hasPlatformSession,
  });

  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const assistantVersion = useAssistantIdentityStore.use.version();
  const activeConversationId = useConversationStore.use.activeConversationId();
  const assistantStateKind = useAssistantLifecycleStore(
    (s) => s.assistantState.kind,
  );
  const isAssistantActive = assistantStateKind === "active";
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
  useNotificationIntentSync(assistantId);
  usePushRegistration(assistantId);
  useSoundEffects(assistantId, isAssistantActive);
  useDocumentEditorSync();
  useBookmarksSync();

  // Keep the browser favicon in sync with the assistant's avatar across
  // every authenticated route (chat, settings, logs, etc.). Mounted here
  // so the favicon persists when navigating between sibling layouts.
  const avatar = useAssistantAvatar(assistantId);
  useDynamicFavicon(avatar.customImageUrl, avatar.components, avatar.traits);

  // Feed the same avatar to the Electron Dock + menu-bar icons, and publish
  // the live connection status to the menu-bar dot. Both no-op off Electron.
  useElectronIconSync(avatar.customImageUrl, avatar.components, avatar.traits);
  useElectronStatusSync();
  useElectronIdentitySync();
  useElectronFeatureFlagBridge();

  // Size the Electron main window to the onboarding layout (440×630
  // default) while on an onboarding step, and back to the main-app size
  // elsewhere. No-op off Electron. Mounted at the app root so it tracks
  // navigation across the whole onboarding flow.
  useOnboardingWindowSize();

  useEventBusInit({ assistantId, isAssistantActive });
  // Inbound deep-link navigation + window activation. Mounted here
  // (not in `ChatPage`) so a `vellum://thread/...` arriving while
  // the user is on `/assistant/settings`, `/logs`, etc. still
  // navigates. The composer-pre-fill half lives in `ChatPage`'s
  // `useDeepLinkConsumer` because it owns `setInput`; the two
  // hand off via `pending-deep-link-store`.
  useGlobalDeepLinkConsumer();

  const [feedbackOpen, setFeedbackOpen] = useState(false);
  // Id of the assistant a tray "Retire <assistant>…" command targets. The tray
  // dispatches by id; the destructive confirmation lives here in the layout so
  // the retire can run without first routing the user to settings.
  const [retireId, setRetireId] = useState<string | null>(null);
  const [retirePending, setRetirePending] = useState(false);
  // Whether the tray "New Assistant…" name-prompt dialog is open.
  const [createOpen, setCreateOpen] = useState(false);

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
        // The tray lists managed (platform-hosted) assistants, so switching
        // goes through the platform selection path — not connectLocalAssistant,
        // which primes a local gateway and no-ops for managed assistants.
        void setSelectedAssistant(command.assistantId);
      }
    },
    chooseAssistant: () => {
      // The chooser route is local-only — navigation-resolver redirects
      // platform users away — so platform sessions switch via the Switch
      // Assistant picker on the settings page instead.
      if (isLocalMode()) {
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
    replayOnboarding: () => {
      void navigate(`${routes.onboarding.privacy}?preview=true`);
    },
    previewPrechat: () => {
      void navigate(`${routes.onboarding.prechat}?preview=true`);
    },
    replayHatchFailure: () => {
      void navigate(`${routes.onboarding.hatching}?preview=true&fail=1`);
    },
  });

  const handleConfirmRetire = async () => {
    if (!retireId) return;
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

  const keyboardOpen =
    isMobile &&
    visibleViewport !== null &&
    visibleViewport.keyboardHeight > KEYBOARD_OPEN_THRESHOLD_PX;

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
  const isPopout = location.search.includes("popout=1");
  const suppressStatusBanner = shouldSuppressRootStatusBanner(
    location.pathname,
    location.search,
  );

  return (
    <div
      data-slot="root-layout"
      className="app-shell"
      style={{
        background: "var(--surface-base)",
        height:
          keyboardOpen && visibleViewport
            ? `${visibleViewport.height + keyboardOffsetTop}px`
            : "100dvh",
        paddingTop: keyboardOffsetTop > 0 ? `${keyboardOffsetTop}px` : undefined,
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
      {!electron && !isPopout && !suppressStatusBanner ? (
        <StatusBanner placement="web" />
      ) : null}
      <div className="flex min-w-0 flex-col overflow-hidden w-full" style={{ flex: "1 1 0%", minHeight: 0 }}>
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

      {/* Name-prompt for the tray "New Assistant…" command — hatches an
          additional managed assistant and switches to it. */}
      <CreateAssistantDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
      />
    </div>
  );
}
