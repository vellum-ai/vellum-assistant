import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { cn } from "../../utils/cn";

/**
 * Single-line text wrapper that scrolls (marquee-style) when the parent
 * `PanelItem` row is hovered AND the text overflows its container.
 *
 * Colocated with `PanelItem` because it relies on the `group` /
 * `group-hover:` mechanism established by the parent row.
 *
 * Renders TWO sibling spans inside the overflow container so the static
 * (idle / reduced-motion / touch) state still gets a real ellipsis
 * truncation:
 *
 * 1. Static — `truncate` element (white-space:nowrap + overflow:hidden +
 *    text-overflow:ellipsis). Visible by default.
 * 2. Animated — `whitespace-nowrap` block whose width can exceed the
 *    container. Hidden by default via `invisible`.
 *
 * Visibility is swapped via Tailwind utility classes using built-in
 * variants only:
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

interface MarqueeTextProps {
  children: ReactNode;
  className?: string;
}

const SCROLL_PX_PER_SECOND = 50;
const MIN_SCROLL_DURATION_MS = 2000;
const SCROLL_FRACTION_OF_ITERATION = 0.8;

function MarqueeText({ children, className }: MarqueeTextProps) {
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
  const scrollMs = Math.max(
    MIN_SCROLL_DURATION_MS,
    Math.round(((overflowPx * 2) / SCROLL_PX_PER_SECOND) * 1000),
  );
  const totalMs = Math.round(scrollMs / SCROLL_FRACTION_OF_ITERATION);

  return (
    <span
      data-slot="marquee-text"
      ref={containerRef}
      className={cn("relative min-w-0 flex-1 overflow-hidden", className)}
    >
      <span className="block truncate motion-safe:group-hover:invisible">
        {children}
      </span>
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

export { MarqueeText, type MarqueeTextProps };
