/**
 * Headless virtualizer for the subagent timeline.
 *
 * Thin wrapper around `@tanstack/react-virtual`'s `useVirtualizer` that wires
 * up the conventions the timeline needs: an *external* scroll element (the
 * panel's own scroll container, not the list itself), dynamic per-row
 * measurement, a header offset via `scrollMargin`, and stable item keys.
 *
 * Consumed by `subagent-timeline.tsx`. The dependency lands in the lazily-loaded
 * subagent-panel chunk (see `chat-content-layout.tsx`), not the main bundle.
 */
import {
  measureElement,
  useVirtualizer,
  type Virtualizer,
} from "@tanstack/react-virtual";
import { useLayoutEffect, useState, type RefObject } from "react";

/**
 * Fallback row height (px) used before a row has been measured. A sane guess
 * for a single-line-ish timeline row; real heights are measured on mount via
 * the dynamic `measureElement` so this only affects the initial estimate.
 */
const DEFAULT_ROW_ESTIMATE = 96;

/** Rows to render beyond the visible window, on each side, to mask scrolling. */
const OVERSCAN = 6;

/**
 * Compute the `scrollMargin` for the virtualizer: the list's top offset within
 * the scroll container's content, so virtual positions account for any header
 * rendered above the list.
 *
 * Measured *relative to the scroll element* rather than via `offsetTop`:
 * `offsetTop` is relative to the nearest positioned ancestor, which is often
 * not the scroll container (the panel body is a static `overflow-y-auto` div),
 * so using it would subtract the wrong margin and shift every row. The gap
 * between the two box tops plus the container's current `scrollTop` gives the
 * list's stable offset within the scrolled content. Returns 0 until both
 * elements are mounted.
 */
export function computeScrollMargin(
  listEl: HTMLElement | null,
  scrollEl: HTMLElement | null,
): number {
  if (!listEl || !scrollEl) return 0;
  return (
    listEl.getBoundingClientRect().top -
    scrollEl.getBoundingClientRect().top +
    scrollEl.scrollTop
  );
}

interface UseTimelineVirtualizerParams {
  /** Number of rows in the timeline. */
  count: number;
  /** Ref to the scroll container (the element that actually scrolls). */
  scrollRef: RefObject<HTMLElement | null>;
  /** Ref to the inner list element, used to offset virtual positions. */
  listRef?: RefObject<HTMLElement | null>;
  /** Stable key for a row index, so measurements survive reorders. */
  getItemKey: (index: number) => string;
}

/**
 * Wrap `useVirtualizer` for the subagent timeline. The returned virtualizer's
 * `measureElement` should be attached to each row's `ref` to enable dynamic
 * measurement.
 */
export function useTimelineVirtualizer({
  count,
  scrollRef,
  listRef,
  getItemKey,
}: UseTimelineVirtualizerParams): Virtualizer<HTMLElement, HTMLElement> {
  // Resolve `scrollMargin` in a layout effect (not during render): it reads
  // layout via `getBoundingClientRect`, and doing that on every render would
  // force a synchronous reflow each scroll frame in a component whose whole
  // point is rendering performance. Captured into state on mount and whenever
  // the scroll/list elements resize, so the first committed paint already uses
  // the correct offset instead of 0.
  const [scrollMargin, setScrollMargin] = useState(0);
  useLayoutEffect(() => {
    const recompute = () =>
      setScrollMargin(computeScrollMargin(listRef?.current ?? null, scrollRef.current));
    recompute();
    const scrollEl = scrollRef.current;
    if (!scrollEl || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(recompute);
    observer.observe(scrollEl);
    const listEl = listRef?.current;
    if (listEl) observer.observe(listEl);
    return () => observer.disconnect();
    // `count` is included so the margin recomputes when the list mounts/changes
    // (e.g. the empty-state → populated transition mounts the list element).
  }, [scrollRef, listRef, count]);

  return useVirtualizer<HTMLElement, HTMLElement>({
    count,
    getScrollElement: () => scrollRef.current,
    getItemKey,
    estimateSize: () => DEFAULT_ROW_ESTIMATE,
    measureElement,
    overscan: OVERSCAN,
    scrollMargin,
  });
}
