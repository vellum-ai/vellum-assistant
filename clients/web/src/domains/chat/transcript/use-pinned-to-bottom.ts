import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Distance from the bottom (px) at or below which the box counts as pinned to
 * its newest content and auto-follows growth. Generous enough that a
 * sub-line of overshoot on iOS rubber-banding does not un-pin it, tight
 * enough that a deliberate drag up does.
 */
const PINNED_THRESHOLD_PX = 24;

/**
 * Keeps a height-capped scroll box pinned to its newest content while that
 * content grows, the way a credits crawl holds the latest line at the bottom
 * edge. The moment the user scrolls up the box stops following; scrolling
 * back to the bottom re-engages it.
 *
 * Returns a callback ref to attach to the scroll container. The hook owns the
 * element via state so its observers attach the moment the container mounts,
 * which a plain ref object would miss when the box renders conditionally.
 *
 * The container's first element child is the observed content: a wrapper the
 * caller renders inside the scroll box (`ScrollShadow` provides one). Watching
 * the content rather than the container matters because a `max-height` box
 * never resizes once its content overflows.
 */
export function usePinnedToBottom(): (el: HTMLDivElement | null) => void {
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const isPinnedRef = useRef(true);

  const ref = useCallback((el: HTMLDivElement | null) => {
    setScrollEl((prev) => {
      if (el !== prev) {
        isPinnedRef.current = true;
      }
      return el;
    });
  }, []);

  useEffect(() => {
    if (!scrollEl) {
      return;
    }
    const pin = () => {
      // Instant rather than smooth: a smooth scroll on every streamed delta
      // stutters, and its intermediate scroll events would read as the user
      // dragging away from the bottom.
      scrollEl.scrollTo({ top: scrollEl.scrollHeight, behavior: "auto" });
    };
    const classify = () => {
      const maxScrollTop = Math.max(
        0,
        scrollEl.scrollHeight - scrollEl.clientHeight,
      );
      const distanceFromBottom = Math.max(0, maxScrollTop - scrollEl.scrollTop);
      isPinnedRef.current = distanceFromBottom <= PINNED_THRESHOLD_PX;
    };

    scrollEl.addEventListener("scroll", classify, { passive: true });

    const content = scrollEl.firstElementChild;
    const observer =
      content && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => {
            if (isPinnedRef.current) {
              pin();
            }
          })
        : null;
    if (content) {
      observer?.observe(content);
    }
    pin();

    return () => {
      scrollEl.removeEventListener("scroll", classify);
      observer?.disconnect();
    };
  }, [scrollEl]);

  return ref;
}
