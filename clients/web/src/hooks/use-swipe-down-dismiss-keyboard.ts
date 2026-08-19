import { useEffect, useLayoutEffect, useRef } from "react";

import { hideNativeKeyboard } from "@/runtime/native-keyboard";
import { CARET_SURFACE_SELECTOR, ownsCaretDrag } from "@/utils/caret-surface";
import { usePointerCoarse } from "@/utils/pointer";

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
 * Rendered transcript message text, which is selectable so quote-reply can
 * pick it up. `use-edge-swipe.ts` marks the same blocks for the same reason.
 *
 * Unlike an editable, this owns a vertical drag only while a selection is
 * actually live (see {@link ownsVerticalTextDrag}). Excluding it outright
 * would carve every message bubble out of the gesture, which is most of the
 * surface above the keyboard and the opposite of the point. The marker sits on
 * the text block alone, not the whole message row, so a drag over a row's
 * gaps, attachments and action affordances still arms either way.
 */
const SELECTABLE_TEXT_SELECTOR = "[data-message-text]";

// ---------------------------------------------------------------------------
// Pure helpers (framework-agnostic, unit-tested in isolation)
// ---------------------------------------------------------------------------

/**
 * Whether a drag starting on this element belongs to text interaction rather
 * than to this gesture.
 *
 * Always true inside an editable, where a drag places the caret. True inside
 * selectable transcript text only when `hasLiveSelection` says a selection is
 * already up: that is the long-press-then-drag-a-handle case, where dismissing
 * the keyboard would resize the viewport out from under the selection. With no
 * selection in play a drag over message text is just a swipe, and the gesture
 * takes it.
 *
 * This is the arming check only. A selection can also appear partway through a
 * drag that started without one, which the hook catches by re-reading
 * `hasLiveSelection()` before it dismisses.
 */
export function ownsVerticalTextDrag(
  target: EventTarget | null,
  hasLiveSelection: boolean,
): boolean {
  if (ownsCaretDrag(target)) {
    return true;
  }
  return hasLiveSelection && startsOnSelectableText(target);
}

/**
 * Whether the drag began on selectable transcript text.
 *
 * Remembered for the life of the gesture so the selection can be re-checked at
 * the moment of dismissal: a long press raises a selection partway through a
 * drag that started with none, and only a touch that began on message text can
 * be the one adjusting it.
 */
export function startsOnSelectableText(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  return target.closest(SELECTABLE_TEXT_SELECTOR) !== null;
}

/**
 * Whether the document currently holds a non-empty text selection. A collapsed
 * selection is just a caret, which no drag is adjusting.
 */
export function hasLiveSelection(): boolean {
  const selection = window.getSelection();
  return selection !== null && !selection.isCollapsed;
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
  if (!active.matches(CARET_SURFACE_SELECTOR)) {
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
  /**
   * Whether the touch began on selectable transcript text, so a selection
   * appearing later in the drag can be recognised as this touch's doing.
   */
  onSelectableText: boolean;
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
 * The pointer type is the one input that does re-run setup. It is read as a
 * subscription, not a one-shot: a convertible that sheds its keyboard, or a
 * tablet lifted out of a dock, switches to a coarse primary pointer mid-session
 * and must get the gesture then, without waiting for this layout to remount.
 *
 * Touches inside a sandboxed iframe do not reach this listener, so an inline
 * app or dynamic page in the thread is a dead spot for the gesture. Recovering
 * them would mean an invisible layer over the iframe, which for a gesture that
 * spans the whole screen would mean covering the app outright and blocking
 * every touch it was rendered for. `mobile-app-overlay` makes the same call for
 * its own swipe and scopes that gesture to the surrounding chrome;
 * `EdgeSwipeHitZone` recovers only a 20px strip for the same reason. The
 * keyboard stays reachable from everywhere else on the screen, and the composer
 * that raised it is never inside an app frame.
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

  const pointerCoarse = usePointerCoarse();

  useEffect(() => {
    if (!pointerCoarse) {
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
      if (ownsVerticalTextDrag(event.target, hasLiveSelection())) {
        return;
      }
      dragRef.current = {
        touchId: touch.identifier,
        startX: touch.clientX,
        startY: touch.clientY,
        onSelectableText: startsOnSelectableText(event.target),
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
      const { onSelectableText } = drag;
      dragRef.current = null;
      if (decision !== "dismiss") {
        return;
      }
      // The selection is re-read here, not just at touchstart. A long press
      // raises one partway through a drag that began with none, and from that
      // point the drag is extending the selection: dismissing would resize the
      // viewport out from under it.
      if (onSelectableText && hasLiveSelection()) {
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
  }, [pointerCoarse]);
}
