/**
 * Headless virtualizer for the subagent timeline.
 *
 * Thin wrapper around `@tanstack/react-virtual`'s `useVirtualizer` that wires
 * up the conventions the timeline needs: an *external* scroll element (the
 * panel's own scroll container, not the list itself), dynamic per-row
 * measurement, a header offset via `scrollMargin`, and stable item keys.
 *
 * This is scaffolding — no component consumes it yet. A later PR will mount it
 * inside `subagent-timeline.tsx`. The dependency lands in the lazily-loaded
 * subagent-panel chunk (see `chat-content-layout.tsx`), not the main bundle.
 */
import {
  measureElement,
  useVirtualizer,
  type Virtualizer,
} from "@tanstack/react-virtual";
import type { RefObject } from "react";

/**
 * Fallback row height (px) used before a row has been measured. A sane guess
 * for a single-line-ish timeline row; real heights are measured on mount via
 * the dynamic `measureElement` so this only affects the initial estimate.
 */
export const DEFAULT_ROW_ESTIMATE = 96;

/** Rows to render beyond the visible window, on each side, to mask scrolling. */
export const OVERSCAN = 6;

/**
 * Compute the `scrollMargin` for the virtualizer: the list's top offset within
 * the scroll container, so virtual positions account for any header/content
 * rendered above the list. Pure (no DOM API beyond reading `offsetTop`) so it
 * is unit-testable without a real layout.
 */
export function computeScrollMargin(listEl: HTMLElement | null): number {
  return listEl?.offsetTop ?? 0;
}

export interface UseTimelineVirtualizerParams {
  /** Number of rows in the timeline. */
  count: number;
  /** Ref to the scroll container (the element that actually scrolls). */
  scrollRef: RefObject<HTMLElement | null>;
  /** Ref to the inner list element, used to offset virtual positions. */
  listRef?: RefObject<HTMLElement | null>;
  /** Stable key for a row index, so measurements survive reorders. */
  getItemKey: (index: number) => string;
  /** Initial per-row height guess (px); defaults to {@link DEFAULT_ROW_ESTIMATE}. */
  estimateSize?: number;
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
  estimateSize,
}: UseTimelineVirtualizerParams): Virtualizer<HTMLElement, HTMLElement> {
  return useVirtualizer<HTMLElement, HTMLElement>({
    count,
    getScrollElement: () => scrollRef.current,
    getItemKey,
    estimateSize: () => estimateSize ?? DEFAULT_ROW_ESTIMATE,
    measureElement,
    overscan: OVERSCAN,
    scrollMargin: computeScrollMargin(listRef?.current ?? null),
  });
}
