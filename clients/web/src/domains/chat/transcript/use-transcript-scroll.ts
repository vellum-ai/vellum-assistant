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

import type { TranscriptItem } from "@/domains/chat/transcript/types";
import {
  type AnchorSnapshot,
  classifyScrollPosition,
  decideItemsChangeAction,
  findLatestUserAnchorKey,
  type ScrollMetrics,
} from "@/domains/chat/transcript/transcript-scroll-utils";

import type { TranscriptHandle } from "@/domains/chat/transcript/transcript";

// ---------------------------------------------------------------------------
// Public hook API
// ---------------------------------------------------------------------------

export interface UseTranscriptScrollArgs {
  transcriptRef: RefObject<TranscriptHandle | null>;
  items: TranscriptItem[];
  conversationId: string | null;
  hasMore: boolean;
  isLoadingOlder: boolean;
  onLoadOlder: () => void;
}

export interface UseTranscriptScrollReturn {
  showScrollToLatest: boolean;
  scrollToLatest: (opts?: { behavior?: "auto" | "smooth" }) => void;
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
    conversationId,
    hasMore,
    isLoadingOlder,
    onLoadOlder,
  } = args;

  // Coerced to boolean so the dep arrays below re-fire exactly once on
  // the 0→N transition (Transcript mounts) without re-firing on every
  // TanStack Query background refetch that produces a new `items` array.
  const hasItems = items.length > 0;

  const [isPinnedToLatest, setIsPinnedToLatest] = useState(true);
  const [showScrollToLatest, setShowScrollToLatest] = useState(false);

  // ---------- Latest-props ref (ref-backed fresh-closure pattern) ---------
  // Synced in useLayoutEffect (declared BEFORE the items-effect below)
  // so the items-effect — whose deps are intentionally narrow
  // (`items` + `conversationId` + transcriptRef + engageAutoPin) —
  // reads fresh values for everything else via latestRef without
  // forcing those values into its dep array. Putting them in the
  // items-effect deps would cause it to re-run on transitions that
  // shouldn't trigger items-change work, with two real consequences:
  // (1) the `decideItemsChangeAction` branch consumes `savedAnchorRef`
  // on a heightDelta=0 no-op, and (2) the chain-load branch re-fires
  // `onLoadOlder()` on a just-released lock while items haven't yet
  // prepended. See the dedicated lock-release effect below.
  // TODO: migrate to useEffectEvent once it's stable in React.
  const latestRef = useRef({
    items,
    hasMore,
    isLoadingOlder,
    conversationId,
    onLoadOlder,
    isPinnedToLatest,
    showScrollToLatest,
  });
  useLayoutEffect(() => {
    latestRef.current = {
      items,
      hasMore,
      isLoadingOlder,
      conversationId,
      onLoadOlder,
      isPinnedToLatest,
      showScrollToLatest,
    };
  }, [
    items,
    hasMore,
    isLoadingOlder,
    conversationId,
    onLoadOlder,
    isPinnedToLatest,
    showScrollToLatest,
  ]);

  // ---------- Saved anchor for prepend preservation ---------------------
  const savedAnchorRef = useRef<AnchorSnapshot | null>(null);

  // ---------- Synchronous load-older in-flight lock ---------------------
  //
  // The `isLoadingOlder` prop is the source of truth, but it propagates
  // through React state: parent calls `setIsLoadingOlder(true)` inside
  // `onLoadOlder`, React commits, then a `useLayoutEffect` mirrors the
  // new value into `latestRef`. Between the firing scroll event and the
  // latestRef refresh, ~5–20 more scroll events can fire — every one
  // sees the stale `isLoadingOlder=false` and re-fires `onLoadOlder`.
  // Even though React Query dedupes the underlying fetch, the rapid
  // re-fires overwrite `savedAnchorRef` with progressively different
  // scrollTop values mid-gesture, producing jittery scroll restoration
  // after the prepend.
  //
  // The fix: a ref that flips to `true` SYNCHRONOUSLY at the moment we
  // call `onLoadOlder`. Subsequent scroll events within the same burst
  // see `true` and skip. The lock is released by the dedicated
  // `isLoadingOlder` transition effect below — declared BEFORE the
  // items-effect so it fires first in the commit phase when both
  // change together (the underfilled-viewport chain-load case).
  const loadOlderInFlightRef = useRef(false);
  const prevIsLoadingOlderRef = useRef(isLoadingOlder);

  // ---------- Lock release on isLoadingOlder true→false transition ------
  //
  // Declared as its own effect (not co-located with the items-effect)
  // so transitions of `isLoadingOlder` that do NOT coincide with an
  // items change cannot accidentally trigger the items-effect's
  // anchor-correct + chain-load work. Declared BEFORE the items-effect
  // so in commits where BOTH `isLoadingOlder` and `items` change
  // (underfilled-viewport prepend), this effect runs first within the
  // commit phase and the items-effect's chain-load branch sees the
  // released lock immediately.
  useLayoutEffect(() => {
    if (prevIsLoadingOlderRef.current && !isLoadingOlder) {
      loadOlderInFlightRef.current = false;
    }
    prevIsLoadingOlderRef.current = isLoadingOlder;
  }, [isLoadingOlder]);

  // ---------- Previous items ref (for change detection) -----------------
  const previousItemsRef = useRef<TranscriptItem[]>(items);

  // ---------- Previous latest-user-anchor key (submit detection) --------
  // Seeded from the initial items so the items-effect's first run on
  // mount does not register a spurious "new anchor" event.
  const previousAnchorKeyRef = useRef<string | null>(
    findLatestUserAnchorKey(items),
  );

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
    // Force the items-effect's submit-detection block to treat the next
    // run as a "new anchor" event so a fresh conversation lands at the
    // latest message even if it happens to share an anchor key with the
    // outgoing one (e.g. seeded fixtures, restored drafts).
    previousAnchorKeyRef.current = null;
    engageAutoPin();
  }, [conversationId, engageAutoPin]);

  // -----------------------------------------------------------------------
  // Items change handler — runs in useLayoutEffect so the anchor correction
  // happens before the browser paints.
  //
  // Deps are intentionally narrow: `items` + `conversationId` (the two
  // values that determine WHEN this work should run) plus the two
  // stable refs (`transcriptRef`, `engageAutoPin`). Everything else
  // that the body reads — `hasMore`, `isLoadingOlder`, `onLoadOlder`,
  // `isPinnedToLatest`, `showScrollToLatest` — comes from `latestRef`,
  // which is synced in the useLayoutEffect declared above this one.
  // Listing those values directly in this effect's deps would cause it
  // to re-run for transitions that didn't change items, and the
  // anchor-correct + chain-load branches would fire against stale
  // assumptions (e.g. the `isLoadingOlder` true→false → premature
  // chain-load bug).
  // -----------------------------------------------------------------------
  useLayoutEffect(() => {
    const prev = previousItemsRef.current;
    previousItemsRef.current = items;
    const latest = latestRef.current;

    const action = decideItemsChangeAction({
      items,
      previousItems: prev,
      conversationId,
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

    // New-submit detection. When the latest user-message anchor changes
    // (typically because the user just submitted a new message and the
    // optimistic add landed in `messages`), the new `LatestTurnRow`
    // expands to viewport min-height. We need to re-pin to the bottom so
    // the new anchor sits at the top of the viewport.
    //
    // Why this is a separate code path from the existing `shouldAutoPinRef`
    // block below: the upstream `scrollToLatest()` call in
    // `handleSubmit` engages the auto-pin window BEFORE the optimistic
    // user message is added. By the time the items-effect runs, layout
    // can still be in flux (composer textarea resetting to one-line
    // height changes scroll-container clientHeight; new LatestTurnRow's
    // `viewportMinHeight` state may lag behind the underlying
    // ResizeObserver tick). Re-engaging the auto-pin window from
    // here — gated specifically on "anchor changed" — extends the
    // content-ResizeObserver re-pin window so it covers the post-submit
    // layout-settling phase, and the unconditional `scrollToLatest`
    // below guarantees we hit the latest bottom even if the upstream
    // window already lapsed.
    const newAnchorKey = findLatestUserAnchorKey(items);
    const prevAnchorKey = previousAnchorKeyRef.current;
    previousAnchorKeyRef.current = newAnchorKey;
    const isNewAnchor =
      newAnchorKey !== null && newAnchorKey !== prevAnchorKey;
    if (isNewAnchor) {
      engageAutoPin();
      transcriptRef.current?.scrollToLatest({ behavior: "auto" });
    } else if (
      shouldAutoPinRef.current &&
      items.length > 0 &&
      transcriptRef.current
    ) {
      // First-pass pin during the auto-pin window. The content
      // ResizeObserver will catch any subsequent height changes (async
      // min-height settle, late image loads) and re-pin until the
      // window expires.
      transcriptRef.current.scrollToLatest({ behavior: "auto" });
    }

    // After every items change re-classify the scroll position. The
    // browser does NOT fire a scroll event when scrollHeight grows under
    // a stationary scrollTop (the streaming case), so without this the
    // "Go to Newest" pill would only surface once the user touched the
    // scroll wheel. Read mutable flags from `latest` (synced by the
    // useLayoutEffect declared above this one, so values are fresh for
    // the current commit).
    const el = transcriptRef.current?.getScrollElement();
    if (el) {
      const classification = classifyScrollPosition(
        {
          scrollTop: el.scrollTop,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
        },
        {
          hasMore: latest.hasMore,
          isLoadingOlder: latest.isLoadingOlder,
          hasConversation: conversationId !== null,
        },
      );
      if (classification.isPinned !== latest.isPinnedToLatest) {
        setIsPinnedToLatest(classification.isPinned);
      }
      if (classification.showScrollToLatest !== latest.showScrollToLatest) {
        setShowScrollToLatest(classification.showScrollToLatest);
      }

      // Underfilled viewport: no scroll event can fire, so kick load-older
      // from here. Skip the anchor save during auto-pin (resize observer re-pins).
      // Gate on the synchronous in-flight lock so a chain-load sequence
      // (response prepends → items change → effect re-runs near top) cannot
      // double-fire on a single render cycle.
      if (
        classification.shouldLoadOlder &&
        !loadOlderInFlightRef.current
      ) {
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
        loadOlderInFlightRef.current = true;
        latest.onLoadOlder();
      }
    }
  }, [items, conversationId, transcriptRef, engageAutoPin]);

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
  // (e.g. Transcript remounts inside ResizablePanel). `conversationId`
  // is the dep-array signal for remounts — it corresponds directly to
  // the `key={conversationId}` prop on the scroll container.
  //
  // `hasItems` covers the deferred-mount case: `Transcript` only
  // renders when `messageCount > 0`, so on initial conversation load
  // `conversationId` fires before the element exists. The boolean
  // flips once on the 0→N transition, re-running the effect after
  // the element mounts, without re-running on every TQ refetch.
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
  }, [conversationId, transcriptRef, hasItems]);

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
  }, [conversationId, transcriptRef, hasItems]);

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
  }, [conversationId, transcriptRef, disengageAutoPin, hasItems]);

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
      hasConversation: latest.conversationId !== null,
    });

    if (classification.isPinned !== latest.isPinnedToLatest) {
      setIsPinnedToLatest(classification.isPinned);
    }
    if (classification.showScrollToLatest !== latest.showScrollToLatest) {
      setShowScrollToLatest(classification.showScrollToLatest);
    }

    if (classification.shouldLoadOlder && !loadOlderInFlightRef.current) {
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
      // Flip the synchronous lock BEFORE firing so re-entrant scroll
      // events within the same gesture see the in-flight state
      // immediately, without waiting for React to commit the parent's
      // `setIsLoadingOlder(true)` and the mirror useEffect to refresh
      // `latestRef`.
      loadOlderInFlightRef.current = true;
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

  // -----------------------------------------------------------------------
  // Attach the scroll-event listener. The hook owns its own listener
  // so the orchestrator does not have to wire one externally.
  //
  // Re-runs on `conversationId` so a transcript remount (inside
  // ResizablePanel) re-binds to the newly mounted scroll element.
  // `handleScroll` is stable across renders so it does not contribute
  // to re-binding.
  // -----------------------------------------------------------------------
  useEffect(() => {
    const el = transcriptRef.current?.getScrollElement();
    if (!el) return;
    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", handleScroll);
    };
  }, [handleScroll, transcriptRef, conversationId, hasItems]);

  return {
    showScrollToLatest,
    scrollToLatest,
  };
}
