import { useCallback, useRef, useState } from "react";
import type { TouchEvent as ReactTouchEvent } from "react";

import { isPointerCoarse } from "@/utils/pointer";

/**
 * Minimum travel (px) on the primary axis to commit a swipe. Below this the drag
 * springs back and no callback fires.
 */
const DEFAULT_COMMIT_THRESHOLD_PX = 80;

/** Travel (px) on either axis before we decide the gesture's direction. */
const DEFAULT_DIRECTION_DEADZONE_PX = 8;

/**
 * If travel on the escape axis exceeds this ratio of primary-axis travel, the
 * gesture is a scroll/pan on the escape axis, not a swipe — we bail so we never
 * fight the browser's own scrolling.
 */
const DEFAULT_ESCAPE_RATIO = 0.8;

/**
 * Damping applied to drag distance once it passes the commit threshold, so the
 * content resists further travel and signals "release to commit" rather than
 * sliding away indefinitely.
 */
const DEFAULT_OVERDRAG_DAMPING = 0.35;

type GestureAxis = "undecided" | "primary" | "escape";

interface SwipeEngineOptions {
  /** Whether the gesture is armed (e.g. overlay is mounted / drawer is open). */
  enabled: boolean;
  /** The axis this gesture tracks as its primary swipe direction. */
  axis: "horizontal" | "vertical";
  /** Minimum travel (px) on the primary axis to commit. Defaults to 80. */
  commitThresholdPx?: number;
  /** Travel (px) on either axis before deciding direction. Defaults to 8. */
  deadzonePx?: number;
  /**
   * Escape-axis travel divided by primary-axis travel, above which we bail.
   * Defaults to 0.8.
   */
  escapeRatio?: number;
  /** Damping applied to drag beyond the commit threshold. Defaults to 0.35. */
  overdragDamping?: number;
  /**
   * When true (default), the handlers are inert on fine-pointer (desktop)
   * devices — the gesture is touch-first.
   */
  touchOnly?: boolean;
  /**
   * Fired on release when the primary-axis travel passes the commit threshold.
   * Receives the signed final delta on the primary axis (positive = right/down,
   * negative = left/up). Use the sign to dispatch direction-specific callbacks.
   */
  onCommit?: (delta: number) => void;
  /**
   * Fired during a live drag with the damped offset (signed, primary axis). The
   * engine also exposes the same value via `dragOffset` state for rendering.
   */
  onMove?: (offset: number) => void;
  /**
   * Fired whenever the gesture state is cleared — on cancel, multi-touch,
   * escape-axis bail, and on release (whether or not a commit fired).
   */
  onReset?: () => void;
}

interface SwipeEngineResult {
  /** Live drag offset (px) on the primary axis, signed. 0 at rest. */
  dragOffset: number;
  /** True while a drag is in progress on the primary axis (disable transitions). */
  isDragging: boolean;
  onTouchStart: (e: ReactTouchEvent) => void;
  onTouchMove: (e: ReactTouchEvent) => void;
  onTouchEnd: (e: ReactTouchEvent) => void;
  onTouchCancel: () => void;
}

/**
 * Generic single-touch swipe state machine shared by the axis-specific swipe
 * hooks. Tracks one touch, disambiguates the gesture's axis against a deadzone
 * and escape ratio, follows the finger with a damped `dragOffset`, and on
 * release commits if travel passed the threshold else springs back. Multi-touch
 * and escape-axis-dominant gestures are abandoned so the browser's own scrolling
 * is never hijacked.
 *
 * The axis-specific hooks ({@link use-swipe-horizontal}, `use-swipe-vertical`)
 * thin-wrap this engine, mapping the signed commit delta to direction callbacks
 * (left/right, down/up) and supplying haptics.
 *
 * @todo `use-gallery-swipe` and `use-swipe-vertical` still carry their own copies
 *   of this state machine. They live on other in-flight branches and can't be
 *   touched here; migrate them to this engine in follow-up PRs once those
 *   branches land.
 */
export function useSwipeEngine({
  enabled,
  axis,
  commitThresholdPx = DEFAULT_COMMIT_THRESHOLD_PX,
  deadzonePx = DEFAULT_DIRECTION_DEADZONE_PX,
  escapeRatio = DEFAULT_ESCAPE_RATIO,
  overdragDamping = DEFAULT_OVERDRAG_DAMPING,
  touchOnly = true,
  onCommit,
  onMove,
  onReset,
}: SwipeEngineOptions): SwipeEngineResult {
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
    resolved: GestureAxis;
    // Latest raw delta (px) on the primary axis, tracked here rather than
    // derived from the rendered `dragOffset` state so the commit decision on
    // touchend reads the true final position — React may batch the last
    // touchmove's state update, and a fast flick's final delta can arrive only
    // on touchend.
    lastDelta: number;
  } | null>(null);

  const reset = useCallback(() => {
    gesture.current = null;
    setDragOffset(0);
    setIsDragging(false);
    onReset?.();
  }, [onReset]);

  const onTouchStart = useCallback(
    (e: ReactTouchEvent) => {
      if (!enabled || (touchOnly && !isTouch)) return;
      // A second finger landing while a gesture is armed cancels the swipe —
      // otherwise a release with no intervening touchmove would let touchend
      // commit from the stale gesture. Full reset, not an early return.
      if (e.touches.length !== 1) {
        reset();
        return;
      }
      const t = e.touches[0]!;
      gesture.current = {
        touchId: t.identifier,
        startX: t.clientX,
        startY: t.clientY,
        resolved: "undecided",
        lastDelta: 0,
      };
    },
    [enabled, touchOnly, isTouch, reset],
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
      const primary = axis === "horizontal" ? dx : dy;
      const escape = axis === "horizontal" ? dy : dx;
      g.lastDelta = primary;

      if (g.resolved === "undecided") {
        if (Math.abs(primary) < deadzonePx && Math.abs(escape) < deadzonePx) {
          return;
        }
        // Escape-axis-dominant → let the gesture be a scroll/pan; stop tracking.
        if (Math.abs(escape) > Math.abs(primary) * escapeRatio) {
          gesture.current = null;
          return;
        }
        g.resolved = "primary";
        setIsDragging(true);
      }

      if (g.resolved !== "primary") return;

      // Re-check escape after arming: a gesture locked to the primary axis at
      // the deadzone can later turn mostly escape-axis (e.g. scrolling list
      // content). Abandon it so incidental primary-axis drift doesn't trigger
      // during a scroll. Once past the commit threshold the swipe is already
      // decided, so stop re-checking.
      if (
        Math.abs(primary) < commitThresholdPx &&
        Math.abs(escape) > Math.abs(primary) * escapeRatio
      ) {
        reset();
        return;
      }

      // Follow the finger, damping travel beyond the commit threshold.
      const sign = Math.sign(primary);
      const abs = Math.abs(primary);
      const damped =
        abs <= commitThresholdPx
          ? abs
          : commitThresholdPx + (abs - commitThresholdPx) * overdragDamping;
      const offset = sign * damped;
      setDragOffset(offset);
      onMove?.(offset);
    },
    [
      axis,
      deadzonePx,
      escapeRatio,
      commitThresholdPx,
      overdragDamping,
      onMove,
      reset,
    ],
  );

  const onTouchEnd = useCallback(
    (e: ReactTouchEvent) => {
      const g = gesture.current;
      if (!g || g.resolved !== "primary") {
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
      const finalDelta = released
        ? axis === "horizontal"
          ? released.clientX - g.startX
          : released.clientY - g.startY
        : g.lastDelta;
      if (Math.abs(finalDelta) >= commitThresholdPx) {
        onCommit?.(finalDelta);
      }
      reset();
    },
    [axis, commitThresholdPx, onCommit, reset],
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
