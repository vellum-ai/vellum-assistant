import { EDGE_ZONE_PX } from "@/hooks/use-edge-swipe";

export interface EdgeSwipeHitZoneProps {
  /** Whether the edge-swipe gesture is active (typically mobile). */
  enabled: boolean;
}

/**
 * Transparent left-edge strip that recovers edge-swipe gestures over content
 * that would otherwise swallow the touch — notably a sandboxed `srcDoc`
 * iframe, whose opaque origin stops touch events from propagating to the
 * `document` listener that `useEdgeSwipe` installs. Sized to the gesture's
 * edge zone and layered above such content so a left-edge touch lands on the
 * host document and arms the gesture.
 *
 * Render it inside a `relative` container that hosts the swallowing element
 * (e.g. alongside an `<iframe>`); it captures only the reserved edge zone, so
 * the rest of the content stays interactive.
 */
export function EdgeSwipeHitZone({ enabled }: EdgeSwipeHitZoneProps) {
  if (!enabled) {
    return null;
  }
  return (
    <div
      aria-hidden
      className="absolute inset-y-0 left-0 z-10"
      style={{ width: EDGE_ZONE_PX }}
    />
  );
}
