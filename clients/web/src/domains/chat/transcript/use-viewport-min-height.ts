
import { type RefObject, useEffect, useState } from "react";

/**
 * Track the current `clientHeight` of a scroll container via `ResizeObserver`
 * and re-render subscribers on every resize.
 *
 * Used by `LatestTurnRow` to size its `minHeight` to the viewport so the anchor
 * user message pins to the top while the response renders below it without
 * hugging the bottom of the scroll area.
 *
 * Why `ResizeObserver` directly (no `requestAnimationFrame` wrapper):
 *   TanStack Virtual's docs explicitly recommend running observers in the
 *   non-RAF mode by default. The RAF wrapper can coalesce resize events in
 *   ways that introduce a frame of stale height, which would leak visible
 *   layout shift into the transcript the first time the latest-turn row is
 *   measured. We intentionally keep this hook simple and synchronous.
 */
export function useViewportMinHeight(
  scrollContainerRef: RefObject<HTMLElement | null>,
): number {
  const [height, setHeight] = useState<number>(0);

  useEffect(() => {
    const node = scrollContainerRef.current;
    if (!node) {
      return;
    }

    // Seed with the current height so the first paint has a reasonable value
    // even if `ResizeObserver` fires asynchronously.
    setHeight(node.clientHeight);

    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(() => {
      const current = scrollContainerRef.current;
      if (!current) return;
      setHeight(current.clientHeight);
    });

    observer.observe(node);

    return () => {
      observer.disconnect();
    };
  }, [scrollContainerRef]);

  return height;
}
