import { useEffect, useRef, useState } from "react";

/**
 * Holds a value on screen for at least `minMs` before letting the next one
 * through. When several changes land inside one hold, the intermediate values
 * are skipped entirely — a phase nobody could have read is never rendered.
 *
 * `minMs <= 0` disables the hold and passes the value straight through, which
 * keeps tests synchronous.
 */
export function useHeldPhase<T>(value: T, minMs: number): T {
  const [held, setHeld] = useState(value);
  const shownAt = useRef(0);

  // The first value is whatever mounted, so start its window at mount rather
  // than at epoch zero — otherwise the opening phase is free to leave instantly.
  useEffect(() => {
    shownAt.current = performance.now();
  }, []);

  useEffect(() => {
    if (minMs <= 0 || value === held) {
      return;
    }
    const wait = minMs - (performance.now() - shownAt.current);
    if (wait <= 0) {
      shownAt.current = performance.now();
      setHeld(value);
      return;
    }
    const timer = setTimeout(() => {
      shownAt.current = performance.now();
      setHeld(value);
    }, wait);
    return () => clearTimeout(timer);
  }, [value, held, minMs]);

  return minMs <= 0 ? value : held;
}
