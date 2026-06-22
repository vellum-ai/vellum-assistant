/** Pure helper functions for the pull-to-refresh gesture.
 *
 *  Separated from the React hook (`usePullToRefresh`) so they can be
 *  unit-tested without a component render cycle. The hook wires these
 *  into touch events and React state; these functions own the math. */

/** Drag distance (in raw pixels) at which the refresh commits on
 *  release. Matches `PINNED_THRESHOLD_PX` from the scroll coordinator
 *  for visual consistency. */
export const PULL_THRESHOLD_PX = 64;

/** Distance from the visual bottom (in px) at or below which the
 *  pull-to-refresh gesture is eligible to start. Tighter than
 *  `PINNED_THRESHOLD_PX` so the gesture only fires when the user is
 *  unambiguously at the latest message. */
export const PULL_ELIGIBLE_BOTTOM_DISTANCE_PX = 16;

/** Visual height (in px) the spinner locks at while the refresh is
 *  in flight. */
export const PULL_REFRESH_VISUAL_PX = 48;

export interface PullClassification {
  phase: "ineligible" | "pulling";
  /** 0..1, clamped. */
  progress: number;
  atThreshold: boolean;
}

/** Compute the pull extent (in px) given the touch's starting and
 *  current Y coordinates. At the visual bottom of a flex-col
 *  transcript, the pull-to-refresh gesture is a DOWNWARD finger motion
 *  (clientY increases). Positive extent means the user is pulling
 *  for refresh. */
export function computePullExtent(args: {
  startY: number;
  currentY: number;
}): number {
  return args.currentY - args.startY;
}

/** Distance (in px) from the visual bottom of the transcript. In
 *  flex-col layout this is `max(0, scrollHeight − clientHeight −
 *  scrollTop)`. Clamped at 0 so iOS rubber-band (scrollTop briefly
 *  above max) doesn't report a negative distance. */
export function distanceFromBottom(args: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}): number {
  const max = Math.max(0, args.scrollHeight - args.clientHeight);
  return Math.max(0, max - args.scrollTop);
}

/** Pure classification of the current touch state during a drag.
 *  `dragDistance` is the pull extent — positive means the finger
 *  has moved downward from its start (a real pull); non-positive
 *  means the finger is still or has moved upward (no pull). */
export function classifyPull(args: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  dragDistance: number;
}): PullClassification {
  const dfb = distanceFromBottom(args);
  const eligible = dfb <= PULL_ELIGIBLE_BOTTOM_DISTANCE_PX;
  if (!eligible || args.dragDistance <= 0) {
    return { phase: "ineligible", progress: 0, atThreshold: false };
  }
  const progress = Math.min(1, args.dragDistance / PULL_THRESHOLD_PX);
  return {
    phase: "pulling",
    progress,
    atThreshold: args.dragDistance >= PULL_THRESHOLD_PX,
  };
}

/** Decide whether the threshold-cross haptic should fire on this
 *  classification step, given the per-drag "has fired" flag. */
export function shouldFireThresholdHaptic(args: {
  atThreshold: boolean;
  hasFiredThisDrag: boolean;
}): boolean {
  return args.atThreshold && !args.hasFiredThisDrag;
}

/** Decide whether a new touch should start tracking a pull. The
 *  refresh-in-flight guard lives here. */
export function canStartPull(args: {
  isRefreshing: boolean;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}): boolean {
  if (args.isRefreshing) return false;
  return distanceFromBottom(args) <= PULL_ELIGIBLE_BOTTOM_DISTANCE_PX;
}
