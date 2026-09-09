import { type ReactNode, useEffect, useRef, useState } from "react";
import { useReducedMotion } from "motion/react";

import { cn, Typography } from "@vellumai/design-library";

/** Format a number compactly (e.g. 257400 -> "257.4K"). */
export function formatNumber(n: number): string {
  if (n >= 1_000_000) {
    const val = n / 1_000_000;
    return `${val % 1 === 0 ? val.toFixed(0) : val.toFixed(1)}M`;
  }
  if (n >= 1_000) {
    const val = n / 1_000;
    return `${val % 1 === 0 ? val.toFixed(0) : val.toFixed(1)}K`;
  }
  return n.toLocaleString();
}

export const ANIMATION_DURATION_MS = 300;

/**
 * Eases a displayed number toward `target`. A single rAF loop tracks a moving
 * target: when `target` changes mid-flight (frequent during streaming) we just
 * update the goal rather than cancelling and restarting a fresh tween on every
 * update, so the metric counters never spawn overlapping rAF loops. The loop
 * self-terminates once it catches up, and snaps instantly when the user prefers
 * reduced motion.
 */
export function useAnimatedNumber(target: number): number {
  const reduceMotion = useReducedMotion();
  const [displayed, setDisplayed] = useState(target);
  const displayedRef = useRef(target);
  const targetRef = useRef(target);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    targetRef.current = target;

    if (reduceMotion) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      displayedRef.current = target;
      setDisplayed(target);
      return;
    }

    // Already at the target, or a loop is already running toward the
    // (just-updated) target — nothing new to start.
    if (displayedRef.current === target || rafRef.current) {
      return;
    }

    const startTime = performance.now();
    const startValue = displayedRef.current;

    const step = (now: number) => {
      // Re-read the goal each frame so a target that changed mid-tween is
      // tracked without restarting the animation.
      const goal = targetRef.current;
      const progress = Math.min((now - startTime) / ANIMATION_DURATION_MS, 1);
      const eased = 1 - (1 - progress) ** 3;
      displayedRef.current =
        progress >= 1 ? goal : startValue + (goal - startValue) * eased;
      setDisplayed(displayedRef.current);
      if (progress < 1) {
        rafRef.current = requestAnimationFrame(step);
      } else {
        rafRef.current = 0;
      }
    };
    rafRef.current = requestAnimationFrame(step);
  }, [target, reduceMotion]);

  // Cancel any in-flight frame on unmount.
  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  return displayed;
}

/**
 * Card chrome for a metric tile. Exported because {@link MetricCard} is a div
 * with no ref, so a tile that has to be an interactive element wears the same
 * box on its own button rather than a copy of these classes.
 */
export const METRIC_CARD_CLASS =
  "flex items-center gap-3 rounded-lg border border-[var(--border-base)] bg-[var(--surface-overlay)] px-3 py-3";

interface MetricCardContentProps {
  icon: ReactNode;
  value: string;
  label: string;
  /** Extra classes on the value row, e.g. `font-mono` for a model name. */
  valueClassName?: string;
}

/**
 * The icon well and value/label stack inside {@link METRIC_CARD_CLASS}. A
 * fragment so the parent's flex row owns the children directly and a caller
 * can add its own trailing affordance beside them.
 */
export function MetricCardContent({
  icon,
  value,
  label,
  valueClassName,
}: MetricCardContentProps) {
  return (
    <>
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--surface-base)]">
        {icon}
      </div>
      <div className="min-w-0">
        <Typography
          variant="title-small"
          className={cn("block text-[var(--content-default)]", valueClassName)}
        >
          {value}
        </Typography>
        <Typography
          variant="body-small-default"
          className="block text-[var(--content-secondary)]"
        >
          {label}
        </Typography>
      </div>
    </>
  );
}

export function MetricCard(props: MetricCardContentProps) {
  return (
    <div className={METRIC_CARD_CLASS}>
      <MetricCardContent {...props} />
    </div>
  );
}

export function AnimatedMetricCard({
  icon,
  label,
  target,
  format,
}: {
  icon: ReactNode;
  label: string;
  target: number;
  format: (n: number) => string;
}) {
  const animated = useAnimatedNumber(target);
  return <MetricCard icon={icon} label={label} value={format(animated)} />;
}
