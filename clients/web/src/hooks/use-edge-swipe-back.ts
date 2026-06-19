import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

import { haptic } from "@/utils/haptics";
import { isPointerCoarse } from "@/utils/pointer";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Horizontal zone from the left edge (px) where a touch is eligible. */
const EDGE_ZONE_PX = 20;

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

/** Duration (ms) for the cancel/snap-back animation. */
const CANCEL_ANIMATION_MS = 200;

/** Duration (ms) for the commit/slide-off-screen animation. */
const COMMIT_ANIMATION_MS = 180;

/** Duration (ms) for the incoming page entrance animation. */
const ENTRANCE_ANIMATION_MS = 200;

/** Fraction of viewport width the incoming page slides in from. */
const ENTRANCE_OFFSET_RATIO = 0.25;

/** Slack (ms) added to animation durations for the safety-fallback timers. */
const ANIMATION_FALLBACK_SLACK_MS = 50;

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

/** Whether vertical travel dominates enough to treat the gesture as a scroll. */
export function isVerticalEscape(dx: number, dy: number): boolean {
  return Math.abs(dy) > Math.abs(dx) * VERTICAL_ESCAPE_RATIO;
}

export type DirectionDecision = "pending" | "cancel" | "confirm";

/**
 * Classify a not-yet-confirmed gesture from its deltas since touch start:
 * still inside the deadzone (`"pending"`), a scroll or wrong-direction
 * gesture to abandon (`"cancel"`), or a left-edge back-swipe (`"confirm"`).
 */
export function decideDirection(dx: number, dy: number): DirectionDecision {
  if (Math.abs(dx) < DEADZONE_PX && Math.abs(dy) < DEADZONE_PX) return "pending";
  if (isVerticalEscape(dx, dy)) return "cancel";
  if (dx <= 0) return "cancel";
  return "confirm";
}

/** Visual translateX for a horizontal delta, damped once past the threshold. */
export function computeVisualOffset(dx: number, threshold: number): number {
  if (dx <= threshold) return dx;
  return threshold + (dx - threshold) * OVERDRAG_DAMPING;
}

/** Whether a finished gesture traveled far enough to commit the back-nav. */
export function isCommitted(finalDx: number, threshold: number): boolean {
  return finalDx >= threshold;
}

/** Clear the four inline styles this hook owns, returning the element to rest. */
function resetTransientStyles(el: HTMLElement): void {
  el.style.transition = "";
  el.style.transform = "";
  el.style.willChange = "";
  el.style.opacity = "";
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UseEdgeSwipeBackArgs {
  /** Ref to the element that receives the translateX visual transform. */
  containerRef: RefObject<HTMLElement | null>;
  /** Callback fired when the swipe is committed. */
  onBack: () => void;
  /** Whether the gesture is enabled. */
  enabled: boolean;
  /**
   * A value that changes once `onBack()` has navigated and the new page has
   * committed to the DOM (pass the router pathname). The incoming-page
   * entrance animation is deferred until this changes — driving it off a
   * timer instead would start the reveal before the route swap commits and
   * briefly show the outgoing page.
   */
  navKey: string;
}

interface DragState {
  touchId: number;
  startX: number;
  startY: number;
  /** Whether the gesture has been confirmed as horizontal (past deadzone). */
  confirmed: boolean;
  hasFiredHaptic: boolean;
}

/**
 * Detects left-edge swipe gestures and triggers a back-navigation callback.
 *
 * Touch listeners are attached to `document` so the full viewport edge is
 * reachable regardless of CSS padding on ancestor elements. The container
 * ref is used only for applying the visual transform.
 *
 * The hook imperatively owns the `transform`, `opacity`, `transition`, and
 * `willChange` inline styles of the container element — driving them through
 * React state would be too slow for a 60fps drag. The element's other inline
 * styles (e.g. padding) are React-managed and left untouched; callers must
 * not also write these four properties to the same element.
 *
 * The effect is intentionally keyed on `containerRef` only, NOT `enabled` —
 * the gesture is gated per-touch via `enabledRef`. Committing a swipe
 * navigates, which flips `enabled` to false; if the effect were keyed on
 * `enabled` that teardown would fire mid-commit and cancel the in-flight
 * slide-off animation (the page would snap off with no transition).
 *
 * The incoming-page entrance runs in a separate layout effect keyed on
 * `navKey`, so it fires only once the new route has committed to the DOM —
 * never revealing the outgoing page mid-transition.
 */
export function useEdgeSwipeBack({
  containerRef,
  onBack,
  enabled,
  navKey,
}: UseEdgeSwipeBackArgs): void {
  const dragRef = useRef<DragState | null>(null);
  const onBackRef = useRef(onBack);
  const enabledRef = useRef(enabled);
  // Set true the instant a swipe commits; the entrance layout effect consumes
  // it on the next `navKey` change so the reveal is synced to the route swap.
  const pendingRevealRef = useRef(false);
  useLayoutEffect(() => {
    onBackRef.current = onBack;
    enabledRef.current = enabled;
  }, [onBack, enabled]);

  useEffect(() => {
    if (!isPointerCoarse()) return;

    const el = containerRef.current;
    if (!el) return;

    // Cleanup only runs on unmount (the effect is not keyed on `enabled`), so
    // an in-flight commit slide-off survives the navigation that disables the
    // gesture. Every timer is tracked and cancelled on unmount, and
    // `cancelled` short-circuits any already-scheduled callback, so nothing
    // mutates a detached node after teardown.
    const timers = new Set<ReturnType<typeof setTimeout>>();
    let cancelled = false;

    const scheduleTimeout = (fn: () => void, ms: number) => {
      const id = setTimeout(() => {
        timers.delete(id);
        if (!cancelled) fn();
      }, ms);
      timers.add(id);
    };

    const clearTransientStyles = () => resetTransientStyles(el);

    const commitThreshold = () => commitThresholdPx(window.innerWidth);

    const applyOffset = (px: number) => {
      el.style.transform = px === 0 ? "" : `translateX(${px}px)`;
    };

    const findTouch = (list: TouchList, id: number): Touch | null => {
      for (let i = 0; i < list.length; i += 1) {
        const t = list[i];
        if (t && t.identifier === id) return t;
      }
      return null;
    };

    const reset = (animate: boolean) => {
      dragRef.current = null;
      if (animate) {
        el.style.transition = `transform ${CANCEL_ANIMATION_MS}ms ease-out`;
        applyOffset(0);
        const onEnd = () => {
          el.removeEventListener("transitionend", onEnd);
          clearTransientStyles();
        };
        el.addEventListener("transitionend", onEnd, { once: true });
        // Safety fallback if transitionend doesn't fire.
        scheduleTimeout(
          clearTransientStyles,
          CANCEL_ANIMATION_MS + ANIMATION_FALLBACK_SLACK_MS,
        );
      } else {
        clearTransientStyles();
      }
    };

    const runCommitAnimation = () => {
      // Slide the outgoing page off to the right.
      el.style.transition = `transform ${COMMIT_ANIMATION_MS}ms ease-in`;
      applyOffset(window.innerWidth);
      let didFinish = false;
      const finish = () => {
        if (didFinish || cancelled) return;
        didFinish = true;
        el.removeEventListener("transitionend", finish);

        // Hold the page at the entrance start (off to the left, hidden) and
        // navigate. The reveal is NOT animated here — it's handed off to the
        // `navKey` layout effect, which fires only once the route swap has
        // committed. Animating on a timer would start fading the *outgoing*
        // page back in before the new content mounts (the flash). Forcing a
        // reflow commits this start state as the transition origin.
        const entranceOffset = -(window.innerWidth * ENTRANCE_OFFSET_RATIO);
        el.style.transition = "none";
        el.style.transform = `translateX(${entranceOffset}px)`;
        el.style.opacity = "0";
        void el.offsetWidth;
        pendingRevealRef.current = true;
        onBackRef.current();

        // Safety net: if the navigation never commits (navKey never changes),
        // don't leave the page stuck hidden — fall back to resting state.
        scheduleTimeout(() => {
          if (pendingRevealRef.current) {
            pendingRevealRef.current = false;
            clearTransientStyles();
          }
        }, ENTRANCE_ANIMATION_MS * 2);
      };
      el.addEventListener("transitionend", finish, { once: true });
      scheduleTimeout(finish, COMMIT_ANIMATION_MS + ANIMATION_FALLBACK_SLACK_MS);
    };

    // Listen on document so touches at the viewport edge are captured even
    // when the container is inset by parent padding.
    const handleTouchStart = (event: TouchEvent) => {
      if (!enabledRef.current) return;
      if (dragRef.current) return;
      if (event.touches.length !== 1) return;
      const touch = event.touches[0];
      if (!touch) return;

      if (touch.clientX > EDGE_ZONE_PX) return;

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
      if (!drag) return;
      if (event.touches.length > 1) {
        reset(false);
        return;
      }

      const touch = findTouch(event.touches, drag.touchId);
      if (!touch) return;

      const dx = touch.clientX - drag.startX;
      const dy = touch.clientY - drag.startY;

      if (!drag.confirmed) {
        const decision = decideDirection(dx, dy);
        if (decision === "pending") return;
        if (decision === "cancel") {
          reset(false);
          return;
        }
        drag.confirmed = true;
        el.style.transition = "none";
        el.style.willChange = "transform";
      }

      const threshold = commitThreshold();

      // Cancel if vertical travel becomes excessive mid-gesture.
      if (isVerticalEscape(dx, dy) && dx < threshold) {
        reset(true);
        return;
      }

      const visualOffset = computeVisualOffset(dx, threshold);

      // Haptic at threshold crossing.
      if (dx >= threshold && !drag.hasFiredHaptic) {
        drag.hasFiredHaptic = true;
        void haptic.light();
      }

      applyOffset(visualOffset);
    };

    const handleTouchEnd = (event: TouchEvent) => {
      const drag = dragRef.current;
      if (!drag) return;

      const touch = findTouch(event.changedTouches, drag.touchId);
      const finalDx = touch ? touch.clientX - drag.startX : 0;

      const committed =
        drag.confirmed && isCommitted(finalDx, commitThreshold());

      if (committed) {
        dragRef.current = null;
        runCommitAnimation();
      } else if (drag.confirmed) {
        // Animate back to resting position.
        reset(true);
      } else {
        // Gesture never confirmed — clean up silently.
        reset(false);
      }
    };

    const handleTouchCancel = () => {
      if (dragRef.current?.confirmed) {
        reset(true);
      } else {
        reset(false);
      }
    };

    // Passive listeners: the gesture is a purely visual overlay and never
    // calls preventDefault(), so `passive: true` keeps scrolling smooth. The
    // tradeoff is we can't suppress native scroll/selection under the moving
    // shell — `isVerticalEscape` is the mitigation, abandoning the gesture as
    // soon as vertical travel dominates. (In the iOS WKWebView shell there is
    // no browser back-gesture to conflict with.)
    document.addEventListener("touchstart", handleTouchStart, {
      passive: true,
    });
    document.addEventListener("touchmove", handleTouchMove, { passive: true });
    document.addEventListener("touchend", handleTouchEnd, { passive: true });
    document.addEventListener("touchcancel", handleTouchCancel, {
      passive: true,
    });

    return () => {
      cancelled = true;
      for (const id of timers) clearTimeout(id);
      timers.clear();
      dragRef.current = null;
      document.removeEventListener("touchstart", handleTouchStart);
      document.removeEventListener("touchmove", handleTouchMove);
      document.removeEventListener("touchend", handleTouchEnd);
      document.removeEventListener("touchcancel", handleTouchCancel);
      clearTransientStyles();
    };
  }, [containerRef]);

  // Incoming-page entrance. Fires only after a committed swipe (pendingReveal)
  // AND the route swap has committed (navKey changed). The commit handler left
  // the container at the entrance start (off-left, hidden, reflow-committed),
  // so here we just transition it to rest — the outgoing page is already gone,
  // so nothing stale is ever revealed.
  useLayoutEffect(() => {
    if (!pendingRevealRef.current) return;
    pendingRevealRef.current = false;
    const el = containerRef.current;
    if (!el) return;

    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      el.removeEventListener("transitionend", settle);
      resetTransientStyles(el);
    };

    el.style.transition = `transform ${ENTRANCE_ANIMATION_MS}ms ease-out, opacity ${ENTRANCE_ANIMATION_MS}ms ease-out`;
    el.style.transform = "";
    el.style.opacity = "";
    el.addEventListener("transitionend", settle, { once: true });
    // Fallback if transitionend never fires; `settle` is idempotent so a late
    // fire after a normal end is a no-op.
    const fallbackId = setTimeout(
      settle,
      ENTRANCE_ANIMATION_MS + ANIMATION_FALLBACK_SLACK_MS,
    );

    return () => {
      clearTimeout(fallbackId);
      el.removeEventListener("transitionend", settle);
      resetTransientStyles(el);
    };
  }, [navKey, containerRef]);
}
