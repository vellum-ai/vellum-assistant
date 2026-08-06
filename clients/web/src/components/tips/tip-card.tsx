/**
 * Presentational proactive tip card — props in, callbacks out. All gating,
 * selection, persistence, and telemetry live in `useTipCard`
 * (`hooks/use-tip-card.ts`); this component only renders the tip it is given.
 *
 * Compact promo-card layout for the narrow sidebar: eyebrow header row with
 * the dismiss X top-right, bold title, secondary body, an optional learn-more
 * CTA, then a centered carousel row (prev/next chevrons around windowed
 * pagination dots) for browsing the catalog.
 */

import { ChevronLeft, ChevronRight, Lightbulb, X } from "lucide-react";
import { Link } from "react-router";

import { cn } from "@/utils/misc";
import type { Tip } from "@/utils/tips-catalog";

const headerButtonClassName = cn(
  "-my-1 shrink-0 cursor-pointer rounded bg-transparent p-1",
  "text-[color:var(--content-tertiary)] transition-colors",
  "hover:text-[color:var(--content-secondary)]",
  "keyboard-focus:ring-2 keyboard-focus:ring-[var(--ring)] keyboard-focus:outline-none",
);

const carouselButtonClassName = cn(
  "shrink-0 cursor-pointer rounded bg-transparent p-1",
  "text-[color:var(--content-tertiary)] transition-colors",
  "hover:text-[color:var(--content-secondary)]",
  "disabled:cursor-default disabled:opacity-35",
  "disabled:hover:text-[color:var(--content-tertiary)]",
  "keyboard-focus:ring-2 keyboard-focus:ring-[var(--ring)] keyboard-focus:outline-none",
);

/**
 * Windowed pagination dots: at most 5, and an edge dot shrinks when more
 * items lie beyond the window — relative position, never a wall of dots.
 */
const MAX_CAROUSEL_DOTS = 5;

function TipCarouselDots({ index, count }: { index: number; count: number }) {
  const windowSize = Math.min(MAX_CAROUSEL_DOTS, count);
  const start = Math.min(
    Math.max(index - Math.floor(windowSize / 2), 0),
    count - windowSize,
  );
  return (
    <div
      className="flex items-center gap-1.5"
      data-slot="tip-card-dots"
      aria-hidden="true"
    >
      {Array.from({ length: windowSize }, (_, offset) => {
        const dotIndex = start + offset;
        const shrunk =
          (dotIndex === start && start > 0) ||
          (dotIndex === start + windowSize - 1 && start + windowSize < count);
        return (
          <span
            key={dotIndex}
            className={cn(
              "rounded-full",
              shrunk ? "size-1" : "size-1.5",
              dotIndex === index
                ? "bg-[var(--content-emphasised)]"
                : "bg-[var(--content-tertiary)] opacity-50",
            )}
          />
        );
      })}
    </div>
  );
}

export interface TipCardProps {
  tip: Tip;
  /** Zero-based position of `tip` among the browsable tips. */
  carouselIndex: number;
  /** Number of browsable tips; the carousel row hides when < 2. */
  carouselCount: number;
  onDismiss: () => void;
  onLearnMore: () => void;
  onPrevTip: () => void;
  onNextTip: () => void;
}

export function TipCard({
  tip,
  carouselIndex,
  carouselCount,
  onDismiss,
  onLearnMore,
  onPrevTip,
  onNextTip,
}: TipCardProps) {
  return (
    <div
      data-slot="tip-card"
      className="flex flex-col rounded-xl bg-[var(--surface-active)] p-4"
    >
      <div className="mb-3 flex items-center gap-1.5">
        <Lightbulb
          className="h-3.5 w-3.5 text-[color:var(--content-secondary)]"
          aria-hidden="true"
        />
        <span className="text-[11px] font-semibold tracking-wider text-[color:var(--content-secondary)] uppercase">
          {tip.eyebrow}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className={cn(headerButtonClassName, "-mr-1")}
        >
          <X className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
        </button>
      </div>

      <div className="mb-1.5 text-body-small-emphasised text-[color:var(--content-emphasised)]">
        {tip.title}
      </div>

      <div className="text-body-small-default leading-[1.55] text-[color:var(--content-secondary)]">
        {tip.body}
      </div>

      {tip.learnMore ? (
        <div className="mt-4">
          <Link
            data-slot="tip-card-learn-more"
            to={tip.learnMore.to}
            onClick={onLearnMore}
            className="text-body-small-default font-semibold whitespace-nowrap text-[color:var(--content-emphasised)] hover:underline"
          >
            {tip.learnMore.label} →
          </Link>
        </div>
      ) : null}

      {carouselCount > 1 ? (
        <div className="mt-3 flex items-center justify-center gap-2">
          <button
            type="button"
            onClick={onPrevTip}
            disabled={carouselIndex === 0}
            aria-label="Previous tip"
            data-slot="tip-card-prev"
            className={carouselButtonClassName}
          >
            <ChevronLeft
              className="h-3.5 w-3.5"
              strokeWidth={2}
              aria-hidden="true"
            />
          </button>
          <TipCarouselDots index={carouselIndex} count={carouselCount} />
          <button
            type="button"
            onClick={onNextTip}
            aria-label="Next tip"
            data-slot="tip-card-next"
            className={carouselButtonClassName}
          >
            <ChevronRight
              className="h-3.5 w-3.5"
              strokeWidth={2}
              aria-hidden="true"
            />
          </button>
        </div>
      ) : null}
    </div>
  );
}
