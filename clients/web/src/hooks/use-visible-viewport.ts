import { useEffect, useState } from "react";

/**
 * Threshold (in px) below which an `innerHeight − visualViewport.height` delta
 * is treated as the soft keyboard opening. Below this we assume incidental
 * drift from browser chrome / pinch-zoom and leave the layout alone.
 */
export const KEYBOARD_OPEN_THRESHOLD_PX = 100;

export interface VisibleViewport {
  /** Height of the visual viewport in pixels — the area actually visible to the user. */
  height: number;
  /**
   * Height in pixels of the on-screen keyboard (or other virtual widget)
   * that's covering the layout viewport. `0` when no keyboard is visible.
   */
  keyboardHeight: number;
  /**
   * Offset in pixels between the top edge of the visual viewport and the top
   * edge of the layout viewport. iOS sets this when it auto-positions the
   * visible viewport above the soft keyboard. Always `0` on Android and
   * desktop. Always `0` while pinch-zoomed (we ignore zoom-induced offset).
   */
  offsetTop: number;
  /**
   * Offset in pixels between the left edge of the visual viewport and the
   * layout viewport. Non-zero only during pinch-zoom panning (which we
   * ignore, see `offsetTop`). Exposed for completeness and to round-trip
   * symmetrically with `offsetTop` through `translate()`.
   */
  offsetLeft: number;
}

// Stable reference for the viewport height when no keyboard is present.
//
// In Safari, `window.innerHeight` stays at the layout viewport height when the
// keyboard opens and only `visualViewport.height` shrinks, so
// `innerHeight - vv.height` directly yields the keyboard height.
//
// In WKWebView (Capacitor iOS without `@capacitor/keyboard`), the web view
// frame itself is resized to fit above the keyboard. Both `innerHeight` and
// `vv.height` shrink together, making `innerHeight - vv.height ≈ 0` even when
// the keyboard is visible. By comparing against the maximum observed
// `innerHeight` — which corresponds to the keyboard-dismissed state — keyboard
// detection works correctly across both runtimes.
//
// Orientation changes are tracked so the reference resets when the viewport
// dimensions change due to rotation rather than a keyboard event.
let referenceInnerHeight =
  typeof window !== "undefined" ? window.innerHeight : 0;

// Orientation detection via matchMedia — universally supported (iOS 9+),
// unlike screen.orientation which was only added in Safari 16.4.
function isPortrait(): boolean {
  if (typeof window === "undefined") {
    return true;
  }
  return window.matchMedia("(orientation: portrait)").matches;
}
let lastIsPortrait: boolean = isPortrait();

/**
 * Read the current visual-viewport state.
 *
 * Exported so unit tests can drive the function against a stubbed
 * `window.visualViewport` without mounting React.
 */
export function readVisibleViewport(): VisibleViewport | null {
  if (!window.visualViewport) {
    return null;
  }
  const vv = window.visualViewport;

  // Reset the reference when the device orientation changes — a rotation
  // legitimately changes the viewport dimensions and would otherwise look
  // like a keyboard event.
  const currentIsPortrait = isPortrait();
  if (currentIsPortrait !== lastIsPortrait) {
    lastIsPortrait = currentIsPortrait;
    referenceInnerHeight = window.innerHeight;
  }

  // Update the reference whenever the viewport grows (keyboard dismissed,
  // or first observation after an orientation change that settled).
  if (window.innerHeight > referenceInnerHeight) {
    referenceInnerHeight = window.innerHeight;
  }

  // When pinch-zoomed (scale > 1) the visual viewport height shrinks in CSS
  // pixels, which would otherwise inflate keyboardHeight and falsely trigger
  // keyboard-open detection. Only derive keyboardHeight at ~1.0 scale.
  const isZoomed = Math.abs(vv.scale - 1) > 0.05;
  return {
    height: vv.height,
    keyboardHeight: isZoomed
      ? 0
      : Math.max(0, referenceInnerHeight - vv.height),
    offsetTop: isZoomed ? 0 : vv.offsetTop,
    offsetLeft: isZoomed ? 0 : vv.offsetLeft,
  };
}

/**
 * Tracks the VisualViewport API so callers can size and position containers
 * to the area actually visible to the user.
 *
 * In Safari, the soft keyboard shrinks `visualViewport.height` while
 * `window.innerHeight` stays at the full layout viewport. In Capacitor's
 * WKWebView (without `@capacitor/keyboard`), the web view frame itself
 * resizes, shrinking both values together. The `referenceInnerHeight`
 * approach in `readVisibleViewport` handles both cases — see the module-level
 * comment above it.
 *
 * Returns `null` in browsers that lack the API; callers should fall back to
 * `100dvh` (and no transform) in that case.
 *
 * @see https://developer.chrome.com/blog/visual-viewport-api/
 * @see https://bugs.webkit.org/show_bug.cgi?id=207049
 */
export function useVisibleViewport(): VisibleViewport | null {
  const [state, setState] = useState<VisibleViewport | null>(null);

  useEffect(() => {
    if (!window.visualViewport) {
      return;
    }
    const vv = window.visualViewport;
    const update = () => setState(readVisibleViewport());
    update();
    // `resize` fires on width/height/scale changes; `scroll` fires on
    // offsetTop/offsetLeft changes. Both must be observed — iOS commonly
    // fires one without the other during a single keyboard transition.
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  return state;
}
