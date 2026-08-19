import { useEffect, useState } from "react";

import { subscribeNativeKeyboardHeight } from "@/runtime/native-keyboard";
import { isNativeMobile } from "@/runtime/platform-detection";

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
// dimensions change due to rotation rather than a keyboard event, and
// `rebaseReferenceForWindowResize` does the same for a window that a resize
// made shorter without rotating.
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

// Whether the last thing the shell announced was a keyboard coming up. The
// shells that resize their web view frame for the keyboard are the ones where
// that resize is otherwise indistinguishable from the window itself getting
// shorter, and they are exactly the shells that announce (see the
// `isNativeMobile` gate on `subscribeNativeKeyboardHeight`), so the
// announcement is what separates the two. Stays `false` in a browser, where the
// keyboard leaves `window.innerHeight` alone and there is nothing to separate.
let nativeKeyboardVisible = false;

// Whether a soft keyboard in this runtime would reach us at all: the plugin
// listeners registered, or there is no shell whose frame a keyboard resizes.
// A shell built before `@capacitor/keyboard`, or one whose registration
// rejected, leaves this `false`, and its own frame resizes must not be read as
// the window getting shorter. The web bundle is deployed ahead of installed
// shells, so that shell is a version we still run in.
let keyboardSourceReady = false;

// Whether an announcement has actually arrived. `nativeKeyboardVisible` starts
// `false`, which before the first announcement means "nothing heard yet" and
// not "no keyboard": a keyboard raised while the plugin listeners were still
// registering shows up here as silence. On a shell whose frame the keyboard
// resizes, that silence is indistinguishable from the window getting shorter,
// so the reference waits for one announcement before it trusts a `false`.
// A browser needs no such wait, since its keyboard leaves `window.innerHeight`
// alone and every shrink there is the window's own.
let sawKeyboardAnnouncement = false;

// The viewport reading pinned across a native picker session, or `null` when
// nothing is holding it. iOS presents a document/photo picker by taking first
// responder off the web view, which dismisses the soft keyboard, and the
// keyboard cannot stay up under a modal that owns the responder. What it can
// avoid is the shell resizing behind that picker: the composer would ride the
// keyboard down on the way in and back up on the way out, twice per attachment,
// with the picker covering the space either way.
let heldViewport: VisibleViewport | null = null;
// Depth rather than a flag: the composer's picker and the attachments strip's
// each own a session of their own, and a release from one must not answer for
// the other.
let viewportHoldDepth = 0;

/**
 * Pin the current viewport reading until the returned release is called, so a
 * transition the user is not looking at cannot resize the shell. Holds nothing
 * unless a keyboard is actually up, since there is no collapse to sit out
 * otherwise, and the release is idempotent.
 */
export function holdVisibleViewport(): () => void {
  if (viewportHoldDepth === 0 && typeof window !== "undefined") {
    const current = readVisibleViewport();
    heldViewport =
      current && current.keyboardHeight >= KEYBOARD_OPEN_THRESHOLD_PX
        ? current
        : null;
  }
  viewportHoldDepth += 1;
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    viewportHoldDepth -= 1;
    if (viewportHoldDepth > 0) {
      return;
    }
    heldViewport = null;
    for (const notify of viewportUpdaters) {
      notify();
    }
  };
}

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
      (keyboardHeight, visible) => {
        anticipatedKeyboardHeight = keyboardHeight;
        anticipationViewportHeight = window.visualViewport?.height ?? 0;
        // Which event fired, not what it measured. A malformed show payload is
        // coerced to `0` at the bridge, and reading visibility off that number
        // would call a keyboard coming up a dismissal, then let the frame
        // resize behind it pass for the window getting shorter.
        nativeKeyboardVisible = visible;
        sawKeyboardAnnouncement = true;
        for (const notify of viewportUpdaters) {
          notify();
        }
      },
      () => {
        // Only the flag. A resize that landed while these listeners were
        // registering is deliberately left alone: see `rebaseReferenceForWindowResize`
        // for why this moment cannot tell a shrinking window from a keyboard
        // that opened before there was anything to announce it.
        keyboardSourceReady = true;
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
    nativeKeyboardVisible = false;
    sawKeyboardAnnouncement = false;
    keyboardSourceReady = false;
  };
}

/**
 * Rebase the keyboard-free reference onto a window that has genuinely become
 * shorter.
 *
 * `referenceInnerHeight` otherwise only ever grows, so a same-orientation
 * window resize (an iPad Stage Manager drag, a split-view divider, a desktop
 * window pulled shorter) leaves it standing at a height the window no longer
 * has, and every reading from then on reports the difference as a keyboard that
 * never goes away.
 *
 * A real keyboard is the one shrink to leave alone, and the announcement is the
 * whole test: a shell that resizes its frame for the keyboard says so first,
 * and a browser, which never announces, does not shrink the window for a
 * keyboard in the first place. Focus is deliberately not consulted, since a
 * hardware keyboard holds the composer focused with nothing on screen.
 *
 * That test only holds while there is something to announce with, so a runtime
 * that has not reported a keyboard source keeps its reference: on a shell built
 * before the plugin, rebasing would swallow the keyboard's own frame resize and
 * leave the composer behind it.
 *
 * Driven by the `window` resize listener alone. Never on a plain viewport read:
 * that would rebase onto a frame the keyboard still owns, since a dismissal
 * announces its `0` and notifies consumers before the frame grows back. And
 * never when the keyboard source reports in, even though a resize that landed
 * during registration was skipped for want of that answer: at that moment
 * nothing separates a window that shrank from a keyboard that opened before
 * there was anything to announce it. Focus does not separate them, a hardware
 * keyboard holds a field focused with nothing on screen, and the plugin offers
 * no way to ask whether the keyboard is up right now.
 *
 * Leaving it alone is the safe half of that ambiguity. A reference left too
 * tall reports a keyboard that is not there, which arms a dismissal gesture
 * whose whole effect is blurring a focused field, and it corrects itself on the
 * next resize or as soon as a read sees the window at its full height. A
 * reference rebased onto a keyboard-sized frame reports no keyboard at all and
 * stays wrong for as long as the keyboard is up.
 *
 * Reports whether the reference moved, which the resize listener ignores today
 * and a future caller may not.
 */
function rebaseReferenceForWindowResize(): boolean {
  if (window.innerHeight >= referenceInnerHeight) {
    return false;
  }
  if (!keyboardSourceReady || nativeKeyboardVisible) {
    return false;
  }
  // On a shell that resizes its frame for the keyboard, a `false` that no
  // announcement has confirmed is silence rather than an answer, and the
  // keyboard raised during registration is exactly the case that produces it.
  if (isNativeMobile() && !sawKeyboardAnnouncement) {
    return false;
  }
  referenceInnerHeight = window.innerHeight;
  return true;
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
    // A rotation resizes the viewport on its own account, and a height held
    // against the orientation the device has left describes nothing. The hold
    // is dropped rather than ended, so the release that owns it still balances.
    heldViewport = null;
  }

  // Held readings answer before the measurement, and after the rotation reset
  // so they cannot outlive the orientation they were taken in.
  if (heldViewport) {
    return heldViewport;
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
    // The rebase rides the window's own resize rather than every viewport
    // read; see `rebaseReferenceForWindowResize`.
    const handleWindowResize = () => {
      rebaseReferenceForWindowResize();
      update();
    };
    update();
    // `resize` fires on width/height/scale changes; `scroll` fires on
    // offsetTop/offsetLeft changes. Both must be observed — iOS commonly
    // fires one without the other during a single keyboard transition.
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    window.addEventListener("resize", handleWindowResize);
    const removeUpdater = addViewportUpdater(update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      window.removeEventListener("resize", handleWindowResize);
      removeUpdater();
    };
  }, []);

  return state;
}
