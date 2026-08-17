import { type RefObject, useEffect, useState } from "react";

/**
 * Slack before a scroll offset counts as content hidden above the top edge.
 * Sub-pixel offsets survive a zoomed viewport and an elastic overscroll, and
 * none of them hide a line worth fading.
 */
const TOP_CLIP_TOLERANCE_PX = 1;

export interface TopClipMetrics {
  /** How far the viewport has been scrolled down from the top of its content. */
  scrollTopPx: number;
}

/**
 * Whether a scroll viewport currently hides content above its top edge, which
 * a fade over that edge answers to.
 */
export function hasContentAboveViewport(metrics: TopClipMetrics): boolean {
  return metrics.scrollTopPx > TOP_CLIP_TOLERANCE_PX;
}

/**
 * Tracks {@link hasContentAboveViewport} for a scroll container.
 *
 * Where a viewport sits in its own scroll moves under the user with no render
 * behind it, so the answer is read back off the element: on every scroll, and
 * whenever the container's box changes, which is what the soft keyboard does to
 * it. Written only when the verdict flips, so a flick through the transcript
 * stays off the render path.
 *
 * `containerKey` re-binds the listeners when the caller replaces the container
 * element itself rather than mutating it: the transcript keys its scroll
 * container on the conversation, so switching threads hands back a new node
 * that a ref alone would never report.
 */
export function useContentAboveViewport(
  scrollContainerRef: RefObject<HTMLElement | null>,
  enabled: boolean,
  containerKey?: string | null,
): boolean {
  const [hasContentAbove, setHasContentAbove] = useState(false);

  useEffect(() => {
    const node = scrollContainerRef.current;
    if (!node || !enabled) {
      setHasContentAbove((prev) => (prev ? false : prev));
      return;
    }

    const recompute = () => {
      const next = hasContentAboveViewport({ scrollTopPx: node.scrollTop });
      setHasContentAbove((prev) => (prev === next ? prev : next));
    };

    recompute();
    node.addEventListener("scroll", recompute, { passive: true });
    const observer =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(recompute)
        : null;
    observer?.observe(node);

    return () => {
      node.removeEventListener("scroll", recompute);
      observer?.disconnect();
    };
  }, [containerKey, enabled, scrollContainerRef]);

  return hasContentAbove;
}
