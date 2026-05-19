import { useEffect, useState } from "react";

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

/**
 * Read the current visual-viewport state.
 *
 * Exported so unit tests can drive the function against a stubbed
 * `window.visualViewport` without mounting React.
 */
export function readVisibleViewport(): VisibleViewport | null {
  if (typeof window === "undefined" || !window.visualViewport) {
    return null;
  }
  const vv = window.visualViewport;
  // When pinch-zoomed (scale > 1) the visual viewport height shrinks in CSS
  // pixels, which would otherwise inflate keyboardHeight and falsely trigger
  // keyboard-open detection. Only derive keyboardHeight at ~1.0 scale.
  const isZoomed = Math.abs(vv.scale - 1) > 0.05;
  return {
    height: vv.height,
    keyboardHeight: isZoomed ? 0 : Math.max(0, window.innerHeight - vv.height),
    offsetTop: isZoomed ? 0 : vv.offsetTop,
    offsetLeft: isZoomed ? 0 : vv.offsetLeft,
  };
}

/**
 * Tracks the VisualViewport API so callers can size and position containers
 * to the area actually visible to the user.
 *
 * On iOS the soft keyboard shrinks `visualViewport.height` while
 * `window.innerHeight` (and `100dvh`) stays at the full layout viewport.
 * Sizing a container to `height` keeps the layout inside the visible region.
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
    if (typeof window === "undefined" || !window.visualViewport) {
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
