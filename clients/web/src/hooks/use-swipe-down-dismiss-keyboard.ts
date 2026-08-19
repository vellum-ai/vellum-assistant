import { useEffect, useLayoutEffect, useRef } from "react";

import { hideNativeKeyboard } from "@/runtime/native-keyboard";
import { isPointerCoarse } from "@/utils/pointer";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Downward travel (px) at which the keyboard is dismissed. Deliberately short:
 * this mirrors UIKit's `keyboardDismissMode = .onDrag`, where any real drag of
 * the content under the keyboard puts it away, rather than a swipe-to-dismiss
 * sheet that demands a long committed pull. Above the deadzone but well under
 * the 80px commit distance used by the sheet gestures, so the keyboard is gone
 * by the time the thread has scrolled a line or two.
 */
const DISMISS_THRESHOLD_PX = 40;

/** Minimum travel (px) on either axis before the gesture direction is decided. */
const DEADZONE_PX = 10;

/**
 * If horizontal travel exceeds this ratio of vertical travel, the gesture is a
 * horizontal pan (an attachment strip, a swipe-action row, the edge-swipe
 * drawer) rather than a downward swipe, so it is abandoned.
 */
const HORIZONTAL_ESCAPE_RATIO = 0.7;

/**
 * Elements that own a vertical drag for their own text interaction: dragging
 * inside a text field or contenteditable places the caret and extends the
 * selection. Putting the keyboard away mid-selection would fight the user, so
 * gestures that begin here never arm.
 */
const EDITABLE_SELECTOR =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

// ---------------------------------------------------------------------------
// Pure helpers (framework-agnostic, unit-tested in isolation)
// ---------------------------------------------------------------------------

/**
 * Whether the element is (or sits inside) an editable field, so a drag starting
 * on it belongs to caret placement and text selection rather than to this
 * gesture.
 */
export function ownsVerticalTextDrag(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  return target.closest(EDITABLE_SELECTOR) !== null;
}

export type SwipeDownDecision = "pending" | "cancel" | "tracking" | "dismiss";

/**
 * Classify a gesture from its deltas since touch start: still inside the
 * deadzone (`"pending"`), a horizontal pan or an upward move to abandon
 * (`"cancel"`), a downward drag that has not yet travelled far enough
 * (`"tracking"`), or one that has (`"dismiss"`).
 *
 * Re-evaluated on every move, so a drag that starts downward and reverses
 * upward cancels rather than dismissing on a later frame.
 */
export function decideSwipeDown(dx: number, dy: number): SwipeDownDecision {
  if (Math.abs(dx) < DEADZONE_PX && Math.abs(dy) < DEADZONE_PX) {
    return "pending";
  }
  if (Math.abs(dx) > Math.abs(dy) * HORIZONTAL_ESCAPE_RATIO) {
    return "cancel";
  }
  if (dy <= 0) {
    return "cancel";
  }
  if (dy >= DISMISS_THRESHOLD_PX) {
    return "dismiss";
  }
  return "tracking";
}

/**
 * Drop focus from the focused editable element, which is what puts the soft
 * keyboard away on iOS. Returns whether anything was blurred, so callers can
 * skip the native follow-up when no field held focus.
 *
 * Only editables are blurred. A focused button or link keeps its focus ring,
 * which a swipe has no business clearing, and neither raises a keyboard.
 */
export function blurFocusedEditable(): boolean {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) {
    return false;
  }
  if (!active.matches(EDITABLE_SELECTOR)) {
    return false;
  }
  active.blur();
  return true;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

interface UseSwipeDownDismissKeyboardArgs {
  /** Whether the gesture is armed, i.e. the soft keyboard is currently up. */
  enabled: boolean;
}

interface DragState {
  touchId: number;
  startX: number;
  startY: number;
}

function findTouch(touches: TouchList, touchId: number): Touch | null {
  for (const touch of Array.from(touches)) {
    if (touch.identifier === touchId) {
      return touch;
    }
  }
  return null;
}

/**
 * Dismiss the soft keyboard on a downward swipe anywhere above it.
 *
 * Nothing on the page dismisses the keyboard on a drag by itself: WKWebView
 * only blurs on a tap, so a swipe that happens to travel a few pixels reads as
 * a tap and puts the keyboard away while a real swipe does not, which is what
 * makes the gesture feel unreliable. UIKit's own answer is
 * `UIScrollView.keyboardDismissMode`, but that only covers the scroll view the
 * drag lands in, and here the thread is an inner overflow element inside the
 * web view with static chrome (header, banners, composer) around it. So the
 * gesture is owned at the web layer, where it applies to the whole surface
 * above the keyboard and works identically on iOS, Android and mobile web.
 *
 * Listeners are attached to `document` (passive) rather than to a container so
 * the whole viewport responds, including regions that are not scrollable and
 * subtrees portalled out of this layout. They are installed once on mount
 * rather than keyed on `enabled`, because dismissing flips `enabled` to false
 * and tearing listeners down mid-gesture would strand the in-flight touch; the
 * gesture is gated per-touch through `enabledRef` instead.
 *
 * Passive listeners never call `preventDefault()`, so the thread keeps
 * scrolling natively under the gesture. That is deliberate: the swipe rides
 * along with the scroll exactly as `.onDrag` does on a native list.
 *
 * For the same reason the gesture does not claim exclusive ownership of a
 * downward drag. Pull-to-refresh (`usePullToRefresh`, behind
 * `chat-pull-to-refresh-enabled`) reads the same drag when the thread is
 * pinned to its latest message, and commits at 64px against this hook's 40px,
 * so a pull with the keyboard up both dismisses and refreshes. That is the
 * native behaviour, not a collision to arbitrate away: pulling Mail's list
 * down with the keyboard up puts the keyboard away and still refreshes. The
 * pull survives the dismissal because its extent is measured from `clientY`
 * and it re-pins `scrollTop` each move, neither of which the keyboard's frame
 * resize disturbs.
 */
export function useSwipeDownDismissKeyboard({
  enabled,
}: UseSwipeDownDismissKeyboardArgs): void {
  const dragRef = useRef<DragState | null>(null);
  const enabledRef = useRef(enabled);
  useLayoutEffect(() => {
    enabledRef.current = enabled;
  });

  useEffect(() => {
    if (!isPointerCoarse()) {
      return;
    }

    const handleTouchStart = (event: TouchEvent) => {
      if (!enabledRef.current) {
        return;
      }
      if (event.touches.length !== 1) {
        dragRef.current = null;
        return;
      }
      const touch = event.touches[0];
      if (!touch) {
        return;
      }
      if (ownsVerticalTextDrag(event.target)) {
        return;
      }
      dragRef.current = {
        touchId: touch.identifier,
        startX: touch.clientX,
        startY: touch.clientY,
      };
    };

    const handleTouchMove = (event: TouchEvent) => {
      const drag = dragRef.current;
      if (!drag) {
        return;
      }
      // A second finger landing mid-gesture (a pinch, a two-finger scroll)
      // is not a dismiss swipe.
      if (event.touches.length > 1) {
        dragRef.current = null;
        return;
      }
      const touch = findTouch(event.touches, drag.touchId);
      if (!touch) {
        return;
      }

      const decision = decideSwipeDown(
        touch.clientX - drag.startX,
        touch.clientY - drag.startY,
      );
      if (decision === "pending" || decision === "tracking") {
        return;
      }
      // Cleared either way: a cancelled gesture must not resume if the finger
      // wanders back down, and a dismissal fires once per touch.
      dragRef.current = null;
      if (decision !== "dismiss") {
        return;
      }
      // Blur first: on iOS that is the dismissal, and it also stops the field
      // from holding an editing context the native call would have to fight.
      // The plugin call is the Android half, where the IME commonly survives a
      // DOM blur. It resolves off-shell and never throws.
      if (blurFocusedEditable()) {
        void hideNativeKeyboard();
      }
    };

    const endGesture = () => {
      dragRef.current = null;
    };

    // Capture phase: the gesture must be seen no matter which subtree owns the
    // touch, including anything that stops propagation on its way up.
    const options = { capture: true, passive: true } as const;
    document.addEventListener("touchstart", handleTouchStart, options);
    document.addEventListener("touchmove", handleTouchMove, options);
    document.addEventListener("touchend", endGesture, options);
    document.addEventListener("touchcancel", endGesture, options);

    return () => {
      dragRef.current = null;
      document.removeEventListener("touchstart", handleTouchStart, true);
      document.removeEventListener("touchmove", handleTouchMove, true);
      document.removeEventListener("touchend", endGesture, true);
      document.removeEventListener("touchcancel", endGesture, true);
    };
  }, []);
}
