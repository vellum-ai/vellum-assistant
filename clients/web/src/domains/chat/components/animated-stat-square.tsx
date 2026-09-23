import { type ReactNode, useEffect, useRef, useState } from "react";
import { useReducedMotion } from "motion/react";

import { StatSquare } from "@vellumai/design-library/components/stat-square";

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
 * A `StatSquare` whose value counts toward `target` as it changes.
 *
 * The animation is the only thing this adds: a token count climbing while a
 * run streams reads as the run doing something, where a number replaced
 * outright does not. Everything a person sees of the tile itself is the
 * design library's.
 */
export function AnimatedStatSquare({
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
  return <StatSquare icon={icon} label={label} value={format(animated)} />;
}
