import { useCallback, useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Thresholds (match the main chat transcript — see
// `transcript-scroll-utils.ts`).
// ---------------------------------------------------------------------------

/** Distance from the bottom (px) at or below which the viewport is
 *  considered pinned to the latest message and auto-follows streaming
 *  growth. In a top-to-bottom (flex-col) layout this is
 *  `scrollHeight − clientHeight − scrollTop`. */
const PINNED_THRESHOLD_PX = 64;

/** Distance from the bottom (px) above which the "Go to Newest"
 *  affordance is shown. */
const SHOW_SCROLL_BUTTON_THRESHOLD_PX = 240;

export interface UseDoctorAutoScrollReturn {
  /** Attach this to the scrollable transcript container. The hook owns
   *  the element via state so its effects re-run when the container
   *  mounts (the messages div is only rendered once a session is
   *  active — it is absent in the idle/loading branches). */
  scrollContainerRef: (el: HTMLDivElement | null) => void;
  /** Whether the "Go to Newest" affordance should be visible. */
  showScrollToLatest: boolean;
  /** Pin the viewport back to the latest message (user clicked the
   *  affordance or just submitted a message). Re-engages auto-follow. */
  scrollToLatest: () => void;
}

/**
 * Auto-scroll coordinator for the Doctor panel transcript.
 *
 * Mirrors the philosophy of the main chat transcript's
 * `useTranscriptScroll`: while the user is pinned to the latest message,
 * streaming growth auto-scrolls to keep it in view. The moment the user
 * scrolls away (drag up on mobile, wheel/trackpad on desktop), we stop
 * fighting them and surface a "Go to Newest" affordance so they can
 * catch up on their own.
 *
 * The hook owns the scroll element via a callback ref + state rather
 * than a plain ref object. The messages div is only rendered once a
 * session is active (it is absent in the idle/loading branches), so a
 * plain ref is `null` on first render and the listener-setup effect
 * would never re-run when the div mounts — leaving the scroll listener
 * unattached and the pinned flag stuck in the normal start-from-idle
 * flow. State drives the effect dependency so listeners attach as soon
 * as the element appears.
 *
 * Unlike the chat transcript coordinator, this hook does not own
 * older-page pagination or conversation-switch resets — the Doctor
 * panel renders a single streaming session, so the logic stays minimal.
 */
export function useDoctorAutoScroll(
  /** The rendered transcript entries. A new array identity (produced by
   *  the panel's `useMemo` whenever the store appends/updates an entry)
   *  re-fires the growth effect so streaming deltas auto-scroll when
   *  pinned. Only the array identity matters — the element shape is
   *  intentionally permissive. */
  entries: ReadonlyArray<unknown>,
): UseDoctorAutoScrollReturn {
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const [showScrollToLatest, setShowScrollToLatest] = useState(false);
  const isPinnedRef = useRef(true);

  const scrollContainerRef = useCallback(
    (el: HTMLDivElement | null) => {
      setScrollEl((prev) => {
        // Reset pinned state for each fresh transcript element. When the
        // messages div unmounts after the user scrolled away (New Session
        // or assistant switch clears entries and renders the idle branch),
        // isPinnedRef would otherwise stay false, so the next overflowing
        // transcript mounts unpinned and the user lands at scrollTop=0
        // with the newest content hidden. Each new element starts pinned.
        if (el !== prev) {
          isPinnedRef.current = true;
          setShowScrollToLatest(false);
        }
        return el;
      });
    },
    [],
  );

  const classify = useCallback(() => {
    const el = scrollEl;
    if (!el) {
      return;
    }
    const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
    // Clamp at 0 so iOS rubber-band overshoot below the bottom doesn't
    // flip the pinned flag spuriously.
    const distanceFromBottom = Math.max(0, maxScrollTop - el.scrollTop);
    isPinnedRef.current = distanceFromBottom <= PINNED_THRESHOLD_PX;
    setShowScrollToLatest(distanceFromBottom > SHOW_SCROLL_BUTTON_THRESHOLD_PX);
  }, [scrollEl]);

  // Auto-follow streaming growth only while pinned to the latest.
  // Instant (`behavior: "auto"`) rather than smooth: a smooth scroll on
  // every delta stutters, and the chat transcript uses the same instant
  // pin for its content-ResizeObserver re-pins.
  useEffect(() => {
    if (!isPinnedRef.current) {
      return;
    }
    if (!scrollEl) {
      return;
    }
    scrollEl.scrollTo({ top: scrollEl.scrollHeight, behavior: "auto" });
  }, [entries, scrollEl]);

  // Classify on scroll so dragging up un-pins (stops auto-follow) and
  // surfaces the "Go to Newest" affordance once the user is far enough
  // from the bottom. Depends on `scrollEl` so the listener attaches the
  // moment the messages div mounts (it is absent in the idle/loading
  // branches) and detaches when it unmounts.
  useEffect(() => {
    if (!scrollEl) {
      return;
    }
    scrollEl.addEventListener("scroll", classify, { passive: true });
    return () => {
      scrollEl.removeEventListener("scroll", classify);
    };
  }, [scrollEl, classify]);

  // Re-classify after entries change. scrollHeight grows under a
  // stationary scrollTop during streaming WITHOUT firing a scroll event,
  // so without this the "Go to Newest" pill would lag until the next
  // user touch. Mirrors the same re-classify step in the chat
  // coordinator's items-effect.
  useEffect(() => {
    classify();
  }, [entries, classify]);

  // Transcript content can also grow WITHOUT an entries change — e.g. the
  // inline backups panel loading asynchronously, or a tool block expanding.
  // Observe the content element's size so pinned users keep following and
  // un-pinned users get the "Go to Newest" affordance, matching the chat
  // transcript's content-ResizeObserver re-pins.
  useEffect(() => {
    if (!scrollEl || typeof ResizeObserver === "undefined") {
      return;
    }
    const content = scrollEl.firstElementChild;
    if (!content) {
      return;
    }
    const observer = new ResizeObserver(() => {
      if (isPinnedRef.current) {
        scrollEl.scrollTo({ top: scrollEl.scrollHeight, behavior: "auto" });
      }
      classify();
    });
    observer.observe(content);
    return () => {
      observer.disconnect();
    };
  }, [scrollEl, classify]);

  const scrollToLatest = useCallback(() => {
    if (!scrollEl) {
      return;
    }
    // Instant rather than smooth: a smooth catch-up animation emits
    // intermediate scroll events that classify() would see as "scrolled
    // away" (distance from bottom > 64px mid-animation), flipping
    // isPinnedRef back to false before the scroll settles. A
    // message_delta landing during the animation would then skip the
    // auto-follow effect and leave the user behind the stream. Instant
    // has no intermediate events, so the pinned flag stays true.
    isPinnedRef.current = true;
    scrollEl.scrollTo({ top: scrollEl.scrollHeight, behavior: "auto" });
    setShowScrollToLatest(false);
  }, [scrollEl]);

  return { scrollContainerRef, showScrollToLatest, scrollToLatest };
}
