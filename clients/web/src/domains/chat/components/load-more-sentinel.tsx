/**
 * Invisible row that fires `onVisible` when scrolled into view - the
 * load-more trigger for a windowed conversation list that renders its rows
 * directly (LUM-2444).
 *
 * Only the non-virtualized row list needs this: past
 * `CONVERSATION_LIST_VIRTUALIZE_THRESHOLD` rows the list renders through
 * `VirtualList`, whose `endReached` callback is the same trigger without a
 * DOM sentinel. A windowed section normally holds at least a full page and
 * virtualizes; this covers the short-window remainder (optimistic removals
 * shrinking a window below the threshold), where firing immediately on
 * mount is the desired behavior - it backfills the degenerate window to a
 * full page.
 *
 * Fires on every entry into view, not once: the callback is expected to be
 * idempotent while a load is in flight (`loadMoreConversations`
 * guards per section), and re-firing after rows arrive is what pages in the
 * next window when the user keeps scrolling.
 */

import { useEffect, useLayoutEffect, useRef } from "react";

interface LoadMoreSentinelProps {
  onVisible: () => void;
}

export function LoadMoreSentinel({ onVisible }: LoadMoreSentinelProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  // Latest-callback ref, synced in a layout effect (before paint, before the
  // observer effect can read it), so the observer never re-subscribes when
  // the callback identity changes.
  const onVisibleRef = useRef(onVisible);
  useLayoutEffect(() => {
    onVisibleRef.current = onVisible;
  }, [onVisible]);

  useEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        onVisibleRef.current();
      }
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, []);

  return (
    <div
      ref={ref}
      data-slot="load-more-sentinel"
      aria-hidden
      className="h-px"
    />
  );
}
