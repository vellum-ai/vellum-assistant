// Scroll coordinator hook for the column-reverse transcript. Owns:
//
//   1. Pinned-to-latest detection + scroll-to-latest affordance visibility.
//   2. Anchor-preserving older-page prepends.
//   3. Streaming-growth auto-follow (pinned -> stick to bottom; otherwise
//      preserve the reader's viewport).
//
// In column-reverse layout, scrollTop = 0 is the visual bottom (latest
// messages). Scrolling UP to older messages increases the negative
// scrollTop magnitude (scrollTop becomes more negative in some browsers)
// but we use the absolute scrollTop value as `distanceFromBottom`.
//
// The hook only issues scroll commands through the `TranscriptHandle`
// interface — it never touches `scrollIntoView` directly.

import type { RefObject } from "react";
import {
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import type { TranscriptItem } from "@/domains/chat/lib/transcript/types.js";

import type { TranscriptHandle } from "@/domains/chat/transcript/transcript.js";

export type { TranscriptHandle };

// ---------------------------------------------------------------------------
// Thresholds (load-bearing — keep exact).
// ---------------------------------------------------------------------------

/** Distance from bottom (in px) at or below which the transcript is
 *  considered pinned to latest. In column-reverse, this is the absolute
 *  value of scrollTop. */
export const PINNED_THRESHOLD_PX = 64;

/** Distance from bottom (in px) above which the scroll-to-latest
 *  affordance is shown. */
export const SHOW_SCROLL_BUTTON_THRESHOLD_PX = 240;

/** Distance from the TOP of scrollable content (in px) at or below which
 *  an older-page load is triggered. In column-reverse, the top of
 *  scrollable content (oldest messages) is at
 *  `scrollHeight - clientHeight - scrollTop`. */
export const LOAD_OLDER_THRESHOLD_PX = 200;

// ---------------------------------------------------------------------------
// Public hook API
// ---------------------------------------------------------------------------

export interface UseTranscriptScrollArgs {
  transcriptRef: RefObject<TranscriptHandle | null>;
  items: TranscriptItem[];
  conversationKey: string | null;
  hasMore: boolean;
  isLoadingOlder: boolean;
  onLoadOlder: () => void;
  onStickToLatest?: () => void;
}

export interface UseTranscriptScrollReturn {
  isPinnedToLatest: boolean;
  showScrollToLatest: boolean;
  scrollToLatest: (opts?: { behavior?: "auto" | "smooth" }) => void;
  handleScroll: (event: Event) => void;
}

// ---------------------------------------------------------------------------
// Pure classification helpers (exported for direct unit testing).
// ---------------------------------------------------------------------------

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export interface ScrollClassification {
  distanceFromBottom: number;
  isPinned: boolean;
  showScrollToLatest: boolean;
  shouldLoadOlder: boolean;
}

/** Pure classification of a scroll position against the load-bearing
 *  thresholds above.
 *
 *  In column-reverse layout, scrollTop = 0 is the visual bottom (latest
 *  messages). As the user scrolls UP toward older messages, scrollTop
 *  increases. So:
 *    - distanceFromBottom = scrollTop
 *    - distanceFromTop = scrollHeight - clientHeight - scrollTop
 */
export function classifyScrollPosition(
  metrics: ScrollMetrics,
  flags: { hasMore: boolean; isLoadingOlder: boolean; hasConversation: boolean },
): ScrollClassification {
  // In column-reverse containers, browsers report negative scrollTop when
  // scrolled away from the bottom. Use Math.abs to normalize.
  const distanceFromBottom = Math.abs(metrics.scrollTop);
  const isPinned = distanceFromBottom <= PINNED_THRESHOLD_PX;
  const showScrollToLatest =
    distanceFromBottom > SHOW_SCROLL_BUTTON_THRESHOLD_PX;
  const distanceFromTop =
    metrics.scrollHeight - metrics.clientHeight - distanceFromBottom;
  const shouldLoadOlder =
    flags.hasConversation &&
    flags.hasMore &&
    !flags.isLoadingOlder &&
    distanceFromTop <= LOAD_OLDER_THRESHOLD_PX;
  return { distanceFromBottom, isPinned, showScrollToLatest, shouldLoadOlder };
}

/** Find the new index of a previously saved anchor key inside a refreshed
 *  items list. Returns -1 if the key is no longer present. */
export function findAnchorIndex(
  items: readonly TranscriptItem[],
  anchorKey: string,
): number {
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (item && item.key === anchorKey) return i;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Items-change decision helper (pure, exported for unit tests).
// ---------------------------------------------------------------------------

export interface AnchorSnapshot {
  key: string;
  scrollTop: number;
}

export type ItemsChangeAction =
  | { kind: "none" }
  | { kind: "anchor-correct"; newIndex: number; scrollTop: number }
  | { kind: "stick-to-latest" };

export interface ItemsChangeContext {
  items: readonly TranscriptItem[];
  previousItems: readonly TranscriptItem[];
  conversationKey: string | null;
  savedAnchor: AnchorSnapshot | null;
  isPinnedToLatest: boolean;
}

/** Decide what the scroll coordinator should do in response to an
 *  `items` change. The caller is responsible for executing the action
 *  (calling into the TranscriptHandle) and for updating the
 *  `savedAnchor` bookkeeping state.
 *
 *  Note: "open-to-latest" is not needed in column-reverse because the
 *  browser naturally starts at scrollTop=0 (the visual bottom). */
export function decideItemsChangeAction(
  ctx: ItemsChangeContext,
): ItemsChangeAction {
  // When there's no active conversation we have nothing to coordinate.
  if (ctx.conversationKey === null) return { kind: "none" };

  // 1. Anchor-preserving prepend correction has highest priority — the
  //    reader is scrolled up, a page of older messages just landed, and
  //    we need to keep their viewport anchored on the row they were
  //    looking at.
  if (ctx.savedAnchor && ctx.items.length > 0) {
    const newIndex = findAnchorIndex(ctx.items, ctx.savedAnchor.key);
    if (newIndex >= 0) {
      return {
        kind: "anchor-correct",
        newIndex,
        scrollTop: ctx.savedAnchor.scrollTop,
      };
    }
  }

  // 2. Streaming growth — stick to latest only when already pinned.
  const changed =
    ctx.items.length !== ctx.previousItems.length ||
    ctx.items.some((item, i) => item !== ctx.previousItems[i]);
  if (changed && ctx.isPinnedToLatest) {
    return { kind: "stick-to-latest" };
  }

  return { kind: "none" };
}

// ---------------------------------------------------------------------------
// Hook implementation
// ---------------------------------------------------------------------------

export function useTranscriptScroll(
  args: UseTranscriptScrollArgs,
): UseTranscriptScrollReturn {
  const {
    transcriptRef,
    items,
    conversationKey,
    hasMore,
    isLoadingOlder,
    onLoadOlder,
    onStickToLatest,
  } = args;

  const [isPinnedToLatest, setIsPinnedToLatest] = useState(true);
  const [showScrollToLatest, setShowScrollToLatest] = useState(false);

  // ---------- Latest-props ref (ref-backed fresh-closure pattern) ---------
  // TODO: migrate to useEffectEvent once it's stable in React.
  const latestRef = useRef({
    items,
    hasMore,
    isLoadingOlder,
    conversationKey,
    onLoadOlder,
    onStickToLatest,
    isPinnedToLatest,
    showScrollToLatest,
  });
  useEffect(() => {
    latestRef.current = {
      items,
      hasMore,
      isLoadingOlder,
      conversationKey,
      onLoadOlder,
      onStickToLatest,
      isPinnedToLatest,
      showScrollToLatest,
    };
  }, [
    items,
    hasMore,
    isLoadingOlder,
    conversationKey,
    onLoadOlder,
    onStickToLatest,
    isPinnedToLatest,
    showScrollToLatest,
  ]);

  // ---------- Saved anchor for prepend preservation ---------------------
  const savedAnchorRef = useRef<AnchorSnapshot | null>(null);

  // ---------- Previous items ref (for change detection) -----------------
  const previousItemsRef = useRef<TranscriptItem[]>(items);

  // -----------------------------------------------------------------------
  // Conversation switch: reset pinned state.
  // Wrapped in startTransition so the reset doesn't block urgent updates.
  // -----------------------------------------------------------------------
  useLayoutEffect(() => {
    startTransition(() => {
      setIsPinnedToLatest(true);
      setShowScrollToLatest(false);
    });
    savedAnchorRef.current = null;
    // Reset previousItemsRef so the new conversation's first items aren't
    // interpreted as a "growth" event.
    previousItemsRef.current = [];
    // Intentionally only depend on conversationKey.
  }, [conversationKey]);

  // -----------------------------------------------------------------------
  // Items change handler — runs in useLayoutEffect so the anchor correction
  // happens before the browser paints.
  // -----------------------------------------------------------------------
  useLayoutEffect(() => {
    const prev = previousItemsRef.current;
    previousItemsRef.current = items;

    const action = decideItemsChangeAction({
      items,
      previousItems: prev,
      conversationKey,
      savedAnchor: savedAnchorRef.current,
      isPinnedToLatest: latestRef.current.isPinnedToLatest,
    });

    switch (action.kind) {
      case "anchor-correct": {
        const scrollElement = transcriptRef.current?.getScrollElement();
        if (scrollElement) {
          scrollElement.scrollTop = action.scrollTop;
        }
        savedAnchorRef.current = null;
        break;
      }
      case "stick-to-latest": {
        transcriptRef.current?.scrollToLatest({ behavior: "auto" });
        latestRef.current.onStickToLatest?.();
        break;
      }
      case "none":
      default:
        break;
    }
  }, [items, conversationKey, transcriptRef]);

  // -----------------------------------------------------------------------
  // Container resize re-pin. When the scroll container resizes (e.g. the
  // document panel opens and squeezes the chat pane), content reflows and
  // the scroll position may shift. Re-pin to the bottom when the user was
  // already pinned so the "scroll to latest" button doesn't appear
  // spuriously. Combined with `overflow-anchor: none` on the scroll
  // container (Transcript.tsx), this keeps the coordinator — not the
  // browser — in control of scroll position during layout changes.
  //
  // The observer lifecycle is managed via refs so that we only
  // disconnect/reconnect when the underlying DOM node actually changes
  // (e.g. Transcript remounts inside ResizablePanel), not on every items
  // update. `items` is in the dep array so the check runs after
  // Transcript's first render with content post-remount.
  // -----------------------------------------------------------------------
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const observedElRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;

    const el = transcriptRef.current?.getScrollElement() ?? null;
    if (el === observedElRef.current) return;

    resizeObserverRef.current?.disconnect();
    observedElRef.current = el;

    if (!el) {
      resizeObserverRef.current = null;
      return;
    }

    const observer = new ResizeObserver(() => {
      if (latestRef.current.isPinnedToLatest) {
        transcriptRef.current?.scrollToLatest({ behavior: "auto" });
      }
    });
    observer.observe(el);
    resizeObserverRef.current = observer;
  }, [items, transcriptRef]);

  // Disconnect observer on hook unmount.
  useEffect(() => () => {
    resizeObserverRef.current?.disconnect();
  }, []);

  // -----------------------------------------------------------------------
  // Stable scroll handler. Reads latest props via the ref pattern.
  // -----------------------------------------------------------------------
  const handleScroll = useCallback((event: Event) => {
    const target = event.currentTarget as HTMLElement | null;
    if (!target) return;
    const metrics: ScrollMetrics = {
      scrollTop: target.scrollTop,
      scrollHeight: target.scrollHeight,
      clientHeight: target.clientHeight,
    };
    const latest = latestRef.current;
    const classification = classifyScrollPosition(metrics, {
      hasMore: latest.hasMore,
      isLoadingOlder: latest.isLoadingOlder,
      hasConversation: latest.conversationKey !== null,
    });

    if (classification.isPinned !== latest.isPinnedToLatest) {
      setIsPinnedToLatest(classification.isPinned);
    }
    if (classification.showScrollToLatest !== latest.showScrollToLatest) {
      setShowScrollToLatest(classification.showScrollToLatest);
    }

    if (classification.shouldLoadOlder) {
      // Capture the top-most visible item so we can restore the reader's
      // viewport after the prepend lands.
      const firstItem = latest.items[0];
      if (firstItem) {
        savedAnchorRef.current = {
          key: firstItem.key,
          scrollTop: metrics.scrollTop,
        };
      }
      latest.onLoadOlder();
    }
  }, []);

  // -----------------------------------------------------------------------
  // Exposed scrollToLatest — thin pass-through.
  // -----------------------------------------------------------------------
  const scrollToLatest = useCallback(
    (opts?: { behavior?: "auto" | "smooth" }) => {
      savedAnchorRef.current = null;
      transcriptRef.current?.scrollToLatest({
        behavior: opts?.behavior ?? "smooth",
      });
    },
    [transcriptRef],
  );

  return {
    isPinnedToLatest,
    showScrollToLatest,
    scrollToLatest,
    handleScroll,
  };
}
