import { Outlet, useNavigate, useOutletContext } from "react-router";

import { useAppTheme } from "@/hooks/use-app-theme.js";
import { useEventBusInit } from "@/hooks/use-event-bus-init.js";
import { useIsMobile } from "@/hooks/use-is-mobile.js";
import { useVisibleViewport } from "@/hooks/use-visible-viewport.js";
import {
  useAssistantLifecycle,
  type UseAssistantLifecycleReturn,
} from "@/domains/chat/hooks/use-assistant-lifecycle.js";
import { useAuthStore } from "@/stores/auth-store.js";
import { useEnvironmentStore } from "@/lib/environment/environment-store.js";

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
  const isNonProduction = useEnvironmentStore.use.isNonProduction();
  const lifecycle = useAssistantLifecycle({
    isLoggedIn,
    isLoading: authLoading,
    isRetired: false,
    isNonProduction,
    onRedirect: navigate,
  });

  useEventBusInit({
    assistantId: lifecycle.assistantId,
    isAssistantActive: lifecycle.assistantState.kind === "active",
    checkAssistant: lifecycle.checkAssistant,
  });

  const keyboardOpen =
    isMobile &&
    visibleViewport !== null &&
    visibleViewport.keyboardHeight > KEYBOARD_OPEN_THRESHOLD_PX;

  const followVisualViewport =
    keyboardOpen &&
    visibleViewport !== null &&
    (visibleViewport.offsetTop !== 0 || visibleViewport.offsetLeft !== 0);

  const innerTransform = followVisualViewport
    ? `translate3d(${visibleViewport.offsetLeft}px, ${visibleViewport.offsetTop}px, 0)`
    : undefined;

  const outletContext: RootOutletContext = { lifecycle };

  return (
    <div
      data-slot="root-layout"
      className="app-shell"
      style={{
        background: "var(--surface-base)",
        height:
          keyboardOpen && visibleViewport
            ? `${visibleViewport.height}px`
            : "100dvh",
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
      <div
        className="flex min-w-0 flex-col overflow-hidden h-full w-full"
        style={{
          transform: innerTransform,
          transformOrigin: innerTransform ? "0 0" : undefined,
        }}
      >
        <Outlet context={outletContext} />
      </div>

      {/* Portal target for mobile overlays that use `position: fixed`.
          Lives outside the inner wrapper so the keyboard-following
          `translate3d(...)` doesn't shift the overlay's containing block.
          See: https://www.w3.org/TR/css-transforms-1/#transform-rendering */}
      <div id="viewport-overlays" />
    </div>
  );
}
