import type { RefObject } from "react";
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
 * The previous implementation force-scrolled on every `message_delta`
 * with no escape hatch, which made mobile (Android web) sessions
 * disorienting — the viewport snapped back to the bottom mid-drag with
 * no way to read earlier content until the response finished.
 *
 * Unlike the chat transcript coordinator, this hook does not own
 * older-page pagination or conversation-switch resets — the Doctor
 * panel renders a single streaming session, so the logic stays minimal.
 */
export function useDoctorAutoScroll(
  scrollRef: RefObject<HTMLDivElement | null>,
  /** The rendered transcript entries. A new array identity (produced by
   *  the panel's `useMemo` whenever the store appends/updates an entry)
   *  re-fires the growth effect so streaming deltas auto-scroll when
   *  pinned. Only the array identity matters — the element shape is
   *  intentionally permissive. */
  entries: ReadonlyArray<unknown>,
): UseDoctorAutoScrollReturn {
  const [showScrollToLatest, setShowScrollToLatest] = useState(false);
  const isPinnedRef = useRef(true);

  const classify = useCallback(() => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
    // Clamp at 0 so iOS rubber-band overshoot below the bottom doesn't
    // flip the pinned flag spuriously.
    const distanceFromBottom = Math.max(0, maxScrollTop - el.scrollTop);
    isPinnedRef.current = distanceFromBottom <= PINNED_THRESHOLD_PX;
    setShowScrollToLatest(distanceFromBottom > SHOW_SCROLL_BUTTON_THRESHOLD_PX);
  }, [scrollRef]);

  // Auto-follow streaming growth only while pinned to the latest.
  // Instant (`behavior: "auto"`) rather than smooth: a smooth scroll on
  // every delta stutters, and the chat transcript uses the same instant
  // pin for its content-ResizeObserver re-pins.
  useEffect(() => {
    if (!isPinnedRef.current) {
      return;
    }
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    el.scrollTo({ top: el.scrollHeight, behavior: "auto" });
  }, [entries, scrollRef]);

  // Classify on scroll so dragging up un-pins (stops auto-follow) and
  // surfaces the "Go to Newest" affordance once the user is far enough
  // from the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    el.addEventListener("scroll", classify, { passive: true });
    return () => {
      el.removeEventListener("scroll", classify);
    };
  }, [scrollRef, classify]);

  // Re-classify after entries change. scrollHeight grows under a
  // stationary scrollTop during streaming WITHOUT firing a scroll event,
  // so without this the "Go to Newest" pill would lag until the next
  // user touch. Mirrors the same re-classify step in the chat
  // coordinator's items-effect.
  useEffect(() => {
    classify();
  }, [entries, classify]);

  const scrollToLatest = useCallback(() => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    isPinnedRef.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    setShowScrollToLatest(false);
  }, [scrollRef]);

  return { showScrollToLatest, scrollToLatest };
}
