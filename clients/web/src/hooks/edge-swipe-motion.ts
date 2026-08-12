/**
 * Shared release motion for the edge-swipe gestures.
 *
 * Swipe-to-open-menu (`useEdgeSwipeDrawer`) and swipe-to-go-back
 * (`useEdgeSwipeBack`) both hand a released finger off to the same slide, so
 * the duration and easing live here instead of being restated per hook where
 * they drift apart.
 */

/** Duration (ms) of the slide a released finger hands off to. */
export const EDGE_SWIPE_SLIDE_MS = 200;

/**
 * Duration (ms) of the outgoing half of a two-phase transition. Shorter than
 * the incoming half: the outgoing element travels a full viewport width while
 * the incoming one travels a fraction of it, so matching durations would read
 * as two different speeds.
 */
export const EDGE_SWIPE_EXIT_MS = 150;

/**
 * Easing for every released-finger slide. Decelerating throughout, so the
 * element keeps the momentum the finger gave it. An accelerating curve stalls
 * for the first frames after release, which reads as lag.
 */
export const EDGE_SWIPE_EASING = "ease-out";

/** Slack (ms) added to a duration for its `transitionend` fallback timer. */
export const EDGE_SWIPE_FALLBACK_SLACK_MS = 50;
