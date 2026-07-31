import { EDGE_SWIPE_HIT_ZONE_PX } from "@/hooks/use-edge-swipe";

export interface EdgeSwipeHitZoneProps {
  /** Whether the edge-swipe gesture is active (typically mobile). */
  enabled: boolean;
}

/**
 * Transparent left-edge strip that recovers edge-swipe gestures over content
 * that would otherwise swallow the touch — notably a sandboxed `srcDoc`
 * iframe, whose opaque origin stops touch events from propagating to the
 * `document` listener that `useEdgeSwipe` installs. Layered above such content
 * so a left-edge touch lands on the host document and arms the gesture.
 *
 * The strip is intentionally narrow (`EDGE_SWIPE_HIT_ZONE_PX`) rather than
 * spanning the full activation band: over an interactive embedded surface it
 * must reserve as little of the touch area as possible, so swipe-back here is
 * edge-only while the rest of the content stays interactive. Render it inside
 * a `relative` container that hosts the swallowing element (e.g. alongside an
 * `<iframe>`).
 */
export function EdgeSwipeHitZone({ enabled }: EdgeSwipeHitZoneProps) {
  if (!enabled) {
    return null;
  }
  return (
    <div
      aria-hidden
      className="absolute inset-y-0 left-0 z-10"
      style={{ width: EDGE_SWIPE_HIT_ZONE_PX }}
    />
  );
}
