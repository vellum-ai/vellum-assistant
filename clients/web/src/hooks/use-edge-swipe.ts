import { useEffect, useLayoutEffect, useRef } from "react";

import { haptic } from "@/utils/haptics";
import { isPointerCoarse } from "@/utils/pointer";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Width (px) of the transparent recovery strip `EdgeSwipeHitZone` lays over
 * touch-swallowing content (e.g. a sandboxed iframe) so a left-edge touch
 * still reaches the `document` listener. Kept narrow so the covered content
 * stays interactive everywhere outside the strip.
 */
export const EDGE_SWIPE_HIT_ZONE_PX = 20;

/**
 * Fraction of the viewport width, measured from the left edge, within which a
 * touch may arm the gesture. Spanning the left half makes the swipe forgiving
 * rather than demanding a pixel-perfect edge touch, matching the wide
 * activation bands common to iOS-style interactive back gestures (cf.
 * react-navigation's `gestureResponseDistance`).
 */
const ACTIVATION_ZONE_VW_RATIO = 0.5;

/** Minimum horizontal travel (px) to commit the swipe. */
const COMMIT_THRESHOLD_PX = 100;

/**
 * Alternative commit threshold expressed as a fraction of viewport width —
 * whichever of `COMMIT_THRESHOLD_PX` and `viewportWidth * this` is smaller
 * wins, so narrow viewports commit sooner (see `commitThresholdPx`).
 */
const COMMIT_THRESHOLD_VW_RATIO = 0.3;

/**
 * If vertical travel exceeds this ratio of horizontal travel, the gesture is
 * treated as a scroll, not a swipe.
 */
const VERTICAL_ESCAPE_RATIO = 0.7;

/** Minimum travel (px) on either axis before the gesture direction is decided. */
const DEADZONE_PX = 10;

/** Damping applied to drag distance past the commit threshold. */
const OVERDRAG_DAMPING = 0.3;

// ---------------------------------------------------------------------------
// Pure geometry helpers (framework-agnostic, unit-tested in isolation)
// ---------------------------------------------------------------------------

/**
 * The commit threshold in px: the smaller of the fixed `COMMIT_THRESHOLD_PX`
 * and a fraction of the viewport width, so narrow viewports commit sooner.
 */
export function commitThresholdPx(viewportWidth: number): number {
  return Math.min(
    COMMIT_THRESHOLD_PX,
    viewportWidth * COMMIT_THRESHOLD_VW_RATIO,
  );
}

/**
 * Distance from the left edge (px) within which a touch may arm the gesture,
 * derived from the viewport width so the activation band scales with it.
 */
export function activationZonePx(viewportWidth: number): number {
  return viewportWidth * ACTIVATION_ZONE_VW_RATIO;
}

/**
 * Whether the touched element is (or sits inside) a surface that owns
 * horizontal drags for its own text interaction: a text field or
 * contenteditable region (caret placement, e.g. the rich-text document
 * editor), or selectable transcript message text (text selection, marked by
 * `data-message-id`). A widened-band swipe beginning here would otherwise
 * hijack the caret / selection and navigate away, so over these surfaces the
 * gesture stays edge-only.
 */
export function ownsHorizontalTextDrag(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  return (
    target.closest(
      'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [data-message-id]',
    ) !== null
  );
}

/**
 * Whether a touch at `clientX` may arm the gesture, given the viewport width
 * and whether it began on a surface that owns horizontal text drags. Edge
 * touches (within `EDGE_SWIPE_HIT_ZONE_PX`) always arm, preserving deliberate
 * edge swipe-back everywhere; the widened band beyond the edge arms only off
 * text-drag surfaces.
 */
export function shouldArmAt(
  clientX: number,
  viewportWidth: number,
  ownsTextDrag: boolean,
): boolean {
  if (clientX > activationZonePx(viewportWidth)) {
    return false;
  }
  if (ownsTextDrag && clientX > EDGE_SWIPE_HIT_ZONE_PX) {
    return false;
  }
  return true;
}

/** Whether vertical travel dominates enough to treat the gesture as a scroll. */
export function isVerticalEscape(dx: number, dy: number): boolean {
  return Math.abs(dy) > Math.abs(dx) * VERTICAL_ESCAPE_RATIO;
}

export type DirectionDecision = "pending" | "cancel" | "confirm";

/**
 * Classify a not-yet-confirmed gesture from its deltas since touch start:
 * still inside the deadzone (`"pending"`), a scroll or wrong-direction
 * gesture to abandon (`"cancel"`), or a left-edge swipe (`"confirm"`).
 */
export function decideDirection(dx: number, dy: number): DirectionDecision {
  if (Math.abs(dx) < DEADZONE_PX && Math.abs(dy) < DEADZONE_PX) {return "pending";}
  if (isVerticalEscape(dx, dy)) {return "cancel";}
  if (dx <= 0) {return "cancel";}
  return "confirm";
}

/** Visual translateX for a horizontal delta, damped once past the threshold. */
export function computeVisualOffset(dx: number, threshold: number): number {
  if (dx <= threshold) {return dx;}
  return threshold + (dx - threshold) * OVERDRAG_DAMPING;
}

/**
 * Resting-closed translateX (px, ≤ 0) for a full-width drawer panel that
 * slides in from off-screen-left, given the touch's absolute viewport `x`.
 * Anchoring the panel's right edge to the finger's absolute position (rather
 * than the drag delta) keeps the drawer under the finger no matter where in
 * the activation band the swipe began — a delta-based reveal would trail a
 * mid-screen start by the start offset.
 */
export function computeDrawerOffset(x: number, viewportWidth: number): number {
  return Math.min(0, x - viewportWidth);
}

/** Whether a finished gesture traveled far enough to commit. */
export function isCommitted(finalDx: number, threshold: number): boolean {
  return finalDx >= threshold;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UseEdgeSwipeCallbacks {
  /**
   * Fired once the gesture is confirmed as a horizontal left-edge swipe
   * (past the deadzone), before the first `onMove`. Use it to prime the
   * target element for dragging (e.g. disable transitions, set willChange).
   */
  onConfirm?: () => void;
  /**
   * Fired on every confirmed drag frame with the raw horizontal delta (`dx`,
   * always > 0), the current commit `threshold`, and the touch's absolute
   * viewport position (`x`, i.e. `clientX`). Consumers own the visual mapping —
   * use `dx` with `computeVisualOffset` for a delta-tracked translateX, or `x`
   * with `computeDrawerOffset` to anchor an element to the finger.
   */
  onMove: (dx: number, threshold: number, x: number) => void;
  /** Fired when a confirmed gesture is released past the commit threshold. */
  onCommit: (finalDx: number, threshold: number) => void;
  /**
   * Fired when the gesture ends without committing. `animate` is `true` when
   * the gesture had been confirmed (the element is displaced and should snap
   * back with a transition) and `false` when it never left the deadzone (a
   * silent cleanup with nothing to animate).
   */
  onCancel: (animate: boolean) => void;
}

export interface UseEdgeSwipeArgs extends UseEdgeSwipeCallbacks {
  /** Whether the gesture is enabled. Gated per-touch, so flipping this mid-drag is safe. */
  enabled: boolean;
}

interface DragState {
  touchId: number;
  startX: number;
  startY: number;
  /** Whether the gesture has been confirmed as horizontal (past deadzone). */
  confirmed: boolean;
  hasFiredHaptic: boolean;
}

function findTouch(list: TouchList, id: number): Touch | null {
  for (let i = 0; i < list.length; i += 1) {
    const t = list[i];
    if (t && t.identifier === id) {return t;}
  }
  return null;
}

/**
 * Framework-agnostic left-edge swipe detector: the shared engine behind
 * swipe-to-go-back (`useEdgeSwipeBack`) and swipe-to-open-menu
 * (`useEdgeSwipeDrawer`). It owns gesture *detection* only — edge-zone
 * arming, deadzone, horizontal/vertical direction decision, mid-gesture
 * vertical-escape, the commit threshold, and the threshold-crossing haptic —
 * and delegates all visuals to the consumer via callbacks.
 *
 * Touch listeners are attached to `document` (passive) so the full viewport
 * edge is reachable regardless of ancestor padding, and are installed once on
 * mount rather than being keyed on `enabled`: committing a swipe often flips
 * `enabled` to false, and tearing the listeners down mid-gesture would strand
 * an in-flight commit. The gesture is instead gated per-touch through
 * `enabledRef`, and the latest callbacks are read from a ref so their
 * closures never go stale.
 *
 * Passive listeners never call `preventDefault()`, so native scrolling stays
 * smooth; `isVerticalEscape` is the mitigation, abandoning the gesture as soon
 * as vertical travel dominates. (In the iOS WKWebView shell there is no
 * browser back-gesture to conflict with.)
 */
export function useEdgeSwipe({
  enabled,
  onConfirm,
  onMove,
  onCommit,
  onCancel,
}: UseEdgeSwipeArgs): void {
  const dragRef = useRef<DragState | null>(null);
  const enabledRef = useRef(enabled);
  const callbacksRef = useRef<UseEdgeSwipeCallbacks>({
    onConfirm,
    onMove,
    onCommit,
    onCancel,
  });
  useLayoutEffect(() => {
    enabledRef.current = enabled;
    callbacksRef.current = { onConfirm, onMove, onCommit, onCancel };
  });

  useEffect(() => {
    if (!isPointerCoarse()) {return;}

    const commitThreshold = () => commitThresholdPx(window.innerWidth);

    const cancel = (animate: boolean) => {
      dragRef.current = null;
      callbacksRef.current.onCancel(animate);
    };

    const handleTouchStart = (event: TouchEvent) => {
      if (!enabledRef.current) {return;}
      if (dragRef.current) {return;}
      if (event.touches.length !== 1) {return;}
      const touch = event.touches[0];
      if (!touch) {return;}
      if (
        !shouldArmAt(
          touch.clientX,
          window.innerWidth,
          ownsHorizontalTextDrag(event.target),
        )
      ) {
        return;
      }

      dragRef.current = {
        touchId: touch.identifier,
        startX: touch.clientX,
        startY: touch.clientY,
        confirmed: false,
        hasFiredHaptic: false,
      };
    };

    const handleTouchMove = (event: TouchEvent) => {
      const drag = dragRef.current;
      if (!drag) {return;}
      if (event.touches.length > 1) {
        cancel(false);
        return;
      }

      const touch = findTouch(event.touches, drag.touchId);
      if (!touch) {return;}

      const dx = touch.clientX - drag.startX;
      const dy = touch.clientY - drag.startY;

      if (!drag.confirmed) {
        const decision = decideDirection(dx, dy);
        if (decision === "pending") {return;}
        if (decision === "cancel") {
          cancel(false);
          return;
        }
        drag.confirmed = true;
        callbacksRef.current.onConfirm?.();
      }

      const threshold = commitThreshold();

      // Cancel if vertical travel becomes excessive mid-gesture.
      if (isVerticalEscape(dx, dy) && dx < threshold) {
        cancel(true);
        return;
      }

      // Haptic at threshold crossing.
      if (dx >= threshold && !drag.hasFiredHaptic) {
        drag.hasFiredHaptic = true;
        void haptic.light();
      }

      callbacksRef.current.onMove(dx, threshold, touch.clientX);
    };

    const handleTouchEnd = (event: TouchEvent) => {
      const drag = dragRef.current;
      if (!drag) {return;}

      const touch = findTouch(event.changedTouches, drag.touchId);
      const finalDx = touch ? touch.clientX - drag.startX : 0;
      const threshold = commitThreshold();

      if (drag.confirmed && isCommitted(finalDx, threshold)) {
        dragRef.current = null;
        callbacksRef.current.onCommit(finalDx, threshold);
      } else if (drag.confirmed) {
        cancel(true);
      } else {
        cancel(false);
      }
    };

    const handleTouchCancel = () => {
      const confirmed = dragRef.current?.confirmed ?? false;
      cancel(confirmed);
    };

    document.addEventListener("touchstart", handleTouchStart, { passive: true });
    document.addEventListener("touchmove", handleTouchMove, { passive: true });
    document.addEventListener("touchend", handleTouchEnd, { passive: true });
    document.addEventListener("touchcancel", handleTouchCancel, {
      passive: true,
    });

    return () => {
      dragRef.current = null;
      document.removeEventListener("touchstart", handleTouchStart);
      document.removeEventListener("touchmove", handleTouchMove);
      document.removeEventListener("touchend", handleTouchEnd);
      document.removeEventListener("touchcancel", handleTouchCancel);
    };
  }, []);
}
