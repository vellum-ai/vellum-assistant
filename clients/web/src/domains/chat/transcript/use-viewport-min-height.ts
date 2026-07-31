import { type RefObject, useEffect, useState } from "react";

import { recordUpdate } from "@/lib/commit-pressure";

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
    let lastHeight = node.clientHeight;
    setHeight(lastHeight);

    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(() => {
      const current = scrollContainerRef.current;
      if (!current) {
        return;
      }
      const next = current.clientHeight;
      // The observer fires on width changes too, and the scroll container is
      // resized by anything that reflows the chat pane. Only the height feeds
      // `minHeight`, so bail before scheduling an update React would discard
      // anyway — every queued update is one more commit that can finish with
      // work still pending (see `lib/commit-pressure.ts`).
      if (next === lastHeight) {
        return;
      }
      lastHeight = next;
      recordUpdate("viewport-min-height");
      setHeight(next);
    });

    observer.observe(node);

    return () => {
      observer.disconnect();
    };
  }, [scrollContainerRef]);

  return height;
}
