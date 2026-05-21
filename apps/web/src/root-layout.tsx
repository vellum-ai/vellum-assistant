import { useCallback } from "react";
import { Outlet, useNavigate } from "react-router";

import { useAppTheme } from "@/hooks/use-app-theme.js";
import { useAssistantLifecycleBootstrap } from "@/hooks/use-assistant-lifecycle-bootstrap.js";
import { useEventBusInit } from "@/hooks/use-event-bus-init.js";
import { useIsMobile } from "@/hooks/use-is-mobile.js";
import { useVisibleViewport } from "@/hooks/use-visible-viewport.js";
import { useAssistantLifecycleStore } from "@/stores/assistant-lifecycle-store.js";

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
 * 2. The single assistant lifecycle (bootstrapped via
 *    `useAssistantLifecycleBootstrap`, with state held in
 *    `useAssistantLifecycleStore`). All child layouts read the
 *    lifecycle directly from the store — no outlet-context plumbing.
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

  const navigate = useNavigate();
  useAssistantLifecycleBootstrap({ onRedirect: navigate });

  const assistantId = useAssistantLifecycleStore.use.assistantId();
  const assistantState = useAssistantLifecycleStore.use.assistantState();

  // Stable wrapper around the store's `checkAssistant` action — gives
  // the event-bus init a referentially-stable callback for its effect
  // dependencies without forcing the bus hook to import the store.
  const checkAssistant = useCallback(() => {
    void useAssistantLifecycleStore.getState().checkAssistant();
  }, []);

  useEventBusInit({
    assistantId,
    isAssistantActive: assistantState.kind === "active",
    checkAssistant,
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
        <Outlet />
      </div>

      {/* Portal target for mobile overlays that use `position: fixed`.
          Lives outside the inner wrapper so the keyboard-following
          `translate3d(...)` doesn't shift the overlay's containing block.
          See: https://www.w3.org/TR/css-transforms-1/#transform-rendering */}
      <div id="viewport-overlays" />
    </div>
  );
}
