import {
  useImperativeHandle,
  useMemo,
  useRef,
  type Key,
  type ReactNode,
  type Ref,
} from "react";
import {
  Virtuoso,
  type FollowOutput,
  type IndexLocationWithAlign,
  type VirtuosoHandle,
} from "react-virtuoso";

import { cn } from "../../utils/cn";

/**
 * Virtualized list primitive — a thin wrapper over `react-virtuoso`'s
 * `Virtuoso` that renders only the items in (and near) the viewport.
 *
 * Supports the behaviours streaming and paginated lists need:
 *
 * - **Follow output** — auto-stick to the bottom as content streams in,
 *   but only while the user is already at the bottom (see `followOutput`).
 * - **Prepend** — load older items at the top without the scroll position
 *   jumping, via virtuoso's `firstItemIndex` anchoring (`firstItemIndex` +
 *   `startReached`).
 * - **Append** — load more at the bottom (`endReached`).
 *
 * Imperative scroll control is exposed through {@link VirtualListHandle}. The
 * list is headless: pair it with `GoToNewest` — positioned over the list and
 * driven by `atBottomStateChange` + `scrollToBottom()` — for a go-to-newest
 * affordance.
 */
export interface VirtualListProps<T> {
  /** The data array. */
  items: T[];
  /** Render function for each item. */
  itemContent: (index: number, item: T) => ReactNode;
  /** Stable key for each item. */
  computeItemKey?: (index: number, item: T) => Key;

  // --- Follow output (chat/streaming) ---
  /** Auto-scroll to bottom when new items append or the last item grows. */
  followOutput?: boolean | "smooth";
  /** Fires when the at-bottom state changes. */
  atBottomStateChange?: (atBottom: boolean) => void;
  /** Pixel threshold for "at bottom" detection. Default 64. */
  atBottomThreshold?: number;

  // --- Prepend (load older) ---
  /** Virtuoso's firstItemIndex for stable prepend anchoring. */
  firstItemIndex?: number;
  /** Fires when the user scrolls to the top of the list. */
  startReached?: (index: number) => void;

  // --- Append (load more) ---
  /** Fires when the user scrolls to the bottom of the list. */
  endReached?: (index: number) => void;

  // --- Initial position ---
  initialTopMostItemIndex?: number | "LAST";
  /** Render this many items before the first viewport measurement lands. */
  initialItemCount?: number;

  // --- Layout ---
  overscan?: number;
  increaseViewportBy?: number | { top: number; bottom: number };
  className?: string;
  ref?: Ref<VirtualListHandle>;
}

export interface VirtualListHandle {
  scrollToIndex(opts: {
    index: number;
    behavior?: "auto" | "smooth";
    align?: "start" | "center" | "end";
  }): void;
  scrollToBottom(opts?: { behavior?: "auto" | "smooth" }): void;
  getScrollElement(): HTMLElement | null;
}

/** Default "at bottom" pixel threshold — matches the documented API. */
const DEFAULT_AT_BOTTOM_THRESHOLD = 64;

/**
 * Map the scalar `followOutput` prop to virtuoso's callback form. The
 * callback returns a truthy follow mode only while the user is already at the
 * bottom, so streaming never yanks a user who has scrolled up back down. A
 * falsy prop disables following entirely (returns `undefined`).
 */
export function resolveFollowOutput(
  followOutput: VirtualListProps<unknown>["followOutput"],
): FollowOutput | undefined {
  if (!followOutput) return undefined;
  const mode = followOutput === "smooth" ? "smooth" : true;
  return (isAtBottom: boolean) => (isAtBottom ? mode : false);
}

/**
 * Map the friendly `initialTopMostItemIndex` prop to virtuoso's location
 * type. `"LAST"` is sugar for "open pinned to the final item, aligned to the
 * bottom edge" — the chat/streaming default.
 */
export function resolveInitialTopMostItemIndex(
  initialTopMostItemIndex: VirtualListProps<unknown>["initialTopMostItemIndex"],
): IndexLocationWithAlign | number | undefined {
  if (initialTopMostItemIndex === undefined) return undefined;
  if (initialTopMostItemIndex === "LAST") {
    return { index: "LAST", align: "end" };
  }
  return initialTopMostItemIndex;
}

export function VirtualList<T>({
  items,
  itemContent,
  computeItemKey,
  followOutput,
  atBottomStateChange,
  atBottomThreshold = DEFAULT_AT_BOTTOM_THRESHOLD,
  firstItemIndex,
  startReached,
  endReached,
  initialTopMostItemIndex,
  initialItemCount,
  overscan,
  increaseViewportBy,
  className,
  ref,
}: VirtualListProps<T>) {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const scrollElementRef = useRef<HTMLElement | null>(null);

  useImperativeHandle(
    ref,
    () => ({
      scrollToIndex({ index, behavior, align }) {
        virtuosoRef.current?.scrollToIndex({ index, behavior, align });
      },
      scrollToBottom(opts) {
        virtuosoRef.current?.scrollToIndex({
          index: "LAST",
          align: "end",
          behavior: opts?.behavior,
        });
      },
      getScrollElement() {
        return scrollElementRef.current;
      },
    }),
    [],
  );

  const resolvedFollowOutput = useMemo(
    () => resolveFollowOutput(followOutput),
    [followOutput],
  );

  const resolvedInitialTopMostItemIndex = useMemo(
    () => resolveInitialTopMostItemIndex(initialTopMostItemIndex),
    [initialTopMostItemIndex],
  );

  return (
    <Virtuoso<T>
      ref={virtuosoRef}
      data-slot="virtual-list"
      className={cn("bg-[var(--surface-base)]", className)}
      data={items}
      itemContent={itemContent}
      followOutput={resolvedFollowOutput}
      atBottomStateChange={atBottomStateChange}
      atBottomThreshold={atBottomThreshold}
      startReached={startReached}
      endReached={endReached}
      scrollerRef={(el) => {
        // The flat scroller can be a Window when window-scrolling; we only
        // surface real elements. `nodeType` distinguishes Element from Window
        // without referencing the `Window` global.
        scrollElementRef.current = el && "nodeType" in el ? el : null;
      }}
      // Virtuoso reads an explicitly-passed `undefined` as an override of its
      // own numeric defaults (e.g. overscan/increaseViewportBy default to 0),
      // which then throws in its viewport math. Only forward these when the
      // consumer actually set them so virtuoso keeps its defaults otherwise.
      {...(computeItemKey !== undefined ? { computeItemKey } : {})}
      {...(firstItemIndex !== undefined ? { firstItemIndex } : {})}
      {...(resolvedInitialTopMostItemIndex !== undefined
        ? { initialTopMostItemIndex: resolvedInitialTopMostItemIndex }
        : {})}
      {...(initialItemCount !== undefined ? { initialItemCount } : {})}
      {...(overscan !== undefined ? { overscan } : {})}
      {...(increaseViewportBy !== undefined ? { increaseViewportBy } : {})}
    />
  );
}
