import { type CSSProperties } from "react";

import { useIsMobile } from "@/hooks/use-is-mobile";
import {
  KEYBOARD_OPEN_THRESHOLD_PX,
  useVisibleViewport,
} from "@/hooks/use-visible-viewport";

const SAFE_AREA_TOP =
  "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))";
const SAFE_AREA_BOTTOM =
  "var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))";
const SAFE_AREA_LEFT =
  "var(--safe-area-inset-left, env(safe-area-inset-left, 0px))";
const SAFE_AREA_RIGHT =
  "var(--safe-area-inset-right, env(safe-area-inset-right, 0px))";

/**
 * Positioning style for a full-screen mobile overlay (`position: fixed`,
 * horizontally full-bleed, safe-area padded) that stays glued to the region
 * actually visible above the iOS soft keyboard.
 *
 * `dvh`/`100dvh` account for retractable browser chrome but not the soft
 * keyboard, and `position: fixed` elements are anchored to the layout viewport,
 * so a plain `bottom-0 h-[100dvh]` overlay drifts out of the visible area when
 * iOS shrinks and scrolls the visual viewport to reveal a focused input. When
 * the keyboard is open, this tracks the visual viewport (`top: offsetTop`,
 * `height: visualViewport.height`) so the overlay exactly covers the visible
 * region — the same compensation `RootLayout` applies to the main app shell.
 *
 * Callers apply the returned style to a `position: fixed` element that also
 * sets `left/right` (e.g. `inset-x-0`) and stacking (`z-30`); animation
 * transforms compose on top without conflict.
 *
 * @see https://developer.chrome.com/blog/visual-viewport-api/
 * @see https://developer.mozilla.org/en-US/docs/Web/API/Visual_Viewport_API
 * @see https://bugs.webkit.org/show_bug.cgi?id=207049
 */
export function useMobileOverlayViewportStyle(): CSSProperties {
  const isMobile = useIsMobile();
  const visibleViewport = useVisibleViewport();

  const keyboardOpen =
    isMobile &&
    visibleViewport !== null &&
    visibleViewport.keyboardHeight > KEYBOARD_OPEN_THRESHOLD_PX;

  if (keyboardOpen && visibleViewport) {
    return {
      position: "fixed",
      top: `${visibleViewport.offsetTop}px`,
      bottom: "auto",
      height: `${visibleViewport.height}px`,
      paddingTop: 0,
      paddingBottom: 0,
      paddingLeft: SAFE_AREA_LEFT,
      paddingRight: SAFE_AREA_RIGHT,
    };
  }

  return {
    position: "fixed",
    top: "auto",
    bottom: 0,
    height: "100dvh",
    paddingTop: SAFE_AREA_TOP,
    paddingBottom: SAFE_AREA_BOTTOM,
    paddingLeft: SAFE_AREA_LEFT,
    paddingRight: SAFE_AREA_RIGHT,
  };
}
