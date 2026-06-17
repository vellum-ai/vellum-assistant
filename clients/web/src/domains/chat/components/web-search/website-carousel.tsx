
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";

import { FaviconChip } from "@/domains/chat/components/web-search/favicon-chip";

/**
 * Items consumed by `WebsiteCarousel`. The shape matches the inputs `FaviconChip`
 * needs to render a single search result — keep this in sync with that prop set.
 */
export interface WebsiteCarouselItem {
  /** Absolute favicon URL. Optional — `FaviconChip` falls back to a monogram. */
  faviconUrl?: string;
  /** The site's title for the chip's label. */
  title: string;
  /** Site domain — used for the monogram fallback and as part of the rotation key. */
  domain?: string;
}

export interface WebsiteCarouselProps {
  items: WebsiteCarouselItem[];
  /**
   * Minimum time each site is shown before advancing toward the latest, in ms.
   * Defaults to 500.
   */
  minDwellMs?: number;
}

/**
 * Top-down ticker that walks toward the latest searched site, sliding each new
 * entry in from above and the previous one out the bottom. Used by the
 * collapsed "Searching the web" header to show the websites being searched.
 *
 * The parent appends a new item as each site is searched, so the most recent
 * result is always the last entry. Rather than round-robining stale results,
 * the carousel advances `currentIndex` forward one step at a time toward
 * `items.length - 1` and then holds there. Every step is gated by a
 * `setTimeout(…, minDwellMs)` so each intermediate site is shown for at least
 * `minDwellMs` and rapid bursts of new results don't flash by.
 *
 * Mirrors the motion vocabulary used by `surfaces/card-surface.tsx`
 * (`InProgressDetail`) — `AnimatePresence` with `mode="popLayout"`, a per-entry
 * `motion.div`, and a y-axis fade.
 *
 * Honours `prefers-reduced-motion`: when set, the transition becomes an
 * instantaneous opacity fade (no `y` offset).
 *
 * Edge cases:
 * - 0 items → renders nothing.
 * - 1 item → renders that single chip statically, never schedules a timer.
 */
export function WebsiteCarousel({
  items,
  minDwellMs = 500,
}: WebsiteCarouselProps) {
  const reduce = useReducedMotion();
  const [currentIndex, setCurrentIndex] = useState(0);

  // The display target is always the latest item. Clamp to 0 so an empty list
  // yields a non-negative target.
  const target = Math.max(items.length - 1, 0);

  // Walk `currentIndex` toward the latest item one step at a time, each step
  // gated by `minDwellMs` so every intermediate site stays visible long enough.
  // When the parent appends a newer result `target` grows, this effect re-runs,
  // and the walk resumes — always converging on (and then holding) the most
  // recently searched site. Once caught up we hold and schedule nothing.
  useEffect(() => {
    if (currentIndex >= target) return;
    const id = setTimeout(
      () => setCurrentIndex((i) => Math.min(i + 1, target)),
      minDwellMs,
    );
    return () => clearTimeout(id);
  }, [currentIndex, target, minDwellMs]);

  if (items.length === 0) return null;

  const transition = reduce
    ? { duration: 0 }
    : { duration: 0.35, ease: [0.16, 1, 0.3, 1] as [number, number, number, number] };
  const initial = reduce ? { opacity: 0 } : { y: -28, opacity: 0 };
  const animate = reduce ? { opacity: 1 } : { y: 0, opacity: 1 };
  const exit = reduce ? { opacity: 0 } : { y: 28, opacity: 0 };

  // Single-item branch: no AnimatePresence, no timer — render the chip
  // directly so the wrapper still has the same height for layout stability.
  if (items.length === 1) {
    const item = items[0]!;
    return (
      <div className="relative overflow-hidden h-[28px] max-w-full">
        <div className="absolute inset-0 flex items-center">
          <FaviconChip
            faviconUrl={item.faviconUrl}
            title={item.title}
            domain={item.domain}
          />
        </div>
      </div>
    );
  }

  // Clamp to the latest item so a shrinking list can't index out of bounds.
  const safeIndex = Math.min(currentIndex, target);
  const current = items[safeIndex]!;
  // Compose a stable per-cycle key from domain/title plus the index so back-to-
  // back duplicates still trigger the slide animation.
  const key = `${safeIndex}:${current.domain ?? ""}:${current.title}`;

  return (
    <div className="relative overflow-hidden h-[28px] max-w-full">
      <AnimatePresence initial={false} mode="popLayout">
        <motion.div
          key={key}
          initial={initial}
          animate={animate}
          exit={exit}
          transition={transition}
          className="absolute inset-0 flex items-center"
        >
          <FaviconChip
            faviconUrl={current.faviconUrl}
            title={current.title}
            domain={current.domain}
          />
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
