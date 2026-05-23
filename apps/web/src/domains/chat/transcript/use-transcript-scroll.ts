// Scroll coordinator hook for the chronological-order transcript. Owns:
//
//   1. Pinned-to-latest detection + "Go to Newest" affordance visibility.
//   2. Anchor-preserving older-page prepends.
//   3. Conversation-switch reset: scroll the reused container back to the
//      latest message so the new conversation does not inherit the
//      previous conversation's scrollTop.
//
// The coordinator deliberately does NOT auto-follow streaming growth.
// As a response streams in, the viewport stays put and the "Go to Newest"
// pill surfaces so the user can catch up on their own — see the
// `LatestTurnRow` min-height spacer for the layout half of this pattern.
//
// The transcript uses plain `flex-col` (NOT column-reverse): oldest items
// first, latest at the bottom. scrollTop = 0 is the visual top (oldest);
// scrollTop = scrollHeight − clientHeight is the visual bottom (latest).
// Switching off column-reverse is what makes the "stay put while streaming"
// behavior possible — column-reverse's intrinsic bottom-anchoring fights
// every attempt to keep the viewport still.
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

import type { TranscriptItem } from "@/domains/chat/transcript/types.js";

import type { TranscriptHandle } from "@/domains/chat/transcript/transcript.js";

export type { TranscriptHandle };

// ---------------------------------------------------------------------------
// Thresholds (load-bearing — keep exact).
// ---------------------------------------------------------------------------

/** Distance from bottom (in px) at or below which the transcript is
 *  considered pinned to latest. In flex-col, this is
 *  `scrollHeight − clientHeight − scrollTop`. */
export const PINNED_THRESHOLD_PX = 64;

/** Distance from bottom (in px) above which the "Go to Newest"
 *  affordance is shown. */
export const SHOW_SCROLL_BUTTON_THRESHOLD_PX = 240;

/** Distance from the TOP of scrollable content (in px) at or below which
 *  an older-page load is triggered. In flex-col, the top of scrollable
 *  content (oldest messages) is at `scrollTop = 0`. */
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
 *  In flex-col (chronological) layout:
 *    - distanceFromTop    = scrollTop
 *    - distanceFromBottom = scrollHeight − clientHeight − scrollTop
 *
 *  iOS rubber-band can briefly push scrollTop outside [0, max], so we
 *  clamp distanceFromBottom at 0 to avoid spurious pill flicker.
 */
export function classifyScrollPosition(
  metrics: ScrollMetrics,
  flags: { hasMore: boolean; isLoadingOlder: boolean; hasConversation: boolean },
): ScrollClassification {
  const maxScrollTop = Math.max(
    0,
    metrics.scrollHeight - metrics.clientHeight,
  );
  const distanceFromBottom = Math.max(0, maxScrollTop - metrics.scrollTop);
  const distanceFromTop = Math.max(0, metrics.scrollTop);
  const isPinned = distanceFromBottom <= PINNED_THRESHOLD_PX;
  const showScrollToLatest =
    distanceFromBottom > SHOW_SCROLL_BUTTON_THRESHOLD_PX;
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
  /** scrollHeight captured at the moment the anchor was saved. The
   *  hook restores `scrollTop + (newScrollHeight − savedScrollHeight)`
   *  after the older-page prepend lands, so the user's view stays on
   *  the same row regardless of how many pixels of older content were
   *  inserted above it. */
  scrollHeight: number;
}

export type ItemsChangeAction =
  | { kind: "none" }
  | {
      kind: "anchor-correct";
      newIndex: number;
      savedScrollTop: number;
      savedScrollHeight: number;
    };

export interface ItemsChangeContext {
  items: readonly TranscriptItem[];
  previousItems: readonly TranscriptItem[];
  conversationKey: string | null;
  savedAnchor: AnchorSnapshot | null;
}

/** Decide what the scroll coordinator should do in response to an
 *  `items` change. The caller is responsible for executing the action
 *  (calling into the TranscriptHandle) and for updating the
 *  `savedAnchor` bookkeeping state.
 *
 *  Notes:
 *  - "open-to-latest" on conversation switch is handled by the
 *    conversation-reset effect, not here.
 *  - Streaming growth deliberately returns `none` here. The viewport
 *    stays put so the reader is in control; the "Go to Newest" pill
 *    appears once distance-from-bottom crosses its threshold. */
export function decideItemsChangeAction(
  ctx: ItemsChangeContext,
): ItemsChangeAction {
  // When there's no active conversation we have nothing to coordinate.
  if (ctx.conversationKey === null) return { kind: "none" };

  // Anchor-preserving prepend correction — the reader is scrolled up,
  // a page of older messages just landed, and we need to keep their
  // viewport anchored on the row they were looking at. The handler
  // adds (newScrollHeight − savedScrollHeight) to savedScrollTop, since
  // the new content was inserted above the anchor in flex-col DOM.
  if (ctx.savedAnchor && ctx.items.length > 0) {
    const newIndex = findAnchorIndex(ctx.items, ctx.savedAnchor.key);
    if (newIndex >= 0) {
      return {
        kind: "anchor-correct",
        newIndex,
        savedScrollTop: ctx.savedAnchor.scrollTop,
        savedScrollHeight: ctx.savedAnchor.scrollHeight,
      };
    }
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
      isPinnedToLatest,
      showScrollToLatest,
    };
  }, [
    items,
    hasMore,
    isLoadingOlder,
    conversationKey,
    onLoadOlder,
    isPinnedToLatest,
    showScrollToLatest,
  ]);

  // ---------- Saved anchor for prepend preservation ---------------------
  const savedAnchorRef = useRef<AnchorSnapshot | null>(null);

  // ---------- Previous items ref (for change detection) -----------------
  const previousItemsRef = useRef<TranscriptItem[]>(items);

  // ---------- Auto-pin window --------------------------------------------
  // While `shouldAutoPinRef` is true, every layout change of the scroll
  // content re-pins the viewport to the bottom. This is what makes the
  // initial render of a new conversation land at the latest message
  // even when content height keeps growing across multiple frames —
  // `useViewportMinHeight`'s deferred `setHeight`, late image/font
  // loads, etc. The flag is engaged briefly on intentful events
  // (conversation switch, "Go to Newest", user submit) and auto-
  // disengages on a 500 ms timer or on the first user-input scroll —
  // whichever comes first. The window is intentionally short so a
  // streaming response (which takes the HTTP round-trip plus first
  // token to *start*) does not trigger auto-follow.
  const shouldAutoPinRef = useRef(false);
  const autoPinTimeoutRef = useRef<number | null>(null);

  const disengageAutoPin = useCallback(() => {
    shouldAutoPinRef.current = false;
    if (autoPinTimeoutRef.current !== null) {
      clearTimeout(autoPinTimeoutRef.current);
      autoPinTimeoutRef.current = null;
    }
  }, []);

  const engageAutoPin = useCallback(() => {
    shouldAutoPinRef.current = true;
    if (autoPinTimeoutRef.current !== null) {
      clearTimeout(autoPinTimeoutRef.current);
    }
    autoPinTimeoutRef.current = window.setTimeout(() => {
      shouldAutoPinRef.current = false;
      autoPinTimeoutRef.current = null;
    }, 500);
  }, []);

  // Always clear the timer on unmount.
  useEffect(
    () => () => {
      if (autoPinTimeoutRef.current !== null) {
        clearTimeout(autoPinTimeoutRef.current);
      }
    },
    [],
  );

  // -----------------------------------------------------------------------
  // Conversation switch: reset pinned state and engage the auto-pin
  // window. The items effect + content ResizeObserver will land the
  // viewport on the latest message once the new content is in the DOM,
  // and keep re-pinning across the async layout-settling phase
  // (useViewportMinHeight, late image loads). The window auto-expires
  // before any streaming response could start.
  // -----------------------------------------------------------------------
  useLayoutEffect(() => {
    startTransition(() => {
      setIsPinnedToLatest(true);
      setShowScrollToLatest(false);
    });
    savedAnchorRef.current = null;
    previousItemsRef.current = [];
    engageAutoPin();
  }, [conversationKey, engageAutoPin]);

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
    });

    switch (action.kind) {
      case "anchor-correct": {
        const scrollElement = transcriptRef.current?.getScrollElement();
        if (scrollElement) {
          const heightDelta =
            scrollElement.scrollHeight - action.savedScrollHeight;
          scrollElement.scrollTop = action.savedScrollTop + heightDelta;
        }
        savedAnchorRef.current = null;
        break;
      }
      case "none":
      default:
        break;
    }

    // First-pass pin during the auto-pin window. The content
    // ResizeObserver will catch any subsequent height changes (async
    // min-height settle, late image loads) and re-pin until the
    // window expires.
    if (
      shouldAutoPinRef.current &&
      items.length > 0 &&
      transcriptRef.current
    ) {
      transcriptRef.current.scrollToLatest({ behavior: "auto" });
    }

    // After every items change re-classify the scroll position. The
    // browser does NOT fire a scroll event when scrollHeight grows under
    // a stationary scrollTop (the streaming case), so without this the
    // "Go to Newest" pill would only surface once the user touched the
    // scroll wheel. Read flags from closure (not latestRef) so the
    // prepend render sees the just-flipped isLoadingOlder=false instead
    // of the previous render's snapshot; latestRef is refreshed by a
    // later useEffect that hasn't fired yet at this point.
    const el = transcriptRef.current?.getScrollElement();
    if (el) {
      const classification = classifyScrollPosition(
        {
          scrollTop: el.scrollTop,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
        },
        {
          hasMore,
          isLoadingOlder,
          hasConversation: conversationKey !== null,
        },
      );
      if (classification.isPinned !== isPinnedToLatest) {
        setIsPinnedToLatest(classification.isPinned);
      }
      if (classification.showScrollToLatest !== showScrollToLatest) {
        setShowScrollToLatest(classification.showScrollToLatest);
      }

      // Underfilled viewport: no scroll event can fire, so kick load-older
      // from here. Skip the anchor save during auto-pin (resize observer re-pins).
      if (classification.shouldLoadOlder) {
        if (!shouldAutoPinRef.current) {
          const firstItem = items[0];
          if (firstItem) {
            savedAnchorRef.current = {
              key: firstItem.key,
              scrollTop: el.scrollTop,
              scrollHeight: el.scrollHeight,
            };
          }
        }
        onLoadOlder();
      }
    }
  }, [
    items,
    conversationKey,
    transcriptRef,
    hasMore,
    isLoadingOlder,
    onLoadOlder,
    isPinnedToLatest,
    showScrollToLatest,
  ]);

  // -----------------------------------------------------------------------
  // Container resize re-pin. When the scroll container resizes (e.g. the
  // document panel opens and squeezes the chat pane), `scrollHeight −
  // clientHeight` shifts and the max scrollTop changes. Re-pin to the
  // bottom when the user was already pinned so the "Go to Newest" pill
  // doesn't appear spuriously after a layout change the user didn't
  // initiate.
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
  // Content resize re-pin. The *content* element (inner wrapper around
  // all rendered rows) changes size whenever scroll content grows:
  //   - `useViewportMinHeight` setting min-height after first paint
  //   - Late image / web-font loads
  //   - Streaming response items appended
  //   - User-submitted messages adding a new turn
  // While `shouldAutoPinRef` is true, every fire snaps scrollTop back
  // to the visual bottom so the viewport stays at the latest message
  // through all of those async height changes. The 500 ms window
  // ensures streaming alone (which starts after first token / HTTP
  // round-trip) never auto-follows.
  // -----------------------------------------------------------------------
  const contentObserverRef = useRef<ResizeObserver | null>(null);
  const observedContentElRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;

    const el = transcriptRef.current?.getContentElement?.() ?? null;
    if (el === observedContentElRef.current) return;

    contentObserverRef.current?.disconnect();
    observedContentElRef.current = el;

    if (!el) {
      contentObserverRef.current = null;
      return;
    }

    const observer = new ResizeObserver(() => {
      if (shouldAutoPinRef.current) {
        transcriptRef.current?.scrollToLatest({ behavior: "auto" });
      }
    });
    observer.observe(el);
    contentObserverRef.current = observer;
  }, [items, transcriptRef]);

  useEffect(() => () => {
    contentObserverRef.current?.disconnect();
  }, []);

  // -----------------------------------------------------------------------
  // User-input scroll cancels the auto-pin window. Any of these gestures
  // means the user has taken control of the viewport — we stop fighting
  // them. We listen on the scroll element rather than the scroll event
  // because the scroll event also fires from our own programmatic pins,
  // which would otherwise disengage their own window mid-pin.
  // -----------------------------------------------------------------------
  useEffect(() => {
    const el = transcriptRef.current?.getScrollElement() ?? null;
    if (!el) return;
    el.addEventListener("wheel", disengageAutoPin, { passive: true });
    el.addEventListener("touchmove", disengageAutoPin, { passive: true });
    el.addEventListener("keydown", disengageAutoPin, { passive: true });
    return () => {
      el.removeEventListener("wheel", disengageAutoPin);
      el.removeEventListener("touchmove", disengageAutoPin);
      el.removeEventListener("keydown", disengageAutoPin);
    };
  }, [items, transcriptRef, disengageAutoPin]);

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
      // Capture the top-most visible item AND the current scrollHeight so
      // the items-effect can restore the reader's viewport after the
      // older-page prepend lands. The restore is
      // `savedScrollTop + (newScrollHeight − savedScrollHeight)`.
      const firstItem = latest.items[0];
      if (firstItem) {
        savedAnchorRef.current = {
          key: firstItem.key,
          scrollTop: metrics.scrollTop,
          scrollHeight: metrics.scrollHeight,
        };
      }
      latest.onLoadOlder();
    }
  }, []);

  // -----------------------------------------------------------------------
  // Exposed scrollToLatest — engages the auto-pin window so any async
  // layout settling after the scroll (image loads, etc.) stays anchored
  // at the bottom too.
  // -----------------------------------------------------------------------
  const scrollToLatest = useCallback(
    (opts?: { behavior?: "auto" | "smooth" }) => {
      savedAnchorRef.current = null;
      engageAutoPin();
      transcriptRef.current?.scrollToLatest({
        behavior: opts?.behavior ?? "smooth",
      });
    },
    [transcriptRef, engageAutoPin],
  );

  return {
    isPinnedToLatest,
    showScrollToLatest,
    scrollToLatest,
    handleScroll,
  };
}
