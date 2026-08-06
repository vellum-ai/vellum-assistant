import { type RefObject, useEffect, useState } from "react";

import { recordUpdate } from "@/lib/commit-pressure";

/**
 * Whether the transcript scroll container has no *real* overflow to hide
 * its scrollbar for: "real" meaning overflow that would exist even
 * without the anchor-pin spacer (see `LatestTurnRow`'s `minHeight:
 * viewportMinHeight` wrapper in `transcript.tsx`).
 *
 * That spacer pads the latest turn out to a full viewport so the anchor
 * message pins to the top instead of hugging the bottom. It routinely
 * makes `scrollHeight` exceed `clientHeight` even when there's nothing
 * meaningful below the fold, which puts a permanent scrollbar on screen.
 * Subtracting the spacer's own rendered height from the total undoes
 * exactly that artificial overshoot: `spacerHeight` is the flex-1 child's
 * actual size, i.e. `max(0, viewportMinHeight - naturalAnchorHeight)`
 * (flexbox already computed it for us), so `scrollHeight - spacerHeight`
 * is the height the content would occupy without the pin spacer.
 *
 * Only `scrollContainerRef` and `contentRef` need observing: the spacer is
 * a descendant of `contentRef`, so any change in its height already
 * changes `contentRef`'s own box size and fires that observation. This
 * recomputes on streaming growth too, so the scrollbar reappears the
 * moment genuine content pushes past one viewport.
 */
export function useHideIdleScrollbar(
  scrollContainerRef: RefObject<HTMLElement | null>,
  contentRef: RefObject<HTMLElement | null>,
  spacerRef: RefObject<HTMLElement | null>,
): boolean {
  const [hide, setHide] = useState(false);

  useEffect(() => {
    const scrollNode = scrollContainerRef.current;
    const contentNode = contentRef.current;
    if (!scrollNode || !contentNode) {
      return;
    }

    const recompute = () => {
      const spacerHeight = spacerRef.current?.clientHeight ?? 0;
      const realHeight = contentNode.scrollHeight - spacerHeight;
      const next = realHeight <= scrollNode.clientHeight;
      setHide((prev) => {
        if (prev === next) {
          return prev;
        }
        recordUpdate("hide-idle-scrollbar");
        return next;
      });
    };

    recompute();

    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(recompute);
    observer.observe(scrollNode);
    observer.observe(contentNode);

    return () => {
      observer.disconnect();
    };
  }, [scrollContainerRef, contentRef, spacerRef]);

  return hide;
}
