
import { type ReactNode, useEffect, useRef, useState } from "react";

import { Typography } from "@vellumai/design-library";

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

export function useAnimatedNumber(target: number): number {
  const [displayed, setDisplayed] = useState(target);
  const rafRef = useRef<number>(0);
  const displayedRef = useRef(target);

  useEffect(() => {
    const from = displayedRef.current;
    if (from === target) return;

    cancelAnimationFrame(rafRef.current);
    const start = performance.now();

    const step = (now: number) => {
      const elapsed = now - start;
      const progress = Math.min(elapsed / ANIMATION_DURATION_MS, 1);
      const eased = 1 - (1 - progress) ** 3;
      const value = from + (target - from) * eased;
      displayedRef.current = value;
      setDisplayed(value);
      if (progress < 1) {
        rafRef.current = requestAnimationFrame(step);
      }
    };
    rafRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafRef.current);
  }, [target]);

  return displayed;
}

export function MetricCard({
  icon,
  value,
  label,
}: {
  icon: ReactNode;
  value: string;
  label: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-[var(--border-base)] bg-[var(--surface-overlay)] px-3 py-3">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--surface-base)]">
        {icon}
      </div>
      <div className="min-w-0">
        <Typography
          variant="title-small"
          className="block text-[var(--content-default)]"
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
    </div>
  );
}

export function AnimatedMetricCard({ icon, label, target, format }: {
  icon: ReactNode; label: string; target: number; format: (n: number) => string;
}) {
  const animated = useAnimatedNumber(target);
  return (
    <MetricCard
      icon={icon}
      label={label}
      value={format(animated)}
    />
  );
}
