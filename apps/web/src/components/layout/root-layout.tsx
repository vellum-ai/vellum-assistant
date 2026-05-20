import { Outlet } from "react-router";

import { useAppTheme } from "@/hooks/use-app-theme.js";
import { useIsMobile } from "@/hooks/use-is-mobile.js";
import { useVisibleViewport } from "@/hooks/use-visible-viewport.js";

/**
 * Threshold (in px) below which a `innerHeight − visualViewport.height` delta
 * is treated as the soft keyboard opening. Below this we assume incidental
 * drift from browser chrome / pinch-zoom and leave the layout alone.
 */
const KEYBOARD_OPEN_THRESHOLD_PX = 100;

/**
 * App-level layout route providing safe-area insets and iOS visual-viewport
 * keyboard tracking. All child layout routes (ChatLayout, SettingsLayout,
 * etc.) render inside this shell via `<Outlet />`.
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
    </div>
  );
}
