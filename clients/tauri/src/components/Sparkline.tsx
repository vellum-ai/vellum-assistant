import type { JSX } from "react";
import { useEffect, useRef, useState } from "react";

interface SparklineProps {
  /** Latest sampled value, normalized 0..1. */
  readonly value: number;
  /** Number of historical samples to retain. */
  readonly samples?: number;
  /** Sample interval in ms. */
  readonly intervalMs?: number;
  /** Optional CSS class to swap accent (e.g. `warn-bar`). */
  readonly variant?: "accent" | "warn" | "violet";
}

/**
 * Rolling sparkline. Pushes the live `value` into a fixed-length ring
 * buffer every `intervalMs` ms and renders the result as a fixed-width
 * bar histogram. Used for mic amplitude history, latency, and a synthetic
 * "system load" indicator.
 */
export function Sparkline({
  value,
  samples = 36,
  intervalMs = 180,
  variant = "accent",
}: SparklineProps): JSX.Element {
  const [series, setSeries] = useState<number[]>(() =>
    new Array(samples).fill(0),
  );
  const ref = useRef(value);
  ref.current = value;

  useEffect(() => {
    const id = setInterval(() => {
      setSeries((prev) => {
        const next = prev.slice(1);
        next.push(Math.max(0, Math.min(1, ref.current)));
        return next;
      });
    }, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  const tint =
    variant === "warn"
      ? "rgba(255, 159, 85, 0.85)"
      : variant === "violet"
        ? "rgba(156, 138, 255, 0.85)"
        : "rgba(95, 222, 255, 0.85)";

  return (
    <div className="sparkline" aria-hidden>
      {series.map((v, i) => (
        <span
          key={i}
          style={{
            height: `${Math.max(2, v * 100)}%`,
            background: tint,
            boxShadow: `0 0 4px ${tint}`,
          }}
        />
      ))}
    </div>
  );
}
