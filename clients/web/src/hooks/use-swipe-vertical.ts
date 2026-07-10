import { useCallback, useRef, useState } from "react";
import type { TouchEvent as ReactTouchEvent } from "react";

import { haptic } from "@/utils/haptics";
import { isPointerCoarse } from "@/utils/pointer";

/**
 * Minimum vertical travel (px) to commit a swipe. Below this the drag springs
 * back and no callback fires. Tuned to feel intentional without demanding a
 * full-height drag, matching the modest commit distances of native
 * swipe-to-dismiss sheets.
 */
const DEFAULT_COMMIT_THRESHOLD_PX = 80;

/**
 * If horizontal travel exceeds this ratio of vertical travel, the gesture is a
 * horizontal pan/scroll, not a vertical swipe — we bail so we never fight the
 * browser's own scrolling.
 */
const HORIZONTAL_ESCAPE_RATIO = 0.8;

/** Travel (px) on either axis before we decide the gesture's direction. */
const DIRECTION_DEADZONE_PX = 8;

/**
 * Damping applied to drag distance once it passes the commit threshold, so the
 * content resists further travel and signals "release to commit" rather than
 * sliding away indefinitely.
 */
const OVERDRAG_DAMPING = 0.35;

type GestureAxis = "undecided" | "vertical" | "horizontal";

interface UseSwipeVerticalArgs {
  /** Whether swiping is possible (e.g. overlay is mounted and interactive). */
  enabled: boolean;
  /** Fired when a downward swipe passes the commit threshold. */
  onSwipeDown?: () => void;
  /** Fired when an upward swipe passes the commit threshold. */
  onSwipeUp?: () => void;
  /** Minimum vertical travel (px) to commit. Defaults to 80. */
  commitThresholdPx?: number;
}

interface UseSwipeVerticalResult {
  /** Live vertical drag offset (px), positive = down. 0 at rest. */
  dragOffset: number;
  /** True while a vertical drag is in progress (disable transitions). */
  isDragging: boolean;
  onTouchStart: (e: ReactTouchEvent) => void;
  onTouchMove: (e: ReactTouchEvent) => void;
  onTouchEnd: (e: ReactTouchEvent) => void;
  onTouchCancel: () => void;
}

/**
 * Vertical swipe gesture detector for touch devices. Tracks a single touch,
 * follows the finger with a live `dragOffset`, and on release commits to a
 * downward or upward swipe if travel passed the commit threshold, else springs
 * back. Horizontal-dominant gestures are ignored so horizontal pans and the
 * browser's own scrolling are never hijacked.
 *
 * Complements on-screen buttons — this is the touch-first path (primarily iOS).
 * Modeled on the gesture bookkeeping in {@link use-gallery-swipe}.
 *
 * Only active on coarse-pointer (touch) devices; on desktop the handlers are
 * inert no-ops.
 */
export function useSwipeVertical({
  enabled,
  onSwipeDown,
  onSwipeUp,
  commitThresholdPx = DEFAULT_COMMIT_THRESHOLD_PX,
}: UseSwipeVerticalArgs): UseSwipeVerticalResult {
  const [dragOffset, setDragOffset] = useState(0);
  const [isDragging, setIsDragging] = useState(false);

  // Evaluated once — on a given device the pointer type doesn't change.
  const [isTouch] = useState(() => isPointerCoarse());

  // Mutable per-gesture state kept in a ref so touchmove/touchend read fresh
  // values without re-subscribing or re-rendering on every move. `touchId`
  // pins the gesture to the finger that started it, so a second finger can't
  // hijack or resume it.
  const gesture = useRef<{
    touchId: number;
    startX: number;
    startY: number;
    axis: GestureAxis;
    // Latest raw vertical delta (px), tracked here rather than derived from
    // the rendered `dragOffset` state so the commit decision on touchend reads
    // the true final position — React may batch the last touchmove's state
    // update, and a fast flick's final delta can arrive only on touchend.
    lastDy: number;
  } | null>(null);

  const reset = useCallback(() => {
    gesture.current = null;
    setDragOffset(0);
    setIsDragging(false);
  }, []);

  const onTouchStart = useCallback(
    (e: ReactTouchEvent) => {
      if (!enabled || !isTouch) return;
      // A second finger landing while a gesture is armed cancels the swipe —
      // otherwise a release with no intervening touchmove would let touchend
      // commit from the stale vertical gesture. Full reset, not an early
      // return.
      if (e.touches.length !== 1) {
        reset();
        return;
      }
      const t = e.touches[0]!;
      gesture.current = {
        touchId: t.identifier,
        startX: t.clientX,
        startY: t.clientY,
        axis: "undecided",
        lastDy: 0,
      };
    },
    [enabled, isTouch, reset],
  );

  const onTouchMove = useCallback(
    (e: ReactTouchEvent) => {
      const g = gesture.current;
      if (!g) return;
      // A second finger landing mid-gesture (e.g. a pinch) cancels the swipe
      // outright — otherwise the stale dragOffset could still commit on the
      // following touchend. Full reset, not an early return.
      if (e.touches.length !== 1) {
        reset();
        return;
      }
      const t = e.touches[0]!;
      // Ignore moves from a different finger than the one that armed the gesture.
      if (t.identifier !== g.touchId) return;
      const dx = t.clientX - g.startX;
      const dy = t.clientY - g.startY;
      g.lastDy = dy;

      if (g.axis === "undecided") {
        if (Math.abs(dx) < DIRECTION_DEADZONE_PX && Math.abs(dy) < DIRECTION_DEADZONE_PX) {
          return;
        }
        // Horizontal-dominant → let the gesture be a pan/scroll; stop tracking.
        if (Math.abs(dx) > Math.abs(dy) * HORIZONTAL_ESCAPE_RATIO) {
          gesture.current = null;
          return;
        }
        g.axis = "vertical";
        setIsDragging(true);
      }

      if (g.axis !== "vertical") return;

      // Re-check horizontal escape after arming: a gesture locked to vertical
      // at the deadzone can later turn mostly horizontal. Abandon it so
      // incidental vertical drift doesn't trigger during a horizontal pan.
      // Once past the commit threshold the swipe is already decided, so stop
      // re-checking.
      if (
        Math.abs(dy) < commitThresholdPx &&
        Math.abs(dx) > Math.abs(dy) * HORIZONTAL_ESCAPE_RATIO
      ) {
        reset();
        return;
      }

      // Follow the finger, damping travel beyond the commit threshold.
      const sign = Math.sign(dy);
      const abs = Math.abs(dy);
      const damped =
        abs <= commitThresholdPx
          ? abs
          : commitThresholdPx + (abs - commitThresholdPx) * OVERDRAG_DAMPING;
      setDragOffset(sign * damped);
    },
    [commitThresholdPx, reset],
  );

  const onTouchEnd = useCallback(
    (e: ReactTouchEvent) => {
      const g = gesture.current;
      if (!g || g.axis !== "vertical") {
        reset();
        return;
      }
      // Another finger is still down: this is a multi-touch/pinch, not a clean
      // release. A second touch landing outside this content wrapper (on modal
      // chrome or the backdrop) never reaches our onTouchStart/onTouchMove to
      // reset the gesture, so guard here too — otherwise lifting the original
      // finger would commit a stale swipe.
      if (e.touches.length > 0) {
        reset();
        return;
      }
      // Decide from the true final delta, not the rendered `dragOffset`: prefer
      // the released touch's position (a fast flick's final move can land only
      // on `changedTouches`), and fall back to the last delta seen in touchmove.
      const released = Array.from(e.changedTouches).find(
        (t) => t.identifier === g.touchId,
      );
      const finalDy = released ? released.clientY - g.startY : g.lastDy;
      if (finalDy >= commitThresholdPx) {
        haptic.light();
        onSwipeDown?.();
      } else if (finalDy <= -commitThresholdPx) {
        haptic.light();
        onSwipeUp?.();
      }
      reset();
    },
    [commitThresholdPx, onSwipeDown, onSwipeUp, reset],
  );

  return {
    dragOffset,
    isDragging,
    onTouchStart,
    onTouchMove,
    onTouchEnd,
    // Browser-initiated cancellation (iOS system gesture, interruption) fires
    // touchcancel, not touchend — route it to the same reset so the content
    // never stays translated with transitions disabled.
    onTouchCancel: reset,
  };
}
