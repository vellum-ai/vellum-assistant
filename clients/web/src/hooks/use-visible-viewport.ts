import { useEffect, useState } from "react";

import { subscribeNativeKeyboardHeight } from "@/runtime/native-keyboard";

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
// In WKWebView (Capacitor iOS; `@capacitor/keyboard` is installed and pinned to
// `resize: native` in `capacitor.config.ts`), the web view frame itself is resized to
// fit above the keyboard. Both `innerHeight` and `vv.height` shrink together,
// making `innerHeight - vv.height ≈ 0` even when the keyboard is visible. By
// comparing against the maximum observed
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

// Keyboard height announced by `@capacitor/keyboard` at the leading edge of the
// show animation, or `0` when nothing is anticipated. The plugin's own web view
// frame resize lands well after that (see `docs/CAPACITOR.md` § "Linking a
// plugin runs its native `load()`"), so reporting the announced height keeps
// layout with the keyboard until the measurement can take over.
let anticipatedKeyboardHeight = 0;

// `visualViewport.height` at the moment of that announcement. The deferred
// frame resize is the event anticipation waits for, and the viewport moving off
// this height is what that event looks like from here.
let anticipationViewportHeight = 0;

// State updaters of the mounted `useVisibleViewport` consumers. One native
// subscription feeds all of them, so the listener count stays flat as the shell
// and the mobile overlays each mount their own copy of the hook, and a repeated
// cleanup (React StrictMode's double effect invocation) cannot unbalance an
// idempotent `Set.delete`.
const viewportUpdaters = new Set<() => void>();
let unsubscribeNativeKeyboard: (() => void) | null = null;

/**
 * Register a mounted consumer's state updater, returning its deregistration.
 * The first registration opens the native keyboard subscription; the last
 * deregistration closes it and drops any anticipation it left behind, which
 * with `RootLayout` mounting the hook for the app's lifetime is teardown.
 *
 * A dismissal announces `0`, which clears anticipation: the native hide resize
 * is near-instant, so the derived measurement drives the restore on its own.
 * The announced height arrives already coerced to a finite, non-negative number
 * by `readKeyboardHeight` at the bridge boundary.
 */
function addViewportUpdater(update: () => void): () => void {
  viewportUpdaters.add(update);
  if (!unsubscribeNativeKeyboard) {
    unsubscribeNativeKeyboard = subscribeNativeKeyboardHeight(
      (keyboardHeight) => {
        anticipatedKeyboardHeight = keyboardHeight;
        anticipationViewportHeight = window.visualViewport?.height ?? 0;
        for (const notify of viewportUpdaters) {
          notify();
        }
      },
    );
  }

  return () => {
    viewportUpdaters.delete(update);
    if (viewportUpdaters.size > 0) {
      return;
    }
    unsubscribeNativeKeyboard?.();
    unsubscribeNativeKeyboard = null;
    anticipatedKeyboardHeight = 0;
  };
}

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
    // Rebasing the reference invalidates any height announced against the old
    // one, so anticipation goes with it rather than outliving its baseline.
    anticipatedKeyboardHeight = 0;
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
  const derivedKeyboardHeight = isZoomed
    ? 0
    : Math.max(0, referenceInnerHeight - vv.height);
  const offsetTop = isZoomed ? 0 : vv.offsetTop;
  const offsetLeft = isZoomed ? 0 : vv.offsetLeft;

  // The viewport moving off the height it had when the keyboard was announced
  // is the deferred native frame resize landing, and the measurement is
  // authoritative from there. Judging that by the derived height instead reads
  // it wrong both ways: a viewport already sitting a fraction of a pixel below
  // `referenceInnerHeight` looks landed before anything moved, and a resize
  // that lands shorter than announced (in iPad Stage Manager the plugin
  // measures the keyboard's overlap in screen coordinates while the frame
  // shrinks against window bounds) never looks landed at all.
  if (
    anticipatedKeyboardHeight > 0 &&
    vv.height !== anticipationViewportHeight
  ) {
    anticipatedKeyboardHeight = 0;
  }

  // A pinch-zoomed viewport reports no keyboard at all, anticipated or not, and
  // a reference no taller than the announced keyboard describes no visible
  // region: both defer to the measurement rather than sizing the shell to a
  // height CSS would reject. Anticipation only ever shrinks the shell against
  // the current measurement, so a keyboard announced shorter than the one the
  // frame is still sized for cannot overshoot that frame and push the composer
  // below its bottom edge.
  const anticipatedVisibleHeight =
    referenceInnerHeight - anticipatedKeyboardHeight;
  if (
    !isZoomed &&
    anticipatedKeyboardHeight > 0 &&
    anticipatedVisibleHeight > 0 &&
    anticipatedVisibleHeight < vv.height
  ) {
    return {
      height: anticipatedVisibleHeight,
      keyboardHeight: anticipatedKeyboardHeight,
      offsetTop,
      offsetLeft,
    };
  }

  return {
    height: vv.height,
    keyboardHeight: derivedKeyboardHeight,
    offsetTop,
    offsetLeft,
  };
}

/**
 * Tracks the VisualViewport API so callers can size and position containers
 * to the area actually visible to the user.
 *
 * In Safari, the soft keyboard shrinks `visualViewport.height` while
 * `window.innerHeight` stays at the full layout viewport. In Capacitor's
 * WKWebView (with `@capacitor/keyboard` installed and pinned to
 * `resize: native`), the web view frame itself resizes, shrinking both
 * values together. The `referenceInnerHeight`
 * approach in `readVisibleViewport` handles both cases — see the module-level
 * comment above it.
 *
 * On the native iOS shell the hook also subscribes to the keyboard height the
 * plugin announces, and reports it until the plugin's own deferred resize
 * lands. Off that shell the subscription attaches no listeners and the derived
 * measurement is the only source.
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
    const removeUpdater = addViewportUpdater(update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      removeUpdater();
    };
  }, []);

  return state;
}
