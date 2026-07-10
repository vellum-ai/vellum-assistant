import { useCallback, useRef, useState } from "react";
import type { TouchEvent as ReactTouchEvent } from "react";

import { haptic } from "@/utils/haptics";
import { isPointerCoarse } from "@/utils/pointer";

/**
 * Minimum horizontal travel (px) to commit a swipe. Below this the drag
 * springs back and no callback fires.
 */
const DEFAULT_COMMIT_THRESHOLD_PX = 80;

/**
 * If vertical travel exceeds this ratio of horizontal travel, the gesture is a
 * vertical scroll, not a horizontal swipe — we bail so we never fight the
 * browser's own scrolling.
 */
const VERTICAL_ESCAPE_RATIO = 0.8;

/** Travel (px) on either axis before we decide the gesture's direction. */
const DIRECTION_DEADZONE_PX = 8;

/**
 * Damping applied to drag distance once it passes the commit threshold, so the
 * content resists further travel and signals "release to commit" rather than
 * sliding away indefinitely.
 */
const OVERDRAG_DAMPING = 0.35;

type GestureAxis = "undecided" | "horizontal" | "vertical";

interface UseSwipeHorizontalArgs {
  /** Whether swiping is possible (e.g. drawer is open and interactive). */
  enabled: boolean;
  /** Fired when a leftward swipe passes the commit threshold. */
  onSwipeLeft?: () => void;
  /** Fired when a rightward swipe passes the commit threshold. */
  onSwipeRight?: () => void;
  /** Minimum horizontal travel (px) to commit. Defaults to 80. */
  commitThresholdPx?: number;
}

interface UseSwipeHorizontalResult {
  /** Live horizontal drag offset (px), positive = right. 0 at rest. */
  dragOffset: number;
  /** True while a horizontal drag is in progress (disable transitions). */
  isDragging: boolean;
  onTouchStart: (e: ReactTouchEvent) => void;
  onTouchMove: (e: ReactTouchEvent) => void;
  onTouchEnd: (e: ReactTouchEvent) => void;
  onTouchCancel: () => void;
}

/**
 * Horizontal swipe gesture detector for touch devices. Tracks a single touch,
 * follows the finger with a live `dragOffset`, and on release commits to a
 * leftward or rightward swipe if travel passed the commit threshold, else
 * springs back. Vertical-dominant gestures are ignored so vertical scrolls and
 * the browser's own scrolling are never hijacked.
 *
 * Complements on-screen buttons — this is the touch-first path (primarily iOS).
 * Modeled on the gesture bookkeeping in {@link use-gallery-swipe}.
 *
 * @todo The touch-tracking state machine below (touchId pinning, axis
 *   disambiguation, damping, commit-vs-spring-back) is duplicated from
 *   {@link use-gallery-swipe} and {@link use-swipe-vertical}. When all
 *   swipe-gesture PRs have landed, extract a shared
 *   `use-swipe-engine` primitive that both horizontal and vertical variants
 *   configure via options. Left as-is here to avoid touching files outside
 *   this PR's scope and destabilizing the other in-flight branches.
 *
 * Only active on coarse-pointer (touch) devices; on desktop the handlers are
 * inert no-ops.
 */
export function useSwipeHorizontal({
  enabled,
  onSwipeLeft,
  onSwipeRight,
  commitThresholdPx = DEFAULT_COMMIT_THRESHOLD_PX,
}: UseSwipeHorizontalArgs): UseSwipeHorizontalResult {
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
    // Latest raw horizontal delta (px), tracked here rather than derived from
    // the rendered `dragOffset` state so the commit decision on touchend reads
    // the true final position — React may batch the last touchmove's state
    // update, and a fast flick's final delta can arrive only on touchend.
    lastDx: number;
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
      // commit from the stale horizontal gesture. Full reset, not an early
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
        lastDx: 0,
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
      g.lastDx = dx;

      if (g.axis === "undecided") {
        if (Math.abs(dx) < DIRECTION_DEADZONE_PX && Math.abs(dy) < DIRECTION_DEADZONE_PX) {
          return;
        }
        // Vertical-dominant → let the gesture be a scroll; stop tracking.
        if (Math.abs(dy) > Math.abs(dx) * VERTICAL_ESCAPE_RATIO) {
          gesture.current = null;
          return;
        }
        g.axis = "horizontal";
        setIsDragging(true);
      }

      if (g.axis !== "horizontal") return;

      // Re-check vertical escape after arming: a gesture locked to horizontal
      // at the deadzone can later turn mostly vertical (e.g. scrolling list
      // content). Abandon it so incidental horizontal drift doesn't trigger
      // during a scroll. Once past the commit threshold the swipe is already
      // decided, so stop re-checking.
      if (
        Math.abs(dx) < commitThresholdPx &&
        Math.abs(dy) > Math.abs(dx) * VERTICAL_ESCAPE_RATIO
      ) {
        reset();
        return;
      }

      // Follow the finger, damping travel beyond the commit threshold.
      const sign = Math.sign(dx);
      const abs = Math.abs(dx);
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
      if (!g || g.axis !== "horizontal") {
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
      const finalDx = released ? released.clientX - g.startX : g.lastDx;
      if (finalDx <= -commitThresholdPx) {
        haptic.light();
        onSwipeLeft?.();
      } else if (finalDx >= commitThresholdPx) {
        haptic.light();
        onSwipeRight?.();
      }
      reset();
    },
    [commitThresholdPx, onSwipeLeft, onSwipeRight, reset],
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