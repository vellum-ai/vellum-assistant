// Thin scroll coordinator for the virtualized chat transcript. Since
// LUM-2605 the transcript renders through the `VirtualList` primitive,
// which owns windowing, prepend anchoring (`firstItemIndex`), and the
// initial bottom-pin. This hook is what remains of the old hand-rolled
// coordinator — two responsibilities that live above the primitive:
//
//   1. "Go to Newest" pill visibility — surfaced once the user drifts
//      more than `SHOW_SCROLL_BUTTON_THRESHOLD_PX` from the bottom.
//   2. Older-page paging — fire `onLoadOlder()` when the user scrolls
//      within `LOAD_OLDER_THRESHOLD_PX` of the top, de-duplicated by a
//      synchronous in-flight lock.
//
// Everything the previous implementation did with manual scrollTop math —
// the auto-pin window, anchor-preserving prepend correction, container /
// content ResizeObservers, wheel/touch/keydown disengage — is now handled
// inside `VirtualList` (and the composite "latest-edge" row's min-height
// spacer in `transcript.tsx`). The coordinator only reads scroll geometry
// off the virtuoso scroller and classifies it; it never moves the viewport
// except through the `TranscriptHandle.scrollToLatest` command.
//
// The transcript is plain `flex-col` (oldest first, latest at the bottom):
//   - distanceFromTop    = scrollTop
//   - distanceFromBottom = scrollHeight − clientHeight − scrollTop

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
import { classifyScrollPosition } from "@/domains/chat/transcript/transcript-scroll-utils";

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

  // Coerced to boolean so the listener-attach effects below re-fire exactly
  // once on the 0→N transition (Transcript mounts, virtuoso scroller exists)
  // without re-firing on every TanStack Query background refetch.
  const hasItems = items.length > 0;

  const [showScrollToLatest, setShowScrollToLatest] = useState(false);

  // ---------- Latest-props ref (ref-backed fresh-closure pattern) ---------
  // Synced in useLayoutEffect (declared BEFORE the items-effect below) so the
  // narrow-dep items-effect and the stable scroll handler read fresh mutable
  // values without listing them in their dep arrays — listing `isLoadingOlder`
  // there is exactly what caused the older-page double-load regression the
  // burst tests lock in.
  // TODO: migrate to useEffectEvent once it's stable in React.
  const latestRef = useRef({
    hasMore,
    isLoadingOlder,
    conversationId,
    onLoadOlder,
    showScrollToLatest,
  });
  useLayoutEffect(() => {
    latestRef.current = {
      hasMore,
      isLoadingOlder,
      conversationId,
      onLoadOlder,
      showScrollToLatest,
    };
  }, [hasMore, isLoadingOlder, conversationId, onLoadOlder, showScrollToLatest]);

  // ---------- Synchronous load-older in-flight lock ---------------------
  //
  // The `isLoadingOlder` prop is the source of truth, but it propagates
  // through React state, so between a firing scroll event and the latestRef
  // refresh many more scroll events can fire — every one would see the stale
  // `isLoadingOlder=false` and re-fire `onLoadOlder`. This ref flips to `true`
  // SYNCHRONOUSLY the moment we fire; subsequent events within the same burst
  // see `true` and skip. Released by the transition effect just below.
  const loadOlderInFlightRef = useRef(false);
  const prevIsLoadingOlderRef = useRef(isLoadingOlder);

  // ---------- Lock release on isLoadingOlder true→false transition ------
  // Declared BEFORE the items-effect so in commits where BOTH `isLoadingOlder`
  // and `items` change (underfilled-viewport chain-load), this runs first and
  // the items-effect's kick sees the released lock immediately.
  useLayoutEffect(() => {
    if (prevIsLoadingOlderRef.current && !isLoadingOlder) {
      loadOlderInFlightRef.current = false;
    }
    prevIsLoadingOlderRef.current = isLoadingOlder;
  }, [isLoadingOlder]);

  // ---------- Shared classify + apply ------------------------------------
  // Reads scroll geometry off the virtuoso scroller, classifies it against
  // the load-bearing thresholds, drives the pill state, and fires the gated
  // load-older path. Stable (closes over refs + a stable setter only) so the
  // items-effect's deps stay narrow.
  const classifyAndApply = useCallback((el: HTMLElement) => {
    const latest = latestRef.current;
    const classification = classifyScrollPosition(
      {
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
      },
      {
        hasMore: latest.hasMore,
        isLoadingOlder: latest.isLoadingOlder,
        hasConversation: latest.conversationId !== null,
      },
    );

    if (classification.showScrollToLatest !== latest.showScrollToLatest) {
      setShowScrollToLatest(classification.showScrollToLatest);
    }

    // Gate on the synchronous in-flight lock so a burst of scroll events — or
    // a chain-load sequence near the top — fires `onLoadOlder` only once per
    // settled load.
    if (classification.shouldLoadOlder && !loadOlderInFlightRef.current) {
      loadOlderInFlightRef.current = true;
      latest.onLoadOlder();
    }
  }, []);

  // ---------- Conversation switch: reset the pill ------------------------
  // VirtualList remounts (key=conversationId) and lands at the bottom, so the
  // pill must not linger from the outgoing conversation. The items-effect
  // re-classifies against the fresh scroller right after.
  useLayoutEffect(() => {
    startTransition(() => {
      setShowScrollToLatest(false);
    });
  }, [conversationId]);

  // ---------- Items-change re-classify -----------------------------------
  // The browser fires no scroll event when scrollHeight grows under a
  // stationary scrollTop (the streaming case) or when a conversation opens
  // underfilled. Re-classify on every items change so the pill surfaces and
  // the underfilled-viewport load-older kick still fires. Deps are
  // intentionally narrow — `items` + `conversationId` (the values that decide
  // WHEN to re-classify) plus the stable ref/callback; every mutable flag is
  // read from `latestRef`.
  useLayoutEffect(() => {
    const el = transcriptRef.current?.getScrollElement();
    if (el) classifyAndApply(el);
  }, [items, conversationId, transcriptRef, classifyAndApply]);

  // ---------- Scroll listener --------------------------------------------
  const handleScroll = useCallback(
    (event: Event) => {
      const target = event.currentTarget as HTMLElement | null;
      if (target) classifyAndApply(target);
    },
    [classifyAndApply],
  );

  // Attach to the virtuoso scroller. Re-runs on `conversationId` / `hasItems`
  // so a transcript remount (conversation switch, deferred first mount)
  // re-binds to the newly mounted scroll element. `handleScroll` is stable.
  useEffect(() => {
    const el = transcriptRef.current?.getScrollElement();
    if (!el) return;
    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", handleScroll);
    };
  }, [handleScroll, transcriptRef, conversationId, hasItems]);

  // ---------- Exposed scrollToLatest -------------------------------------
  const scrollToLatest = useCallback(
    (opts?: { behavior?: "auto" | "smooth" }) => {
      transcriptRef.current?.scrollToLatest({
        behavior: opts?.behavior ?? "smooth",
      });
    },
    [transcriptRef],
  );

  return {
    showScrollToLatest,
    scrollToLatest,
  };
}
