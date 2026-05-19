import type { JSX } from "react";
import { useEffect, useRef, useState } from "react";

interface TickerCounterProps {
  readonly value: number;
  readonly unit?: string;
  readonly digits?: number;
  /** Optional ms to ease the displayed number toward the target. */
  readonly easeMs?: number;
}

/**
 * Animated counter that smoothly eases toward the target `value`. Used
 * for "frames sent", "tokens received", and other monotonically-rising
 * stats that should never appear to snap.
 */
export function TickerCounter({
  value,
  unit,
  digits = 5,
  easeMs = 380,
}: TickerCounterProps): JSX.Element {
  const [display, setDisplay] = useState(value);
  const fromRef = useRef(value);
  const toRef = useRef(value);
  const startedAtRef = useRef(performance.now());

  useEffect(() => {
    fromRef.current = display;
    toRef.current = value;
    startedAtRef.current = performance.now();
    // We intentionally do not depend on `display` so we don't restart
    // the easing every animation frame — only when `value` actually
    // changes do we capture the latest displayed number and re-aim.
  }, [value]);

  useEffect(() => {
    let alive = true;
    const tick = (now: number) => {
      if (!alive) return;
      const elapsed = now - startedAtRef.current;
      const t = Math.max(0, Math.min(1, elapsed / easeMs));
      const eased = 1 - Math.pow(1 - t, 3);
      const next = fromRef.current + (toRef.current - fromRef.current) * eased;
      setDisplay(Math.round(next));
      if (t < 1) requestAnimationFrame(tick);
    };
    const handle = requestAnimationFrame(tick);
    return () => {
      alive = false;
      cancelAnimationFrame(handle);
    };
  }, [easeMs, value]);

  const padded = String(Math.max(0, Math.floor(display))).padStart(digits, "0");

  return (
    <span className="ticker ticker-glow text-hud-accent">
      {padded}
      {unit ? <span className="ml-1 text-[10px] text-hud-mute">{unit}</span> : null}
    </span>
  );
}
