
import { useEffect, useState } from "react";

/**
 * Cycles through an array of hint strings on a fixed interval.
 * Returns the current hint text.
 *
 * @param hints   - Array of hint strings to rotate through.
 * @param intervalMs - Milliseconds between rotations.
 */
export function useHintRotation(hints: readonly string[], intervalMs: number): string {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setIndex((i) => (i + 1) % hints.length);
    }, intervalMs);
    return () => clearInterval(timer);
  }, [hints.length, intervalMs]);

  return hints[index] ?? hints[0] ?? "";
}
