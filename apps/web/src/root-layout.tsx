import { Outlet, useNavigate, useOutletContext } from "react-router";

import { useAppTheme } from "@/hooks/use-app-theme";
import { useEventBusInit } from "@/hooks/use-event-bus-init";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useVisibleViewport } from "@/hooks/use-visible-viewport";
import {
  useAssistantLifecycle,
  type UseAssistantLifecycleReturn,
} from "@/assistant/use-lifecycle";
import { useAuthStore } from "@/stores/auth-store";
import { useEnvironmentStore } from "@/stores/environment-store";
import { useAssistantResourceSync } from "@/hooks/use-assistant-resource-sync";
import { useDocumentEditorSync } from "@/hooks/use-document-editor-sync";
import { useNotificationIntentSync } from "@/hooks/use-notification-intent-sync";
import { useConversationSync } from "@/domains/conversations/use-conversation-sync";
import { resolveOnboardingRedirect } from "@/domains/onboarding/gate";
import { useFeatureFlagBusSync } from "@/hooks/use-feature-flag-bus-sync";
import { useClientFeatureFlagSync } from "@/hooks/use-client-feature-flag-sync";
import { useAssistantFeatureFlagSync } from "@/hooks/use-assistant-feature-flag-sync";

/**
 * Threshold (in px) below which a `innerHeight − visualViewport.height` delta
 * is treated as the soft keyboard opening. Below this we assume incidental
 * drift from browser chrome / pinch-zoom and leave the layout alone.
 */
const KEYBOARD_OPEN_THRESHOLD_PX = 100;

/**
 * Outlet-context shape provided by `RootLayout`. Child layouts
 * (`ChatLayout`, `SettingsLayout`, `LogsLayout`, onboarding routes)
 * consume the lifecycle through `useRootOutletContext()`.
 */
export interface RootOutletContext {
  lifecycle: UseAssistantLifecycleReturn;
}

/**
 * Read the assistant lifecycle from the root outlet context. Child
 * layouts (`ChatLayout`, `SettingsLayout`, `LogsLayout`) call this to
 * avoid running a duplicate `useAssistantLifecycle` state machine.
 */
export function useRootOutletContext(): RootOutletContext {
  return useOutletContext<RootOutletContext>();
}

/**
 * App-level layout route. Owns three cross-route concerns:
 *
 * 1. Safe-area insets and iOS visual-viewport keyboard tracking.
 * 2. The single assistant lifecycle (`useAssistantLifecycle`), passed
 *    to every child layout via outlet context. Resolving lifecycle here
 *    means SettingsLayout / LogsLayout / onboarding routes can see the
 *    current assistant without each layout running its own polling
 *    state machine.
 * 3. The event-bus owner (`useEventBusInit`). Bus producers (SSE
 *    connection, visibility / online / offline listeners, Capacitor
 *    app-state) need to be alive on every authenticated route — not
 *    just chat — so cross-tab sync invalidations keep firing while the
 *    user is on settings, logs, etc.
 *
 * References:
 * - React Router layout routes: https://reactrouter.com/start/data/routing
 * - React Router outlet context: https://reactrouter.com/start/framework/outlet
 * - env() safe-area-inset: https://developer.mozilla.org/en-US/docs/Web/CSS/env
 * - Visual Viewport API: https://developer.mozilla.org/en-US/docs/Web/API/Visual_Viewport_API
 */
export function RootLayout() {
  useAppTheme();
  const isMobile = useIsMobile();
  const visibleViewport = useVisibleViewport();

  const navigate = useNavigate();
  const isLoggedIn = useAuthStore.use.isLoggedIn();
  const authLoading = useAuthStore.use.isLoading();
  const hasPlatformSession = useAuthStore.use.hasPlatformSession();
  const isNonProduction = useEnvironmentStore.use.isNonProduction();
  useClientFeatureFlagSync(hasPlatformSession && !authLoading);
  const lifecycle = useAssistantLifecycle({
    isLoggedIn,
    isLoading: authLoading,
    isRetired: false,
    isNonProduction,
    hasPlatformSession,
    onRedirect: navigate,
    resolveOnboardingRedirect,
  });

  useAssistantFeatureFlagSync(hasPlatformSession ? lifecycle.assistantId : null);
  const isAssistantActive = lifecycle.assistantState.kind === "active";
  useAssistantResourceSync(lifecycle.assistantId, isAssistantActive);
  useConversationSync(lifecycle.assistantId, isAssistantActive);
  useFeatureFlagBusSync(lifecycle.assistantId, isAssistantActive);
  useNotificationIntentSync(lifecycle.assistantId);
  useDocumentEditorSync();

  useEventBusInit({
    assistantId: lifecycle.assistantId,
    isAssistantActive,
    checkAssistant: lifecycle.checkAssistant,
  });

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

  const outletContext: RootOutletContext = { lifecycle };

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
      }}
    >
      <div className="flex min-w-0 flex-col overflow-hidden h-full w-full">
        <Outlet context={outletContext} />
      </div>

      {/* Portal target for mobile overlays that use `position: fixed`. */}
      <div id="viewport-overlays" />
    </div>
  );
}
