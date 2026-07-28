import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

import { computeVisualOffset, useEdgeSwipe } from "@/hooks/use-edge-swipe";
import { useEdgeSwipeArbiterStore } from "@/stores/edge-swipe-arbiter-store";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

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

/**
 * Left-edge swipe-to-go-back for mobile pushed/detail pages.
 *
 * Gesture *detection* is delegated to the shared `useEdgeSwipe` engine; this
 * hook owns the *visuals*: it drags the container's `translateX` with the
 * finger, slides the outgoing page off-screen on commit, and reveals the
 * incoming page once the route swap lands.
 *
 * It imperatively owns the `transform`, `opacity`, `transition`, and
 * `willChange` inline styles of the container element — driving them through
 * React state would be too slow for a 60fps drag. The element's other inline
 * styles (e.g. padding) are React-managed and left untouched; callers must
 * not also write these four properties to the same element.
 *
 * While `enabled`, the hook registers as a back-swipe owner in the
 * edge-swipe arbiter so a swipe-to-open-menu gesture on an ancestor layout
 * yields the left edge to back-navigation (see `edge-swipe-arbiter-store`).
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
  const onBackRef = useRef(onBack);
  useLayoutEffect(() => {
    onBackRef.current = onBack;
  }, [onBack]);

  // Set true the instant a swipe commits; the entrance layout effect consumes
  // it on the next `navKey` change so the reveal is synced to the route swap.
  const pendingRevealRef = useRef(false);
  // Timers are tracked so an unmount mid-animation cancels them, and
  // `cancelledRef` short-circuits any already-scheduled callback so nothing
  // mutates a detached node after teardown.
  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const cancelledRef = useRef(false);

  const registerBackOwner = useEdgeSwipeArbiterStore.use.registerBackOwner();
  const unregisterBackOwner =
    useEdgeSwipeArbiterStore.use.unregisterBackOwner();
  useEffect(() => {
    if (!enabled) {return;}
    registerBackOwner();
    return unregisterBackOwner;
  }, [enabled, registerBackOwner, unregisterBackOwner]);

  useEffect(() => {
    cancelledRef.current = false;
    const timers = timersRef.current;
    return () => {
      cancelledRef.current = true;
      for (const id of timers) {clearTimeout(id);}
      timers.clear();
      const el = containerRef.current;
      if (el) {resetTransientStyles(el);}
    };
  }, [containerRef]);

  const scheduleTimeout = (fn: () => void, ms: number) => {
    const id = setTimeout(() => {
      timersRef.current.delete(id);
      if (!cancelledRef.current) {fn();}
    }, ms);
    timersRef.current.add(id);
  };

  const applyOffset = (el: HTMLElement, px: number) => {
    el.style.transform = px === 0 ? "" : `translateX(${px}px)`;
  };

  const snapBack = (el: HTMLElement) => {
    el.style.transition = `transform ${CANCEL_ANIMATION_MS}ms ease-out`;
    applyOffset(el, 0);
    const onEnd = () => {
      el.removeEventListener("transitionend", onEnd);
      resetTransientStyles(el);
    };
    el.addEventListener("transitionend", onEnd, { once: true });
    // Safety fallback if transitionend doesn't fire.
    scheduleTimeout(
      () => resetTransientStyles(el),
      CANCEL_ANIMATION_MS + ANIMATION_FALLBACK_SLACK_MS,
    );
  };

  const runCommitAnimation = (el: HTMLElement) => {
    // Slide the outgoing page off to the right.
    el.style.transition = `transform ${COMMIT_ANIMATION_MS}ms ease-in`;
    applyOffset(el, window.innerWidth);
    let didFinish = false;
    const finish = () => {
      if (didFinish || cancelledRef.current) {return;}
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
          resetTransientStyles(el);
        }
      }, ENTRANCE_ANIMATION_MS * 2);
    };
    el.addEventListener("transitionend", finish, { once: true });
    scheduleTimeout(finish, COMMIT_ANIMATION_MS + ANIMATION_FALLBACK_SLACK_MS);
  };

  useEdgeSwipe({
    enabled,
    onConfirm: () => {
      const el = containerRef.current;
      if (!el) {return;}
      el.style.transition = "none";
      el.style.willChange = "transform";
    },
    onMove: (dx, threshold) => {
      const el = containerRef.current;
      if (!el) {return;}
      applyOffset(el, computeVisualOffset(dx, threshold));
    },
    onCommit: () => {
      const el = containerRef.current;
      if (!el) {
        // The gesture committed before the container mounted (a detail page
        // still on its loading/error branch). There's nothing to slide off,
        // but the arbiter has suppressed the drawer for this owner, so
        // dropping the commit would strand the swipe as a no-op. Navigate
        // back immediately so a committed edge-swipe always resolves to one
        // action.
        onBackRef.current();
        return;
      }
      runCommitAnimation(el);
    },
    onCancel: (animate) => {
      const el = containerRef.current;
      if (!el) {return;}
      if (animate) {
        snapBack(el);
      } else {
        resetTransientStyles(el);
      }
    },
  });

  // Incoming-page entrance. Fires only after a committed swipe (pendingReveal)
  // AND the route swap has committed (navKey changed). The commit handler left
  // the container at the entrance start (off-left, hidden, reflow-committed),
  // so here we just transition it to rest — the outgoing page is already gone,
  // so nothing stale is ever revealed.
  useLayoutEffect(() => {
    if (!pendingRevealRef.current) {return;}
    pendingRevealRef.current = false;
    const el = containerRef.current;
    if (!el) {return;}

    let settled = false;
    const settle = () => {
      if (settled) {return;}
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
