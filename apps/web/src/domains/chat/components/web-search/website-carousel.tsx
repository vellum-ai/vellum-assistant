
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
  /** Time between transitions in ms. Defaults to 2500ms. */
  intervalMs?: number;
}

/**
 * Top-down rotating ticker that cycles through `items`, sliding each new entry
 * in from above and the previous one out the bottom. Used by the collapsed
 * "Searching the web" header to show the websites currently being searched.
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
 * - 1 item → renders that single chip statically, never schedules an interval.
 */
export function WebsiteCarousel({
  items,
  intervalMs = 2500,
}: WebsiteCarouselProps) {
  const reduce = useReducedMotion();
  const [currentIndex, setCurrentIndex] = useState(0);

  // Schedule the interval only when there's something to rotate through. A
  // single-item carousel is intentionally static — no timer churn. The
  // modulo guards against `items.length` shrinking out from under us between
  // ticks (e.g. when the parent updates the list mid-rotation).
  useEffect(() => {
    if (items.length <= 1) return;
    const id = setInterval(() => {
      setCurrentIndex((prev) => (prev + 1) % items.length);
    }, intervalMs);
    return () => clearInterval(id);
  }, [items.length, intervalMs]);

  if (items.length === 0) return null;

  const transition = reduce
    ? { duration: 0 }
    : { duration: 0.35, ease: [0.16, 1, 0.3, 1] as [number, number, number, number] };
  const initial = reduce ? { opacity: 0 } : { y: -28, opacity: 0 };
  const animate = reduce ? { opacity: 1 } : { y: 0, opacity: 1 };
  const exit = reduce ? { opacity: 0 } : { y: 28, opacity: 0 };

  // Single-item branch: no AnimatePresence, no interval — render the chip
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

  const safeIndex = currentIndex % items.length;
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
