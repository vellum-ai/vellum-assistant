import { type CSSProperties, useEffect, useRef, useState, type ReactNode } from "react";

import { cn } from "../../utils.js";

/**
 * Single-line text wrapper that scrolls (marquee-style) when the parent
 * `PanelItem` row is hovered AND the text overflows its container.
 *
 * Colocated with `PanelItem` because it's only meaningful inside a row
 * that participates in the existing `group` / `group-hover:` mechanism.
 *
 * Renders TWO sibling spans inside the overflow container so the static
 * (idle / reduced-motion / touch) state still gets a real ellipsis
 * truncation, matching the rest of the codebase:
 *
 * 1. Static — `truncate` element (white-space:nowrap + overflow:hidden +
 *    text-overflow:ellipsis). Visible by default.
 * 2. Animated — `whitespace-nowrap` block whose width can exceed the
 *    container. Hidden by default via `invisible`.
 *
 * Visibility is swapped via colocated Tailwind utility classes using
 * built-in variants only:
 *   - `motion-safe:group-hover:` gates BOTH the visibility swap AND the
 *     scroll animation behind `@media (prefers-reduced-motion: no-preference)`
 *     and `@media (hover: hover)`. Reduced-motion users keep the static
 *     ellipsis on hover; touch-only devices are unaffected.
 *
 * Both siblings live in the same overflow container and have the same
 * box dimensions, so swapping them produces no layout shift. `aria-hidden`
 * is set on the animated sibling so screen readers see the label exactly
 * once.
 */

export interface MarqueeTextProps {
  children: ReactNode;
  className?: string;
}

// Pixels per second of horizontal scroll, per direction. Duration is
// derived from the overflow distance so long titles don't crawl while
// short ones fly past.
const SCROLL_PX_PER_SECOND = 50;
// Floor so even a tiny overflow animates at a perceptible pace.
const MIN_SCROLL_DURATION_MS = 2000;
// The keyframe spends 80% of its iteration scrolling (40% out, 40% back)
// and 20% paused at the ends — see globals.css.
const SCROLL_FRACTION_OF_ITERATION = 0.8;

export function MarqueeText({ children, className }: MarqueeTextProps) {
  const containerRef = useRef<HTMLSpanElement | null>(null);
  const innerRef = useRef<HTMLSpanElement | null>(null);
  const [overflowPx, setOverflowPx] = useState(0);

  useEffect(() => {
    const container = containerRef.current;
    const inner = innerRef.current;
    if (!container || !inner) return;

    const measure = () => {
      const overflow = inner.scrollWidth - container.clientWidth;
      setOverflowPx(overflow > 0 ? overflow : 0);
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    observer.observe(inner);
    return () => observer.disconnect();
  }, [children]);

  const canScroll = overflowPx > 0;
  // Round trip = 2× overflow distance (keyframe goes 0 → -overflow → 0).
  // Dividing by SCROLL_PX_PER_SECOND yields the time spent scrolling, so
  // each direction runs at SCROLL_PX_PER_SECOND.
  const scrollMs = Math.max(
    MIN_SCROLL_DURATION_MS,
    Math.round(((overflowPx * 2) / SCROLL_PX_PER_SECOND) * 1000),
  );
  const totalMs = Math.round(scrollMs / SCROLL_FRACTION_OF_ITERATION);

  return (
    <span
      ref={containerRef}
      data-slot="marquee-text"
      className={cn("relative min-w-0 flex-1 overflow-hidden", className)}
    >
      {/*
          Static-state element. Owns the visible idle/touch/reduced-motion
          rendering with a real ellipsis truncation. Hidden via
          `motion-safe:group-hover:invisible` so reduced-motion users
          keep the readable ellipsis on hover instead of a hard-clipped
          non-scrolling string.
      */}
      <span className="block truncate motion-safe:group-hover:invisible">
        {children}
      </span>
      {/*
        Animated-state element. Hidden by default via `invisible`;
        revealed by `motion-safe:group-hover:visible` so the swap only
        happens when the marquee animation can actually run. Keeps
        reduced-motion users on the static truncated span with a real
        ellipsis. `aria-hidden` keeps the label announced exactly once
        for assistive tech.
      */}
      <span
        ref={innerRef}
        aria-hidden
        className={cn(
          "absolute top-0 left-0 invisible block whitespace-nowrap",
          "motion-safe:group-hover:visible",
          canScroll && "motion-safe:group-hover:animate-panelitem-marquee",
        )}
        style={
          canScroll
            ? ({
                "--panelitem-marquee-distance": `${overflowPx}px`,
                "--panelitem-marquee-duration": `${totalMs}ms`,
              } as CSSProperties)
            : undefined
        }
      >
        {children}
      </span>
    </span>
  );
}
